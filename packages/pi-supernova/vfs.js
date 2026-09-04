import * as fs from "node:fs/promises";
import * as path from "node:path";

const VFS_CACHE_MAX = 1024;

export class CausalVfs {
  constructor(onNewFile) {
    this.cache = new Map();
    this.overlays = [];
    this.onNewFile = onNewFile;
  }

  setCache(target, content) {
    if (this.cache.size >= VFS_CACHE_MAX && !this.cache.has(target)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(target, content);
  }

  getOverlay(target) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      if (this.overlays[i].has(target)) return this.overlays[i].get(target);
    }
    return undefined;
  }

  getOverlayPaths() {
    const paths = new Set();
    for (const overlay of this.overlays) {
      for (const target of overlay.keys()) paths.add(target);
    }
    return [...paths];
  }

  async read(target) {
    const overlay = this.getOverlay(target);
    if (overlay !== undefined) return overlay;

    const cached = this.cache.get(target);
    if (cached !== undefined) return cached;

    try {
      const text = await fs.readFile(target, "utf8");
      this.setCache(target, text);
      return text;
    } catch (err) {
      if (err.code === "EISDIR") {
        throw new Error(`read path is a directory, not a file: ${target}`);
      }
      if (err.code === "ENOENT") {
        const missing = new Error(`no such file: ${target} (locate it with nova.call("glob", {pattern}) or snap(query))`);
        missing.code = "ENOENT";
        throw missing;
      }
      throw err;
    }
  }

  async write(target, content) {
    if (this.overlays.length > 0) {
      this.overlays[this.overlays.length - 1].set(target, content);
      return { speculative: true };
    }

    let existed = true;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        throw new Error(`cannot write to a directory: ${target}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      existed = false;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    this.setCache(target, content);
    if (!existed) this.onNewFile?.(target);
    return { speculative: false };
  }

  begin() {
    this.overlays.push(new Map());
    return this.overlays.length;
  }

  async commit() {
    if (this.overlays.length === 0) return { committed: 0, depth: 0 };
    const top = this.overlays.pop();
    if (this.overlays.length > 0) {
      const parent = this.overlays[this.overlays.length - 1];
      for (const [k, v] of top.entries()) parent.set(k, v);
      return { committed: top.size, depth: this.overlays.length };
    }
    for (const [filePath, fileContent] of top.entries()) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fileContent, "utf8");
      this.setCache(filePath, fileContent);
    }
    if (top.size > 0) this.onNewFile?.();
    return { committed: top.size, depth: 0 };
  }

  rollback() {
    if (this.overlays.length === 0) return { rolledBack: 0, depth: 0 };
    const top = this.overlays.pop();
    return { rolledBack: top.size, depth: this.overlays.length };
  }

  async prepareExternalMutation(name) {
    if (this.overlays.length > 1) {
      throw new Error(`${name} cannot run inside nova.speculate because external mutations cannot be rolled back`);
    }
    if (this.overlays.length === 0) return false;
    const pending = this.overlays[0];
    for (const [filePath, fileContent] of pending.entries()) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fileContent, "utf8");
      this.setCache(filePath, fileContent);
    }
    if (pending.size > 0) this.onNewFile?.();
    this.overlays[0] = new Map();
    return pending.size > 0;
  }

  invalidateCache() {
    this.cache.clear();
  }

  clear() {
    this.invalidateCache();
    this.overlays.length = 0;
  }

  getCacheSize() {
    return this.cache.size;
  }

  getOverlayDepth() {
    return this.overlays.length;
  }
}
