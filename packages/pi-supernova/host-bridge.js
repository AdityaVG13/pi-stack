
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { packageHostResult } from "./bottleneck.js";
import { isString, isNumber, isFunction } from "./decode.js";
import { isMutatingTool, runParallelWave } from "./parallel.js";
import { extractStructuralSurface } from "./surface.js";
import { buildEditDiff, buildPatchDiff, buildWriteDiff } from "./diff.js";
import { executeSnap } from "./snap.js";

function textResult(text, details) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details: details || {},
  };
}

let cachedCwd = null;
let cachedResolvedCwd = null;

function getResolvedCwd(cwd) {
  if (cwd === cachedCwd && cachedResolvedCwd) return cachedResolvedCwd;
  cachedCwd = cwd;
  cachedResolvedCwd = path.resolve(cwd);
  return cachedResolvedCwd;
}

async function resolveWorkspacePath(cwd, inputPath, opName, allowRoot = false) {
  if (inputPath == null || !isString(inputPath) || !inputPath.trim()) {
    throw new Error(`${opName} requires path`);
  }
  const resolvedCwd = getResolvedCwd(cwd);
  const target = path.resolve(resolvedCwd, inputPath.trim());
  const rel = path.relative(resolvedCwd, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${opName} path escapes workspace`);
  }
  if (!allowRoot && target === resolvedCwd) {
    throw new Error(`${opName} path cannot be the workspace root directory`);
  }

  const realRoot = await fs.realpath(resolvedCwd);
  let probe = target;
  while (true) {
    try {
      probe = await fs.realpath(probe);
      break;
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw err;
      probe = parent;
    }
  }
  const realRel = path.relative(realRoot, probe);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`${opName} path escapes workspace through symlink`);
  }
  return target;
}

async function runCommand(argv, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputChars = options.maxOutputChars ?? 2 * 1024 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputTruncated = false;
    let onAbort;

    const cleanup = () => {
      clearTimeout(timer);
      if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const append = (current, chunk) => {
      const remaining = Math.max(0, maxOutputChars - current.length);
      if (chunk.length > remaining) outputTruncated = true;
      return remaining > 0 ? current + chunk.slice(0, remaining) : current;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error(`command timed out after ${timeoutMs}ms: ${argv.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? 0, outputTruncated });
    });
    if (options.signal) {
      onAbort = () => {
        child.kill("SIGTERM");
        fail(new Error("aborted"));
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function parseHunkHeader(line) {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldLength: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newLength: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    lines: [],
  };
}

export function parsePatchHunks(patchText) {
  const patchLines = patchText.replace(/\r\n/g, "\n").split("\n");
  const hunks = [];
  let current = null;

  for (const line of patchLines) {
    const header = parseHunkHeader(line);
    if (header) {
      if (current) hunks.push(current);
      current = header;
    } else if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) {
    throw new Error("no valid patch hunks found (expected @@ -old,len +new,len @@)");
  }
  return hunks;
}

function findHunkMatch(fileLines, expectedOld, nominal) {
  const matchAt = (idx) => {
    if (idx < 0 || idx + expectedOld.length > fileLines.length) return false;
    for (let j = 0; j < expectedOld.length; j++) {
      if (fileLines[idx + j] !== expectedOld[j]) return false;
    }
    return true;
  };

  if (matchAt(nominal)) return nominal;
  const maxDelta = Math.max(fileLines.length, 100);
  for (let delta = 1; delta <= maxDelta; delta++) {
    if (matchAt(nominal + delta)) return nominal + delta;
    if (matchAt(nominal - delta)) return nominal - delta;
  }
  return -1;
}

export function applyPatchToText(originalText, patchText) {
  if (!isString(patchText) || !patchText.trim()) {
    throw new Error("apply_patch requires non-empty patch");
  }

  const hunks = parsePatchHunks(patchText);
  let fileLines = originalText.replace(/\r\n/g, "\n").split("\n");
  const hasTrailingNewline = originalText.endsWith("\n");
  let offsetShift = 0;

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const expectedOld = [];
    const newLines = [];

    for (const hLine of hunk.lines) {
      if (hLine.startsWith("-")) {
        expectedOld.push(hLine.slice(1));
      } else if (hLine.startsWith("+")) {
        newLines.push(hLine.slice(1));
      } else {
        const val = hLine.startsWith(" ") ? hLine.slice(1) : "";
        expectedOld.push(val);
        newLines.push(val);
      }
    }

    if (expectedOld.length !== hunk.oldLength || newLines.length !== hunk.newLength) {
      throw new Error(`patch hunk ${h + 1} length does not match its header`);
    }

    const nominal = Math.max(0, hunk.oldStart - 1 + offsetShift);
    const matchIdx = findHunkMatch(fileLines, expectedOld, nominal);
    if (matchIdx === -1) {
      throw new Error(`patch hunk ${h + 1} rejected at line ${hunk.oldStart}: context did not match`);
    }

    fileLines.splice(matchIdx, expectedOld.length, ...newLines);
    offsetShift += (matchIdx - nominal) + (newLines.length - expectedOld.length);
  }

  let resultText = fileLines.join("\n");
  if (hasTrailingNewline && !resultText.endsWith("\n")) resultText += "\n";
  return { resultText, hunkCount: hunks.length };
}

