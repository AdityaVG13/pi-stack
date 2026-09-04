import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "./decode.js";
import { randomUUID } from "node:crypto";

const VFS_CACHE_MAX = 1024;

export class CausalVfs {
  constructor(onNewFile) {
    this.cache = new Map();
    this.overlays = [];
    this.onNewFile = onNewFile;
    this.closed = false;
    this.signal = undefined;
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

  async read(target) {
    const overlay = this.getOverlay(target);
    if (overlay !== undefined) return overlay;
    // External editors and captured tools can change a file between any two reads.
    try {
      const text = await fs.readFile(target, "utf8");
      this.setCache(target, text);
      return text;
    } catch (err) {
      this.cache.delete(target);
      if (err.code === "EISDIR") throw new Error("read path is a directory, not a file: " + target);
      if (err.code === "ENOENT") {
        const missing = new Error("no such file: " + target + ' (locate it with nova.call("glob", {pattern}) or snap(query))');
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
    const staged = [];
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
        await fs.writeFile(entry.temporary, content, { encoding: "utf8", flag: "wx", mode: stat ? stat.mode & 0o7777 : 0o666 });
        if (stat) {
          await fs.chmod(entry.temporary, stat.mode & 0o7777);
          await fs.copyFile(target, entry.backup, fs.constants.COPYFILE_EXCL);
        }
      }
      for (const entry of staged) {
        this.signal?.throwIfAborted();
        await fs.rename(entry.temporary, entry.target);
        entry.replaced = true;
      }
      for (const entry of staged) this.setCache(entry.logicalPath, entry.content);
      if (staged.length) this.onNewFile?.();
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
      if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors.map(message => new Error(message))], "commit failed: " + error.message + "; recovery failed: " + recoveryErrors.join("; "));
      throw error;
    } finally {
      for (const entry of staged) {
        await fs.rm(entry.temporary, { force: true }).catch(() => {});
        if (!entry.keepBackup) await fs.rm(entry.backup, { force: true }).catch(() => {});
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
    return { rolledBack: top?.size ?? 0, depth: this.overlays.length };
  }

  async prepareExternalMutation(name) {
    this.assertWritable();
    if (this.overlays.length > 1) throw new Error(name + " cannot run inside nova.speculate because external mutations cannot be rolled back");
    if (!this.overlays.length) return false;
    const pending = this.overlays[0];
    await this.flush(pending);
    this.assertWritable();
    this.overlays[0] = new Map();
    return pending.size > 0;
  }

  invalidateCache() { this.cache.clear(); }
  getCacheSize() { return this.cache.size; }
  getOverlayDepth() { return this.overlays.length; }
}
