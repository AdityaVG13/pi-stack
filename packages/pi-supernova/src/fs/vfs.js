import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { randomUUID } from "node:crypto";

const VFS_CACHE_MAX = 1024;

// Serialize validation + replacement across Supernova transactions in this host.
let commitTail = Promise.resolve();

export class CausalVfs {
  constructor(onNewFile, validateWrite) {
    this.validateWrite = validateWrite;
    // Last-seen original bytes for write CAS, not a read cache. read() always
    // hits disk unless an overlay is staged. Serving cache on read would be a
    // false-valid against editors/git between two reads.
    this.cache = new Map();
    this.overlays = [];
    this.expected = new Map();
    this.onNewFile = onNewFile;
    this.closed = false;
    this.signal = undefined;
    this.mutations = { committed: 0, rolledBack: 0, external: 0, pendingCommits: 0, recoveryFailed: false };
  }

  assertWritable() {
    if (this.closed) throw new Error("program is already complete");
    this.signal?.throwIfAborted();
  }

  setCache(target, content) {
    if (this.cache.size >= VFS_CACHE_MAX && !this.cache.has(target)) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(target, content);
  }

  getOverlay(target) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      if (this.overlays[i].has(target)) return this.overlays[i].get(target);
    }
  }

  getOverlayPaths() {
    return [...new Set(this.overlays.flatMap(overlay => [...overlay.keys()]))];
  }

  async read(target, { preserveRead = false, maxBytes } = {}) {
    const overlay = this.getOverlay(target);

    if (overlay !== undefined) {
      if (maxBytes !== undefined && Buffer.byteLength(overlay, "utf8") > maxBytes) throw new Error("JSON input exceeds " + maxBytes + " bytes; use a streaming parser through bash");

      return overlay;
    }

    // External editors and captured tools can change a file between any two reads.
    try {
      let text;

      if (maxBytes === undefined) text = await fs.readFile(target, "utf8");
      else {
        const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

        try {
          const stat = await file.stat();

          if (!stat.isFile()) throw new Error("JSON read requires a regular file: " + target);
          const tooLarge = () => new Error("JSON input exceeds " + maxBytes + " bytes; use a streaming parser through bash");

          if (stat.size > maxBytes) throw tooLarge();
          const chunks = [];
          let size = 0;

          for await (const chunk of file.createReadStream({ end: maxBytes, autoClose: false, signal: this.signal })) {
            size += chunk.length;

            if (size > maxBytes) throw tooLarge();
            chunks.push(chunk);
          }

          text = Buffer.concat(chunks).toString("utf8");
        } finally { await file.close(); }
      }

      if (!preserveRead || !this.cache.has(target)) this.setCache(target, text);

      return text;
    } catch (err) {
      this.cache.delete(target);

      if (err.code === "EISDIR") throw new Error("read path is a directory, not a file: " + target);

      if (err.code === "ENOENT") {
        const missing = new Error("no such file: " + target + ' (locate it with read using a directory path or source question)');
        missing.code = "ENOENT";
        throw missing;
      }

      throw err;
    }
  }

  async write(target, content) {
    this.assertWritable();

    if (!isString(content)) throw new Error("write requires string content");

    try {
      if ((await fs.stat(target)).isDirectory()) throw new Error("cannot write to a directory: " + target);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    this.assertWritable();

    if (this.getOverlay(target) === undefined) {
      let original;

      try { original = this.cache.has(target) ? this.cache.get(target) : await fs.readFile(target, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; original = null; }

      this.expected.set(target, original);
    }

    this.assertWritable();

    if (this.overlays.length) {
      this.overlays.at(-1).set(target, content);

      return { speculative: true };
    }

    await this.flush(new Map([[target, content]]));

    return { speculative: false };
  }

  begin() {
    this.assertWritable();
    this.overlays.push(new Map());

    return this.overlays.length;
  }

  /** Stage every file and its backup before replacing any destination. */
  async flush(writes) {
    this.mutations.pendingCommits++;
    const work = commitTail.then(() => this.flushWrites(writes)).finally(() => { this.mutations.pendingCommits--; });
    commitTail = work.catch(() => {});

    return work;
  }

  async flushWrites(writes) {
    const staged = [];
    const targets = new Set();
    const createdDirs = [];
    let failed = false;

    try {
      for (const [logicalPath, content] of writes) {
        this.signal?.throwIfAborted();
        let target = logicalPath;
        let stat;

        try {
          target = await fs.realpath(logicalPath);
          stat = await fs.stat(target);

          if (!stat.isFile()) throw new Error("cannot write to a non-file: " + logicalPath);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }

        await this.validateWrite?.(logicalPath);

        if (targets.has(target)) throw new Error("conflicting write aliases: " + logicalPath);
        targets.add(target);

        if (this.expected.has(logicalPath)) {
          const current = stat ? await fs.readFile(target, "utf8") : null;

          if (current !== this.expected.get(logicalPath)) {
            throw new Error("write conflict: file changed since it was read: " + logicalPath + "; read it again before retrying");
          }
        }

        const parent = path.dirname(target);
        const missing = [];
        let probe = parent;

        for (;;) {
          try { await fs.stat(probe); break; } catch (err) {
            if (err.code !== "ENOENT") throw err;
            missing.push(probe);
            probe = path.dirname(probe);
          }
        }

        await fs.mkdir(parent, { recursive: true });
        createdDirs.push(...missing.reverse());
        const token = ".supernova-" + randomUUID();
        const entry = { logicalPath, target, content, temporary: path.join(parent, token + ".new"), backup: path.join(parent, token + ".bak"), existed: !!stat, replaced: false };
        staged.push(entry);

        const replacement = (async () => {
          await fs.writeFile(entry.temporary, content, { encoding: "utf8", flag: "wx", mode: stat ? stat.mode & 0o7777 : 0o666 });

          if (stat) await fs.chmod(entry.temporary, stat.mode & 0o7777);
        })();

        // These touch separate staging files. Settle both before cleanup, even
        // on failure: Promise.all could leave a late backup after rollback.
        const staging = [replacement];

        if (stat) staging.push(fs.copyFile(target, entry.backup, fs.constants.COPYFILE_EXCL));
        const outcomes = await Promise.allSettled(staging);
        const failure = outcomes.find(outcome => outcome.status === "rejected");

        if (failure) throw failure.reason;
      }

      for (const entry of staged) {
        this.signal?.throwIfAborted();
        await fs.rename(entry.temporary, entry.target);
        entry.replaced = true;
      }

      for (const entry of staged) {
        this.setCache(entry.logicalPath, entry.content);
        this.expected.delete(entry.logicalPath);
      }

      if (staged.length) this.onNewFile?.(staged.map(entry => entry.target));
      this.mutations.committed += staged.length;
    } catch (error) {
      failed = true;
      const recoveryErrors = [];

      for (const entry of staged.toReversed()) {
        if (!entry.replaced) continue;

        try {
          if (entry.existed) await fs.rename(entry.backup, entry.target);
          else await fs.unlink(entry.target);
        } catch (err) {
          // Keep the backup if recovery fails; never delete the remaining original.
          entry.keepBackup = true;
          recoveryErrors.push(entry.target + ": " + err.message + " (backup: " + entry.backup + ")");
        }
      }

      this.invalidateCache();

      if (recoveryErrors.length) this.mutations.recoveryFailed = true;

      if (recoveryErrors.length) this.onNewFile?.(null);

      if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors.map(message => new Error(message))], "commit failed: " + error.message + "; recovery failed: " + recoveryErrors.join("; "));
      throw error;
    } finally {
      for (const entry of staged) {
        // A successful rename consumed the temporary path. These are known
        // files, so unlink avoids rm's extra type probe; missing files stay benign.
        if (!entry.replaced) await fs.unlink(entry.temporary).catch(() => {});

        if (entry.existed && !entry.keepBackup) await fs.unlink(entry.backup).catch(() => {});
      }

      if (failed) for (const dir of createdDirs.toReversed()) await fs.rmdir(dir).catch(() => {});
    }
  }

  async commit() {
    if (!this.overlays.length) return { committed: 0, depth: 0 };
    const top = this.overlays.at(-1);

    if (this.overlays.length > 1) {
      const parent = this.overlays[this.overlays.length - 2];

      for (const [key, value] of top) parent.set(key, value);
    } else {
      await this.flush(top);
    }

    this.overlays.pop();

    return { committed: top.size, depth: this.overlays.length };
  }

  rollback() {
    const top = this.overlays.pop();
    this.mutations.rolledBack += top?.size ?? 0;

    for (const target of top?.keys() ?? []) {
      if (this.getOverlay(target) === undefined) this.expected.delete(target);
    }

    return { rolledBack: top?.size ?? 0, depth: this.overlays.length };
  }

  async prepareExternalMutation(name) {
    this.assertWritable();

    if (this.overlays.length > 1) throw new Error(name + " cannot run inside an edit checkpoint because external mutations cannot be rolled back");

    if (!this.overlays.length) { this.mutations.external++;

 return false; }

    const pending = this.overlays[0];
    await this.flush(pending);
    this.assertWritable();
    this.overlays[0] = new Map();
    this.mutations.external++;

    return pending.size > 0;
  }

  invalidateCache() { this.cache.clear(); }
  getCacheSize() { return this.cache.size; }
  getOverlayDepth() { return this.overlays.length; }
}