const VFS_CACHE_MAX = 1024;

class CausalVfs {
  constructor() {
    this.cache = new Map();
    this.overlays = [];
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
      throw err;
    }
  }

  async write(target, content) {
    if (this.overlays.length > 0) {
      this.overlays[this.overlays.length - 1].set(target, content);
      return { speculative: true };
    }

    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        throw new Error(`cannot write to a directory: ${target}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    this.setCache(target, content);
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

function createNativeAdapters(getCwd, vfs, config) {
  async function readAdapter(params, signal) {
      const cwd = getCwd();
      const targetParam = params?.path ?? params?.target;

      if (Array.isArray(targetParam)) {
        const results = await Promise.all(
          targetParam.map((p) => readAdapter({ path: p, offset: params?.offset, limit: params?.limit }, signal)),
        );
        return textResult(results.map((r) => r.value).join("\n---\n"), {
          count: results.length,
          batch: true,
          items: results.map((r) => r.value),
        });
      }

      const looksLikePath =
        isString(targetParam) &&
        (targetParam.includes("/") ||
          targetParam.includes("\\") ||
          targetParam.startsWith(".") ||
          (!/\s/.test(targetParam) && path.extname(targetParam).length > 0));

      if (looksLikePath) {
        const targetPath = await resolveWorkspacePath(cwd, targetParam, "read", false);
        let text = await vfs.read(targetPath);
        if (isNumber(params?.offset) || isNumber(params?.limit)) {
          const lines = text.split("\n");
          const offset = isNumber(params?.offset) ? Math.max(1, Math.floor(params.offset)) : 1;
          const startIndex = offset - 1;
          const limit = isNumber(params?.limit) ? Math.max(0, Math.floor(params.limit)) : lines.length;
          text = lines.slice(startIndex, startIndex + limit).join("\n");
        }
        return textResult(text, { path: targetPath });
      }

      let isExistingFile = false;
      let targetPath = await resolveWorkspacePath(cwd, targetParam, "read", false);
      const overlay = vfs.getOverlay(targetPath);
      if (overlay !== undefined || vfs.cache.has(targetPath)) {
        isExistingFile = true;
      } else {
        try {
          const st = await fs.stat(targetPath);
          isExistingFile = !st.isDirectory();
        } catch (err) {
          if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
        }
      }

      if (isExistingFile) {
        let text = await vfs.read(targetPath);
        if (isNumber(params?.offset) || isNumber(params?.limit)) {
          const lines = text.split("\n");
          const offset = isNumber(params?.offset) ? Math.max(1, Math.floor(params.offset)) : 1;
          const startIndex = offset - 1;
          const limit = isNumber(params?.limit) ? Math.max(0, Math.floor(params.limit)) : lines.length;
          text = lines.slice(startIndex, startIndex + limit).join("\n");
        }
        return textResult(text, { path: targetPath });
      }

      if (isString(targetParam) && targetParam.trim()) {
        try {
          const snapRes = await executeSnap({
            query: targetParam,
            searchDir: cwd,
            vfs,
            runCommand: (argv, opts) => runCommand(argv, { cwd, signal, ...opts }),
          });
          return textResult(JSON.stringify(snapRes, null, 2), { ...snapRes, isSnap: true });
        } catch {}
      }

      targetPath = await resolveWorkspacePath(cwd, targetParam, "read", false);

      let text = await vfs.read(targetPath);
      if (isNumber(params?.offset) || isNumber(params?.limit)) {
        const lines = text.split("\n");
        const offset = isNumber(params?.offset) ? Math.max(1, Math.floor(params.offset)) : 1;
        const startIndex = offset - 1;
        const limit = isNumber(params?.limit) ? Math.max(0, Math.floor(params.limit)) : lines.length;
        text = lines.slice(startIndex, startIndex + limit).join("\n");
      }
      return textResult(text, { path: targetPath });
  }

  return {
    read: readAdapter,
    async write(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "write", false);
      if (signal?.aborted) throw new Error("aborted");
      const content = String(params?.content ?? "");
      let prevText = "";
      try {
        prevText = await vfs.read(target);
      } catch {}
      const { speculative } = await vfs.write(target, content);
      const diff = buildWriteDiff(target, prevText, content);
      const tag = speculative ? " (speculative)" : "";
      return textResult(`wrote ${target}${tag}`, { path: target, speculative, diff });
    },
    async edit(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "edit", false);
      if (signal?.aborted) throw new Error("aborted");

      const isPatchMode =
        isString(params?.patch) ||
        (params?.newText === undefined && isString(params?.oldText) && (params.oldText.includes("@@ -") || params.oldText.startsWith("---")));

      if (isPatchMode) {
        const patchContent = params.patch || params.oldText;
        const original = await vfs.read(target);
        const { resultText, hunkCount } = applyPatchToText(original, patchContent);
        const { speculative } = await vfs.write(target, resultText);
        const diff = buildPatchDiff(target, patchContent);
        const tag = speculative ? " (speculative)" : "";
        return textResult(`applied ${hunkCount} hunk(s) to ${target}${tag}`, {
          path: target,
          hunks: hunkCount,
          speculative,
          diff,
        });
      }

      const requestedEdits = Array.isArray(params?.edits)
        ? params.edits
        : [{ oldText: params?.oldText, newText: params?.newText }];
      if (requestedEdits.length === 0) throw new Error("edit requires at least one replacement");

      const content = await vfs.read(target);
      const matches = requestedEdits.map((replacement) => {
        if (!isString(replacement?.oldText) || replacement.oldText.length === 0) {
          throw new Error("edit requires non-empty oldText");
        }
        if (!isString(replacement?.newText)) throw new Error("edit requires newText");
        const index = content.indexOf(replacement.oldText);
        if (index < 0) throw new Error(`edit target not found in ${target}`);
        if (content.indexOf(replacement.oldText, index + replacement.oldText.length) >= 0) {
          throw new Error(`edit target is not unique in ${target}`);
        }
        return { ...replacement, index, end: index + replacement.oldText.length };
      });
      matches.sort((a, b) => a.index - b.index);
      for (let i = 1; i < matches.length; i++) {
        if (matches[i].index < matches[i - 1].end) throw new Error(`edit targets overlap in ${target}`);
      }

      let updated = content;
      for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        updated = updated.slice(0, match.index) + match.newText + updated.slice(match.end);
      }
      const { speculative } = await vfs.write(target, updated);
      const diff =
        matches.length === 1
          ? buildEditDiff(target, content, matches[0].oldText, matches[0].newText)
          : { ...buildWriteDiff(target, content, updated), op: "edit" };
      const tag = speculative ? " (speculative)" : "";
      return textResult(`edited ${target}${tag}`, { path: target, speculative, diff });
    },
    async apply_patch(params, signal) {
      const cwd = getCwd();
      let inputPath = params?.path;
      if (!inputPath && isString(params?.patch)) {
        const headerMatch = /^\+\+\+\s+[ab]\/(.+)$/m.exec(params.patch) || /^---\s+[ab]\/(.+)$/m.exec(params.patch);
        if (headerMatch) inputPath = headerMatch[1].trim();
      }
      const target = await resolveWorkspacePath(cwd, inputPath, "apply_patch", false);
      if (!isString(params?.patch) || !params.patch.trim()) {
        throw new Error("apply_patch requires patch");
      }
      if (signal?.aborted) throw new Error("aborted");

      const original = await vfs.read(target);
      const { resultText, hunkCount } = applyPatchToText(original, params.patch);
      const { speculative } = await vfs.write(target, resultText);
      const diff = buildPatchDiff(target, params.patch);
      const tag = speculative ? " (speculative)" : "";
      return textResult(`applied ${hunkCount} hunk(s) to ${target}${tag}`, {
        path: target,
        hunks: hunkCount,
        speculative,
        diff,
      });
    },
    async snap(params, signal) {
      const cwd = getCwd();
      if (!isString(params?.query) || !params.query.trim()) {
        throw new Error("snap requires query");
      }
      if (signal?.aborted) throw new Error("aborted");
      const snapTarget = params?.path ? await resolveWorkspacePath(cwd, params.path, "snap", true) : cwd;
      const res = await executeSnap({
        query: params.query,
        searchDir: snapTarget,
        vfs: {
          read: async (candidate) => {
            // Jail each snap candidate (symlink files must not escape the workspace).
            const jailed = await resolveWorkspacePath(cwd, candidate, "snap", false);
            return vfs.read(jailed);
          },
        },
        runCommand: (argv, opts) => runCommand(argv, { cwd: snapTarget, signal, ...opts }),
        pendingPaths: vfs.getOverlayPaths(),
      });
      return textResult(JSON.stringify(res, null, 2), res);
    },
    async surface(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "surface", false);
      if (signal?.aborted) throw new Error("aborted");
      const text = await vfs.read(target);
      const ext = path.extname(target);
      const outline = extractStructuralSurface(text, ext);
      return textResult(JSON.stringify(outline, null, 2), { path: target, count: outline.items.length });
    },
    async bash(params, signal) {
      const cwd = getCwd();
      const command = String(params?.command ?? "").trim();
      if (!command) throw new Error("bash requires command");
      const targetCwd = params?.cwd ? await resolveWorkspacePath(cwd, params.cwd, "bash cwd", true) : cwd;

      const hasShellMeta = /[|><&;*$()'"]/.test(command) || command.includes("`");
      const argv = hasShellMeta ? ["bash", "-c", command] : command.split(/\s+/);

      const transactionBarrier = await vfs.prepareExternalMutation("bash");
      let res;
      try {
        res = await runCommand(argv, {
          cwd: targetCwd,
          timeoutMs: params?.timeoutMs,
          signal,
          maxOutputChars: config.maxCallResultChars,
        });
      } finally {
        vfs.invalidateCache();
      }
      const text = [res.stdout, res.stderr].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { exitCode: res.exitCode, outputTruncated: res.outputTruncated, transactionBarrier },
        isError: res.exitCode !== 0,
      };
    },
    async grep(params, signal) {
      const cwd = getCwd();
      const pattern = String(params?.pattern || "");
      if (!pattern) throw new Error("grep requires pattern");
      const searchPath = params?.path ? await resolveWorkspacePath(cwd, params.path, "grep", true) : cwd;
      const args = ["--line-number", "--no-heading", "--color", "never"];
      if (params?.caseSensitive !== true) args.push("--ignore-case");
      if (params?.glob) args.push("--glob", String(params.glob));
      args.push("--", pattern, searchPath);
      const res = await runCommand(["rg", ...args], { cwd, timeoutMs: 30_000, signal });
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw new Error(res.stderr.trim() || `rg exited ${res.exitCode}`);
      }
      return textResult(res.stdout, { exitCode: res.exitCode });
    },
    async glob(params, signal) {
      const cwd = getCwd();
      const pattern = String(params?.pattern || "");
      if (!pattern) throw new Error("glob requires pattern");
      const rg = await runCommand(["rg", "--files", "-g", pattern], { cwd, timeoutMs: 30_000, signal }).catch(
        () => null,
      );
      if (rg && (rg.exitCode === 0 || rg.exitCode === 1)) {
        return textResult(rg.stdout, { via: "rg" });
      }
      const findPattern = pattern.startsWith("./") ? pattern : `./${pattern}`;
      const fallback = await runCommand(["find", ".", "-type", "f", "-path", findPattern], {
        cwd,
        timeoutMs: 30_000,
        signal,
      });
      return textResult(fallback.stdout, { via: "find" });
    },
    async find(params, signal) {
      const cwd = getCwd();
      const searchDir = params?.path ? await resolveWorkspacePath(cwd, params.path, "find", true) : cwd;
      const pattern = params?.pattern || params?.glob;
      if (signal?.aborted) throw new Error("aborted");
      const args = ["--files"];
      if (pattern) args.push("-g", String(pattern));
      const res = await runCommand(["rg", ...args, searchDir], { cwd, timeoutMs: 30_000, signal }).catch(() => null);
      if (res && (res.exitCode === 0 || res.exitCode === 1)) {
        return textResult(res.stdout, { via: "rg" });
      }
      const findArgs = [searchDir];
      if (pattern) findArgs.push("-name", String(pattern));
      const findRes = await runCommand(["find", ...findArgs], { cwd, timeoutMs: 30_000, signal });
      return textResult(findRes.stdout, { via: "find" });
    },
    async ls(params, signal) {
      const cwd = getCwd();
      const dirPath = params?.path ? await resolveWorkspacePath(cwd, params.path, "ls", true) : cwd;
      if (signal?.aborted) throw new Error("aborted");
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = [];
      for (const entry of entries) {
        const isDir = entry.isDirectory();
        const isSym = entry.isSymbolicLink();
        const typeLabel = isDir ? "dir" : isSym ? "sym" : "file";
        let size = 0;
        try {
          if (!isDir && !isSym) {
            const st = await fs.stat(path.join(dirPath, entry.name));
            size = st.size;
          }
        } catch {}
        lines.push(`${entry.name}${isDir ? "/" : ""} (${typeLabel}${size ? `, ${size} bytes` : ""})`);
      }
      return textResult(lines.join("\n"), { path: dirPath, count: entries.length });
    },
  };
}

