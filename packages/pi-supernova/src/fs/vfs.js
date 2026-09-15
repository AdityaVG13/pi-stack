import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { createHash, randomUUID } from "node:crypto";

const VFS_CACHE_MAX = 1024;

const VFS_CACHE_MAX_BYTES = 64 * 1024 * 1024;

// Serialize validation + replacement across Supernova transactions in this host.
let commitTail = Promise.resolve();

function textSignature(text) {
  return { size: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function sameFileVersion(a, b) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
}

async function fileSignature(target, signal, observed) {
  const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    const actual = await file.stat();

    if (!actual.isFile()) throw new Error("read requires a regular file: " + target);
    if (observed && !sameFileVersion(observed, actual)) throw new Error("file changed while reading: " + target);
    const hash = createHash("sha256");

    for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    const after = await file.stat();

    if (!after.isFile() || !sameFileVersion(actual, after)) throw new Error("file changed while signing: " + target);

    return { size: actual.size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

// realpath() cannot resolve a missing leaf. Canonicalize its nearest existing
// ancestor so two symlink spellings still share one commit destination.
async function canonicalNewPath(target) {
  let ancestor = path.dirname(target);

  for (;;) {
    try { return path.join(await fs.realpath(ancestor), path.relative(ancestor, target)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);

      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function sameSignature(a, b) {
  return a === b || (a !== null && b !== null && a.size === b.size && a.sha256 === b.sha256);
}

export class CausalVfs {
  constructor(onNewFile, validateWrite) {
    this.validateWrite = validateWrite;
    // Optional receipt bodies, never the authority for CAS. Signatures survive
    // body eviction. Explicit reads hit disk and replace the observed snapshot;
    // internal receipt reads preserve it until an external-mutation boundary.
    this.cache = new Map();
    this.cacheBytes = 0;
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

  dropCache(target) {
    const previous = this.cache.get(target);

    if (previous !== undefined && this.cache.delete(target)) this.cacheBytes -= Buffer.byteLength(previous, "utf8");
  }

  setCache(target, content) {
    const bytes = Buffer.byteLength(content, "utf8");

    if (bytes > VFS_CACHE_MAX_BYTES) {
      this.dropCache(target);
      return;
    }

    this.dropCache(target);

    while ((this.cache.size >= VFS_CACHE_MAX || this.cacheBytes + bytes > VFS_CACHE_MAX_BYTES) && this.cache.size) {
      const oldest = this.cache.keys().next().value;

      this.cacheBytes -= Buffer.byteLength(this.cache.get(oldest), "utf8");
      this.cache.delete(oldest);
    }

    this.cache.set(target, content);
    this.cacheBytes += bytes;
  }

  getOverlay(target) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      if (this.overlays[i].has(target)) return this.overlays[i].get(target);
    }
  }

  getOverlayPaths() {
    return [...new Set(this.overlays.flatMap(overlay => [...overlay.keys()]))];
  }

  async read(target, { preserveRead = false, maxBytes, label = "read input" } = {}) {
    const overlay = this.getOverlay(target);

    if (overlay !== undefined) {
      if (maxBytes !== undefined && Buffer.byteLength(overlay, "utf8") > maxBytes) throw new Error(label + " exceeds " + maxBytes + " bytes; use a streaming parser through bash");

      return overlay;
    }

    // External editors and captured tools can change a file between any two reads.
    // Open once with O_NONBLOCK so a FIFO or device cannot park a host I/O worker.
    try {
      const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      let bytes;

      try {
        const stat = await file.stat();

        if (stat.isDirectory()) throw new Error("read path is a directory, not a file: " + target);
        if (!stat.isFile()) throw new Error("read requires a regular file: " + target);

        if (maxBytes === undefined) bytes = await file.readFile({ signal: this.signal });
        else {
          const tooLarge = () => new Error(label + " exceeds " + maxBytes + " bytes; use a streaming parser through bash");

          if (stat.size > maxBytes) throw tooLarge();
          const chunks = [];
          let size = 0;

          for await (const chunk of file.createReadStream({ end: maxBytes, autoClose: false, signal: this.signal })) {
            size += chunk.length;

            if (size > maxBytes) throw tooLarge();
            chunks.push(chunk);
          }

          bytes = Buffer.concat(chunks);
        }
        if (!sameFileVersion(stat, await file.stat())) throw new Error("file changed while reading: " + target);
      } finally { await file.close(); }

      // Hash the actual bytes, not a lossy UTF-8 decode/re-encode.
      if (!preserveRead || !this.expected.has(target)) this.expected.set(target, textSignature(bytes));
      const text = bytes.toString("utf8");
      this.setCache(target, text);

      return text;
    } catch (err) {
      this.dropCache(target);

      if (err.code === "EISDIR") throw new Error("read path is a directory, not a file: " + target);

      if (err.code === "ENOENT") {
        const missing = new Error("no such file: " + target + ' (locate it with read using a directory path or source question)');
        missing.code = "ENOENT";
        throw missing;
      }

      throw err;
    }
  }

  async #diskSignature(target) {
    let stat;

    try { stat = await fs.stat(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    return stat?.isFile() ? await fileSignature(target, this.signal, stat) : null;
  }

  async captureExpected(target) {
    if (this.getOverlay(target) !== undefined || this.expected.has(target)) return;

    this.expected.set(target, await this.#diskSignature(target));
  }

  async recordExpected(target, observed) {
    if (this.getOverlay(target) !== undefined) return;
    const signature = observed ? await fileSignature(target, this.signal, observed) : await this.#diskSignature(target);
    this.expected.set(target, signature);
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

    await this.captureExpected(target);

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
          target = await canonicalNewPath(logicalPath);
        }

        await this.validateWrite?.(logicalPath);

        if (targets.has(target)) throw new Error("conflicting write aliases: " + logicalPath);
        targets.add(target);

        if (this.expected.has(logicalPath)) {
          const current = stat ? await fileSignature(target, this.signal) : null;

          if (!sameSignature(current, this.expected.get(logicalPath))) {
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
        this.expected.set(entry.logicalPath, textSignature(entry.content));
      }

      // Canonical commit destinations must not rewrite established event paths
      // for newly created files, whose callers supplied a logical cwd spelling.
      if (staged.length) this.onNewFile?.(staged.map(entry => entry.existed ? entry.target : entry.logicalPath));
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

    // Rolling back staged writes does not undo observations of disk. Keep the
    // read snapshot, including for files without a surviving parent overlay.

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

  invalidateCache() { this.cache.clear(); this.cacheBytes = 0; this.expected.clear(); }
  getCacheSize() { return this.cache.size; }
  getOverlayDepth() { return this.overlays.length; }
}
