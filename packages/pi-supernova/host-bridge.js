
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { packageHostResult } from "./bottleneck.js";
import { isString, isNumber, isFunction, isObject } from "./decode.js";
import { isMutatingTool, runParallelWave } from "./parallel.js";
import { unknownToolMessage } from "./catalog.js";
import { extractStructuralSurface } from "./surface.js";
import { buildEditDiff, buildMultiEditDiff, buildPatchDiff, buildWriteDiff } from "./diff.js";
import { executeSnap } from "./snap.js";
import { selectEvidence } from "./evidence.js";
import { WorkspaceIndex, globToRegExp } from "./repo-index.js";
import { outlineFile } from "./outline.js";
import { rankPaths, smartCase, fuzzyMatch } from "./fuzzy.js";
import { CausalVfs } from "./vfs.js";
import { applyPatchToText } from "./patch.js";
import { resolveWorkspacePath, runCommand, clearPathCache } from "./workspace.js";

function textResult(text, details) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details: details || {},
  };
}

/** Unwrap a single matching quote pair around the whole string (`'git status'`). */
function unwrapIfFullyQuoted(s) {
  if (s.length < 2) return s;
  const q = s[0];
  if (q !== "'" && q !== '"') return s;
  if (s[s.length - 1] !== q) return s;
  const inner = s.slice(1, -1);
  if (inner.includes(q)) return s;
  return inner;
}

function sliceLines(text, offset, limit) {
  if (!isNumber(offset) && !isNumber(limit)) return text;
  const lines = text.split("\n");
  const startIndex = (isNumber(offset) ? Math.max(1, Math.floor(offset)) : 1) - 1;
  const count = isNumber(limit) ? Math.max(0, Math.floor(limit)) : lines.length;
  return lines.slice(startIndex, startIndex + count).join("\n");
}

function looksLikePath(target) {
  return (
    isString(target) &&
    (target.includes("/") ||
      target.includes("\\") ||
      target.startsWith(".") ||
      (!/\s/.test(target) && path.extname(target).length > 0))
  );
}

async function probeExistingFile(cwd, targetParam, vfs) {
  const targetPath = await resolveWorkspacePath(cwd, targetParam, "read", false);
  if (vfs.getOverlay(targetPath) !== undefined || vfs.cache.has(targetPath)) return targetPath;
  try {
    const st = await fs.stat(targetPath);
    if (st.isDirectory()) throw new Error(`read path is a directory, not a file: ${targetPath} (use ls)`);
    return targetPath;
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    return null;
  }
}

function patchModeOf(params) {
  return (
    isString(params?.patch) ||
    (params?.newText === undefined &&
      isString(params?.oldText) &&
      (params.oldText.includes("@@ -") || params.oldText.startsWith("---")))
  );
}