export function createHostBridge({ pi, config, getCwd }) {
  const vfs = new CausalVfs();
  const executors = new Map();
  const natives = createNativeAdapters(getCwd, vfs, config);
  let callCount = 0;
  let activeCtx = null;
  let activeSignal = undefined;
  let trace = [];
  let callListener = null;

  if (pi && isFunction(pi.registerTool)) {
    const original = pi.registerTool.bind(pi);
    const excluded = new Set(config.excludeTools || []);
    pi.registerTool = (tool) => {
      if (
        tool &&
        isString(tool.name) &&
        isFunction(tool.execute) &&
        tool.name !== "supernova" &&
        !excluded.has(tool.name)
      ) {
        executors.set(tool.name, tool.execute.bind(tool));
      }
      return original(tool);
    };
  }

  function bindCallContext(ctx, signal) {
    activeCtx = ctx || null;
    activeSignal = signal;
  }

  function resetCallBudget() {
    callCount = 0;
    trace = [];
  }

  function getTrace() {
    return [...trace];
  }

  function setCallListener(fn) {
    callListener = isFunction(fn) ? fn : null;
  }

  function hasExecutor(name) {
    return executors.has(name) || Object.hasOwn(natives, name);
  }

  function beginSpeculation() {
    return vfs.begin();
  }

  async function commitSpeculation() {
    return await vfs.commit();
  }

  function rollbackSpeculation() {
    return vfs.rollback();
  }

  function clearVfsCache() {
    vfs.clear();
  }

  async function invokeRaw(name, args) {
    const maxCalls = config.maxBridgeCalls ?? 256;
    callCount += 1;
    if (callCount > maxCalls) {
      throw new Error(`supernova host call budget exceeded (${maxCalls})`);
    }
    if (activeSignal?.aborted) throw new Error("aborted");
    if (!isString(name) || !name) throw new Error("tool name required");

    // Never re-enter supernova or other excluded composition tools via the bridge.
    const excluded = new Set(config.excludeTools || []);
    if (name === "supernova" || excluded.has(name)) {
      throw new Error(
        `nova.call("${name}") is blocked (excluded / non-reentrant). Use nova.search/describe for discovery, or call a concrete host tool.`,
      );
    }

    const record = { name, args: args || {}, time: Date.now() };
    trace.push(record);

    const exec = executors.get(name);
    if (exec) {
      if (isMutatingTool(name, config)) await vfs.prepareExternalMutation(name);
      const res = await exec(`supernova:${name}:${callCount}`, args || {}, activeSignal, undefined, activeCtx);
      if (callListener) {
        try {
          callListener(record, [...trace]);
        } catch {}
      }
      return res;
    }

    const native = natives[name];
    if (native) {
      const res = await native(args || {}, activeSignal);
      if (res?.details?.diff) record.diff = res.details.diff;
      if (callListener) {
        try {
          callListener(record, [...trace]);
        } catch {}
      }
      return res;
    }

    throw new Error(
      `no executor for tool "${name}" (not captured via registerTool and no native adapter). Use nova.describe to inspect; ensure pi-supernova loads before other extensions, or call a core adapter: ${Object.keys(natives).join(", ")}`,
    );
  }

  async function call(name, args) {
    if (!isString(name) || !name) throw new Error("nova.call requires a tool name");
    const raw = await invokeRaw(name, args);
    return packageHostResult(raw, config);
  }

  async function callMany(calls) {
    const list = Array.isArray(calls) ? calls : [];
    const thunks = list.map((item) => {
      const n = item?.name;
      const a = item?.args;
      return () => call(n, a);
    });
    const names = list.map((item) => item?.name).filter((n) => isString(n));
    const wave = await runParallelWave(thunks, { names }, { mode: "auto", config });
    // Return a results array that also carries .mode/.reason, and is directly
    // iterable so `for (const r of await nova.callMany([...]))` works.
    const results = Array.isArray(wave.results) ? wave.results.slice() : [];
    Object.defineProperties(results, {
      mode: { value: wave.mode, enumerable: false },
      reason: { value: wave.reason, enumerable: false },
      results: { value: results, enumerable: false },
    });
    return results;
  }

  return {
    executors,
    natives,
    bindCallContext,
    resetCallBudget,
    getTrace,
    setCallListener,
    hasExecutor,
    beginSpeculation,
    commitSpeculation,
    rollbackSpeculation,
    clearVfsCache,
    getVfsCacheSize: () => vfs.getCacheSize(),
    getOverlayDepth: () => vfs.getOverlayDepth(),
    call,
    callMany,
    isMutating: (name) => isMutatingTool(name, config),
  };
}
