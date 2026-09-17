import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveWorkspacePath, runCommand } from "../fs/workspace.js";
import { fuzzyFind, grepIndexed, listIndexed, listWithTools, rgGrepArgs } from "../context/search.js";
import { textResult, formatDirectoryEntry } from "../fs/text-ops.js";

function rawListPattern(op, params) {
  if (op === "glob") return String(params?.pattern || "");

  return params?.pattern || params?.glob;
}

function globPatternOf(op, params) {
  const pattern = rawListPattern(op, params);

  if (op === "glob" && !pattern) throw new Error("glob requires pattern");

  return pattern ? String(pattern) : null;
}

async function resolveListDir(op, params, cwd) {
  if (op === "find" && params?.path) return resolveWorkspacePath(cwd, params.path, op, true);

  return cwd;
}

function fileListing(dirPath, size) {
  const entry = formatDirectoryEntry(path.basename(dirPath), "file", size);

  return textResult(entry, { path: dirPath, directory: false, count: 1, entries: [entry] });
}

export function createList(ctx) {
  const { getCwd, vfs, index } = ctx;

  async function listFromCache(searchDir, cwd, globPattern, pending) {
    const fuzzy = await fuzzyFind(index, searchDir, cwd, globPattern, 20, pending);

    if (fuzzy !== null) return textResult(fuzzy, { via: "fuzzy" });
    const indexed = await listIndexed(index, searchDir, cwd, globPattern, pending);

    if (indexed !== null) return textResult(indexed, { via: "index" });

    return null;
  }

  async function listFiles(params, signal, op, cwd) {
    if (signal?.aborted) throw new Error("aborted");
    const searchDir = await resolveListDir(op, params, cwd);
    const globPattern = globPatternOf(op, params);
    const pending = vfs.getOverlayPaths();
    const cached = await listFromCache(searchDir, cwd, globPattern, pending);

    if (cached !== null) return cached;

    return listWithTools(searchDir, globPattern, cwd, signal, pending);
  }

  async function grepWithRg(pattern, params, searchPath, cwd, signal) {
      const res = await runCommand(["rg", ...rgGrepArgs(pattern, params, searchPath)], { cwd, timeoutMs: 30_000, signal });

      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw new Error(res.stderr.trim() || `rg exited ${res.exitCode}`);
      }

      return textResult(res.stdout, { exitCode: res.exitCode });
  }

  async function grep(params, signal) {
      const cwd = getCwd();
      const pattern = String(params?.pattern || "");

      if (!pattern) throw new Error("grep requires pattern");
      const searchPath = params?.path ? await resolveWorkspacePath(cwd, params.path, "grep", true) : cwd;
      const indexed = await grepIndexed(index, pattern, params, searchPath, cwd, file => vfs.getOverlay(file), vfs.getOverlayPaths());

      if (indexed !== null) return textResult(indexed, { exitCode: indexed ? 0 : 1, via: "index" });
      // Large tree: real rg keeps its own output format.
      return grepWithRg(pattern, params, searchPath, cwd, signal);
  }

  async function glob(params, signal) {
    return listFiles(params, signal, "glob", getCwd());
  }
  async function find(params, signal) {
    return listFiles(params, signal, "find", getCwd());
  }
  async function ls(params, signal) {
      const cwd = getCwd();
      const dirPath = params?.path ? await resolveWorkspacePath(cwd, params.path, "ls", true) : cwd;
      const pending = vfs.getOverlay(dirPath);

      if (pending !== undefined) return fileListing(dirPath, Buffer.byteLength(pending, "utf8"));
      const stat = await fs.stat(dirPath).catch(() => null);

      if (stat?.isFile()) return fileListing(dirPath, stat.size);

      return ctx.readDirectory(dirPath, signal);
  }

  return { grep, glob, find, ls };
}