function applyReplacements(target, content, requestedEdits) {
  if (requestedEdits.length === 0) throw new Error("edit requires at least one replacement");
  const matches = requestedEdits.map((replacement) => {
    if (!isString(replacement?.oldText) || replacement.oldText.length === 0) {
      throw new Error("edit requires non-empty oldText");
    }
    if (!isString(replacement?.newText)) throw new Error("edit requires newText");
    const index = content.indexOf(replacement.oldText);
    if (index < 0) {
      throw new Error(`edit target not found in ${target}: oldText must match the file byte-for-byte (read() it first; check whitespace and quotes)`);
    }
    if (content.indexOf(replacement.oldText, index + replacement.oldText.length) >= 0) {
      throw new Error(`edit target is not unique in ${target}: include more surrounding lines in oldText, or pass edits:[{oldText,newText},…]`);
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
  return { updated, matches };
}

async function formatLsEntry(dirPath, entry) {
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
  const sizeSuffix = size ? `, ${size} bytes` : "";
  return `${entry.name}${isDir ? "/" : ""} (${typeLabel}${sizeSuffix})`;
}

function rgGrepArgs(pattern, params, searchPath) {
  const args = ["--line-number", "--no-heading", "--color", "never"];
  if (params?.caseSensitive !== true) args.push("--ignore-case");
  if (params?.glob) args.push("--glob", String(params.glob));
  args.push("--", pattern, searchPath);
  return args;
}

/** rg --files, then find(1) when rg is unavailable; both accept an optional glob/name pattern. */
async function listWithTools(searchDir, pattern, cwd, signal) {
  const args = ["--files"];
  if (pattern) args.push("-g", pattern);
  const res = await runCommand(["rg", ...args, searchDir], { cwd, timeoutMs: 30_000, signal }).catch(() => null);
  if (res && (res.exitCode === 0 || res.exitCode === 1)) return textResult(res.stdout, { via: "rg" });
  const findArgs = [searchDir];
  if (pattern) findArgs.push("-name", pattern);
  const findRes = await runCommand(["find", ...findArgs], { cwd, timeoutMs: 30_000, signal });
  return textResult(findRes.stdout, { via: "find" });
}

function relativeSlash(cwd, absolute) {
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * fffind: a pattern without glob characters is a fuzzy, typo-tolerant, frecency-ranked path query.
 * Returns "path" rows (best first) or null when the pattern is a real glob.
 */
async function fuzzyFind(index, root, cwd, pattern, limit = 20) {
  if (!pattern || GLOB_CHARS.test(pattern)) return null;
  const files = await index.files(root);
  if (!index.canScan(files)) return null;
  const rel = files.map((f) => relativeSlash(cwd, f));
  const mtimes = new Map(rel.map((r, i) => [r, index.mtimeSeconds(files[i])]));
  const ranked = rankPaths(pattern, rel, { frecency: index.frecency, mtimes, modified: await index.modifiedFiles(cwd), currentFile: index.lastTouched });
  // fff weak-match detector: when nothing matches exactly and the best is mostly typos, say so instead of flooding.
  const rows = ranked.slice(0, limit);
  if (rows.length === 0) return "";
  return rows.map((r) => r.path).join("\n") + "\n";
}

/** fff-style grep: smart-case, definition lines first, fuzzy fallback when the literal has no hits. */
async function grepIndexed(index, pattern, params, searchPath, cwd) {
  const compiled = grepRegex(pattern, params);
  if (!compiled) return null;
  const { regex, caseSensitive } = compiled;
  let files = await index.files(searchPath);
  if (!index.canScan(files)) return null;
  if (params?.glob) {
    const matcher = globToRegExp(String(params.glob));
    files = files.filter((f) => matcher.test(relativeSlash(cwd, f)));
  }
  const rows = index.grepRows(files, regex, cwd);
  const fallback = rows.length === 0 && /^[\w$.-]{4,}$/.test(pattern) ? fuzzyGrepRows(index, files, pattern, cwd, caseSensitive) : rows;
  return formatGrepRows(fallback, grepLimit(params));
}

function grepLimit(params) {
  return Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : 200;
}

function grepRegex(pattern, params) {
  const caseSensitive = params?.caseSensitive === true || (params?.caseSensitive !== false && smartCase(pattern));
  try {
    return { regex: new RegExp(pattern, caseSensitive ? "" : "i"), caseSensitive };
  } catch {
    return null;
  }
}

/** Zero literal hits: retry each line fuzzily (1 typo, 2 for long names) within a tight span, so IsOffTheRecord finds is_off_the_record. */
function fuzzyGrepRows(index, files, pattern, cwd, caseSensitive) {
  const maxTypos = pattern.length >= 8 ? 2 : 1;
  const rows = [];
  for (const filePath of files) {
    const e = index.entry(filePath);
    if (!e) continue;
    const { raw, defNames } = WorkspaceIndex.linesOf(e);
    const rel = relativeSlash(cwd, filePath);
    for (let i = 0; i < raw.length && rows.length <= 400; i++) {
      const m = fuzzyMatch(pattern, raw[i], { maxTypos, caseSensitive });
      if (!m || m.end - m.start > pattern.length + 2) continue;
      rows.push({ rel, line: i + 1, text: raw[i], def: defNames[i] !== "" && fuzzyMatch(pattern, defNames[i], { maxTypos }) !== null });
    }
  }
  return rows;
}

/** fff definition-first hinting: files that declare the name come first, declarations first within a file; one header per file. */
function formatGrepRows(rows, limit) {
  if (rows.length === 0) return "";
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.rel)) groups.set(r.rel, []);
    groups.get(r.rel).push(r);
  }
  const files = [...groups.values()].sort((a, b) => Number(b.some((r) => r.def)) - Number(a.some((r) => r.def)));
  let out = "";
  let shown = 0;
  for (const group of files) {
    if (shown >= limit) break;
    out += group[0].rel + "\n";
    group.sort((a, b) => Number(b.def) - Number(a.def) || a.line - b.line);
    for (const r of group) {
      if (shown++ >= limit) break;
      out += "  " + r.line + (r.def ? "*" : ":") + " " + r.text.trim() + "\n";
    }
  }
  if (rows.length > limit) out += "… " + (rows.length - limit) + " more matches (pass limit or narrow the pattern)\n";
  return out;
}

/** rg --files [-g pattern] served from the index; null when the tree is too large. */
async function listIndexed(index, root, cwd, pattern) {
  const files = await index.files(root);
  if (!index.canScan(files)) return null;
  const rel = files.map((f) => path.relative(cwd, f).split(path.sep).join("/"));
  if (!pattern) return rel.length ? rel.join("\n") + "\n" : "";
  let matcher;
  try {
    matcher = globToRegExp(pattern);
  } catch {
    return null;
  }
  const hits = rel.filter((f) => matcher.test(f));
  return hits.length ? hits.join("\n") + "\n" : "";
}

function createNativeAdapters(getCwd, vfs, config, index) {
  async function readAdapter(params, signal) {
      const cwd = getCwd();
      const targetParam = params?.path ?? params?.target;

      if (Array.isArray(targetParam)) {
        const results = await Promise.all(
          targetParam.map((p) => readAdapter({ path: p, offset: params?.offset, limit: params?.limit }, signal)),
        );
        const items = results.map((r) => r.content[0].text);
        return textResult(items.join("\n---\n"), { count: results.length, batch: true, items });
      }

      if (looksLikePath(targetParam)) {
        const targetPath = await resolveWorkspacePath(cwd, targetParam, "read", false);
        return readFile(targetPath, params);
      }

      const existing = await probeExistingFile(cwd, targetParam, vfs);
      if (existing) return readFile(existing, params);

      if (isString(targetParam) && targetParam.trim()) {
        try {
          const snapRes = await executeSnap({
            query: targetParam,
            searchDir: cwd,
            index,
            overlayText: (p) => vfs.getOverlay(p),
            pendingPaths: vfs.getOverlayPaths(),
          });
          return textResult(JSON.stringify(snapRes, null, 2), { ...snapRes, isSnap: true });
        } catch {}
      }

      const targetPath = await resolveWorkspacePath(cwd, targetParam, "read", false);
      return readFile(targetPath, params);
  }

  /** Plain text, a line window, or — with `about` — a relevance-folded outline of the whole file. */
  async function readFile(targetPath, params) {
    const cwd = getCwd();
    const text = await vfs.read(targetPath);
    index.touch(relativeSlash(cwd, targetPath));
    if (isString(params?.about)) {
      const pending = vfs.getOverlay(targetPath);
      const entry = pending === undefined ? index.entry(targetPath) : WorkspaceIndex.fromText(targetPath, pending);
      const outline = entry && outlineFile(entry, relativeSlash(cwd, targetPath), params.about, params?.maxChars ? { maxChars: params.maxChars } : {});
      if (outline) return textResult(outline.text, { path: targetPath, outline: true, expanded: outline.expanded, declarations: outline.declarations });
    }
    return textResult(sliceLines(text, params?.offset, params?.limit), { path: targetPath });
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
      index.touch(relativeSlash(cwd, target));
      const diff = buildWriteDiff(target, prevText, content);
      const tag = speculative ? " (speculative)" : "";
      return textResult(`wrote ${target}${tag}`, { path: target, speculative, diff });
    },
    async edit(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "edit", false);
      if (signal?.aborted) throw new Error("aborted");

      if (patchModeOf(params)) {
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
      const content = await vfs.read(target);
      const { updated, matches } = applyReplacements(target, content, requestedEdits);
      const { speculative } = await vfs.write(target, updated);
      index.touch(relativeSlash(cwd, target));
      const diff =
        matches.length === 1
          ? buildEditDiff(target, content, matches[0].oldText, matches[0].newText)
          : buildMultiEditDiff(target, content, matches);
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
      const relativeRoot = path.relative(cwd, snapTarget);
      const includeHidden = Boolean(params?.path) && relativeRoot
        .split(path.sep)
        .some((segment) => segment.startsWith(".") && segment.length > 1);
      const res = await executeSnap({
        query: params.query,
        searchDir: snapTarget,
        root: cwd,
        includeHidden,
        index,
        overlayText: (p) => vfs.getOverlay(p),
        pendingPaths: vfs.getOverlayPaths(),
      });
      return textResult(JSON.stringify(res, null, 2), res);
    },
    async evidence(params, signal) {
      const cwd = getCwd();
      if (!isString(params?.query) || !params.query.trim()) throw new Error("evidence requires query");
      if (signal?.aborted) throw new Error("aborted");
      const searchDir = params?.path ? await resolveWorkspacePath(cwd, params.path, "evidence", true) : cwd;
      const options = {};
      if (Number.isInteger(params?.k) && params.k > 0) options.k = params.k;
      if (Number.isInteger(params?.maxChars) && params.maxChars > 0) options.maxChars = params.maxChars;
      const res = await selectEvidence({ query: params.query, root: cwd, searchDir, index, overlayText: (p) => vfs.getOverlay(p), options });
      return textResult(JSON.stringify(res), { route: res.route, count: res.spans.length });
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
      const command = unwrapIfFullyQuoted(String(params?.command ?? "").trim());
      if (!command) throw new Error("bash requires command");
      const targetCwd = params?.cwd ? await resolveWorkspacePath(cwd, params.cwd, "bash cwd", true) : cwd;

      // Always shell. Splitting on spaces treated `git status` / quoted `exec("git status")`
      // as a single binary name (`bash: git status: command not found`).
      const argv = ["bash", "-c", command];

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
        index.invalidate();
      }
      const { stdout, stderr } = res;
      const text = stdout && stderr ? stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr : stdout || stderr;
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
      const indexed = await grepIndexed(index, pattern, params, searchPath, cwd);
      if (indexed !== null) return textResult(indexed, { exitCode: indexed ? 0 : 1, via: "index" });
      // Large tree: real rg keeps its own output format.
      const res = await runCommand(["rg", ...rgGrepArgs(pattern, params, searchPath)], { cwd, timeoutMs: 30_000, signal });
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw new Error(res.stderr.trim() || `rg exited ${res.exitCode}`);
      }
      return textResult(res.stdout, { exitCode: res.exitCode });
    },
    async glob(params, signal) {
      const cwd = getCwd();
      const pattern = String(params?.pattern || "");
      if (!pattern) throw new Error("glob requires pattern");
      const fuzzy = await fuzzyFind(index, cwd, cwd, pattern);
      if (fuzzy !== null) return textResult(fuzzy, { via: "fuzzy" });
      const indexed = await listIndexed(index, cwd, cwd, pattern);
      if (indexed !== null) return textResult(indexed, { via: "index" });
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
      const globPattern = pattern ? String(pattern) : null;
      const fuzzy = await fuzzyFind(index, searchDir, cwd, globPattern);
      if (fuzzy !== null) return textResult(fuzzy, { via: "fuzzy" });
      const indexed = await listIndexed(index, searchDir, cwd, globPattern);
      if (indexed !== null) return textResult(indexed, { via: "index" });
      return listWithTools(searchDir, globPattern, cwd, signal);
    },
    async ls(params, signal) {
      const cwd = getCwd();
      const dirPath = params?.path ? await resolveWorkspacePath(cwd, params.path, "ls", true) : cwd;
      if (signal?.aborted) throw new Error("aborted");
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = [];
      for (const entry of entries) {
        lines.push(await formatLsEntry(dirPath, entry));
      }
      return textResult(lines.join("\n"), { path: dirPath, count: entries.length });
    },
  };
}

export function createHostBridge({ pi, config, getCwd }) {
  const index = new WorkspaceIndex((argv, opts) => runCommand(argv, opts));
  const vfs = new CausalVfs(() => index.invalidate());
  const executors = new Map();
  const natives = createNativeAdapters(getCwd, vfs, config, index);
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
    // Files may change between programs (editor, git); never serve a stale run.
    vfs.invalidateCache();
    clearPathCache();
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

  function resultDiff(response) {
    let details = response?.details;
    if (isString(details)) {
      try {
        details = JSON.parse(details);
      } catch {
        return undefined;
      }
    }
    return isObject(details) ? details.diff : undefined;
  }

  function notifyCall(record) {
    if (!callListener) return;
    try {
      callListener(record, [...trace]);
    } catch {}
  }

  function checkCallBudget(name) {
    const maxCalls = config.maxBridgeCalls ?? 256;
    callCount += 1;
    if (callCount > maxCalls) {
      throw new Error(
        `host call budget exceeded (${maxCalls} calls per program): batch with read([paths]) or nova.callMany, or split the work across programs`,
      );
    }
    if (activeSignal?.aborted) throw new Error("aborted");
    if (!isString(name) || !name) throw new Error("tool name required");
  }

  function assertCallableTarget(name) {
    // Never re-enter supernova or other excluded composition tools via the bridge.
    const excluded = new Set(config.excludeTools || []);
    if (name === "supernova" || excluded.has(name)) {
      throw new Error(
        `nova.call("${name}") is blocked (excluded / non-reentrant). Use nova.search/describe for discovery, or call a concrete host tool.`,
      );
    }
  }

  async function writeFallbackDiff(name, args) {
    if (name !== "write" || !isString(args?.path) || !isString(args?.content)) return undefined;
    const target = await resolveWorkspacePath(getCwd(), args.path, "write", false);
    let previous = "";
    try {
      previous = await vfs.read(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return buildWriteDiff(target, previous, args.content);
  }

  function completeRecord(record, res, fallbackDiff) {
    const diff = resultDiff(res) || fallbackDiff;
    finishRecord(record, res);
    if (diff && record.ok) record.diff = diff;
    notifyCall(record);
  }

  async function invokeRaw(name, args) {
    checkCallBudget(name);
    assertCallableTarget(name);

    const record = { name, args: args || {}, time: Date.now() };
    trace.push(record);
    notifyCall(record);

    try {
      const exec = executors.get(name);
      if (exec) {
        const fallbackDiff = await writeFallbackDiff(name, args);
        if (isMutatingTool(name, config)) await vfs.prepareExternalMutation(name);
        const res = await exec(`supernova:${name}:${callCount}`, args || {}, activeSignal, undefined, activeCtx);
        completeRecord(record, res, fallbackDiff);
        return res;
      }

      const native = natives[name];
      if (native) {
        const res = await native(args || {}, activeSignal);
        completeRecord(record, res);
        return res;
      }

      throw new Error(unknownToolMessage(name, [...executors.keys(), ...Object.keys(natives)]));
    } catch (error) {
      record.ok = false;
      record.ms = Date.now() - record.time;
      record.error = error instanceof Error ? error.message : String(error);
      notifyCall(record);
      throw error;
    }
  }

  function finishRecord(record, res) {
    record.ms = Date.now() - record.time;
    record.ok = res?.isError !== true && res?.details?.ok !== false;
    const exitCode = isObject(res?.details) ? res.details.exitCode : undefined;
    if (Number.isInteger(exitCode) && exitCode !== 0) record.exitCode = exitCode;
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
