
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { packageHostResult, hostResultFailed } from "../output/bottleneck.js";
import { isString, isNumber, isFunction, isObject } from "../shared/decode.js";
import { isMutatingTool, runParallelWave, createNativeScheduler } from "../runtime/parallel.js";
import { unknownToolMessage } from "./catalog.js";
import { extractStructuralSurface } from "../context/surface.js";
import { buildEditDiff, buildMultiEditDiff, buildPatchDiff, buildWriteDiff } from "../fs/diff.js";
import { executeSnap } from "../context/snap.js";
import { selectEvidence } from "../context/evidence.js";
import { WorkspaceIndex } from "../context/repo-index.js";
import { outlineFile } from "../context/outline.js";
import { SeenLedger } from "../context/ledger.js";
import { quickCheck } from "../fs/check.js";
import { declaredName } from "../context/repo-index.js";
import { CausalVfs } from "../fs/vfs.js";
import { applyPatchToText } from "../fs/patch.js";
import { resolveWorkspacePath, runCommand, clearPathCache, relativeSlash } from "../fs/workspace.js";
import { fuzzyFind, grepIndexed, listIndexed, listWithTools, rgGrepArgs } from "../context/search.js";

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

function resolveReadPath(cwd, target) {
  if (!isString(target) || !target.trim()) throw new Error("read requires path");
  const input = target.trim();
  return path.resolve(cwd, input === "~" ? homedir() : input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input);
}

async function probeExistingPath(cwd, targetParam, vfs) {
  const targetPath = resolveReadPath(cwd, targetParam);
  if (vfs.getOverlay(targetPath) !== undefined) return { path: targetPath, directory: false };
  try {
    const st = await fs.stat(targetPath);
    return { path: targetPath, directory: st.isDirectory() };
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    if (vfs.getOverlayPaths().some(file => file.startsWith(targetPath + path.sep))) return { path: targetPath, directory: true };
    return null;
  }
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
    if (content.indexOf(replacement.oldText, index + 1) >= 0) {
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

function formatDirectoryEntry(name, type, size = 0) {
  const sizeSuffix = size ? `, ${size} bytes` : "";
  return `${name}${type === "dir" ? "/" : ""} (${type}${sizeSuffix})`;
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
  return formatDirectoryEntry(entry.name, typeLabel, size);
}

function createNativeAdapters(getCwd, vfs, config, index, ledger, hooks) {
  const reads = createNativeScheduler();
  async function sourceRead(query, searchDir, signal) {
    const cwd = getCwd();
    const includeHidden = path.relative(cwd, searchDir).split(path.sep)
      .some(segment => segment.startsWith(".") && segment.length > 1);
    const result = await executeSnap({ query, searchDir, root: cwd, includeHidden, index,
      overlayText: p => vfs.getOverlay(p), pendingPaths: vfs.getOverlayPaths(), signal });
    return textResult(JSON.stringify(result, null, 2), { ...result, isSnap: true });
  }

  async function readDirectory(dirPath, signal) {
    signal?.throwIfAborted();
    const rows = new Map();
    for (const file of vfs.getOverlayPaths()) {
      const relative = path.relative(dirPath, file);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
      const [name, child] = relative.split(path.sep);
      rows.set(name, child === undefined
        ? formatDirectoryEntry(name, "file", Buffer.byteLength(vfs.getOverlay(file), "utf8"))
        : formatDirectoryEntry(name, "dir"));
    }
    let entries;
    try { entries = await fs.readdir(dirPath, { withFileTypes: true }); } catch (error) {
      if (error.code !== "ENOENT" || rows.size === 0) throw error;
      entries = [];
    }
    for (const entry of entries) if (!rows.has(entry.name)) rows.set(entry.name, await formatLsEntry(dirPath, entry));
    return textResult([...rows.values()].join("\n"), { path: dirPath, count: rows.size });
  }

  async function readAdapter(params, signal) {
    signal?.throwIfAborted();
    const cwd = getCwd();
    const targetParam = params?.path ?? params?.target;
    if (Array.isArray(targetParam)) {
      if (targetParam.some(p => !isString(p) || !p.trim())) throw new Error("read paths must be non-empty strings");
      if (targetParam.length > 64) throw new Error("read accepts at most 64 paths per batch");
      const results = await Promise.all(targetParam.map(async p => {
        try {
          const block = (await readAdapter({ ...params, path: p }, signal)).content[0];
          return { text: block.type === "image" ? block : block.text };
        } catch (error) {
          signal?.throwIfAborted();
          return { text: `[read error: ${p}] ${error.message}`, error: { path: p, message: error.message } };
        }
      }));
      signal?.throwIfAborted();
      return textResult("", { count: results.length, batch: true, independent: params._independent === true, items: results.map(r => r.text), itemErrors: results.map(r => r.error?.message ?? null), errors: results.filter(r => r.error).map(r => r.error) });
    }
    return reads.schedule("read", () => readSingle(params, cwd, targetParam, signal), signal);
  }

  async function readSingle(params, cwd, targetParam, signal) {
    const existing = await probeExistingPath(cwd, targetParam, vfs);
    if (existing) {
      if (!existing.directory) return readFile(existing.path, params);
      return isString(params?.about) ? sourceRead(params.about, existing.path, signal) : readDirectory(existing.path, signal);
    }
    if (!looksLikePath(targetParam)) return sourceRead(targetParam, cwd, signal);
    const targetPath = resolveReadPath(cwd, targetParam);
    return readFile(targetPath, params);
  }

  /** Plain text, a line window, or (with `about`) a relevance-folded outline of the whole file. */
  async function readFile(targetPath, params) {
    const cwd = getCwd();
    const rel = relativeSlash(cwd, targetPath);
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }[path.extname(targetPath).toLowerCase()];
    if (mime) {
      if ((await fs.stat(targetPath)).size > 20 * 1024 * 1024) throw new Error("image exceeds 20 MiB; resize it before reading");
      const staged = vfs.getOverlay(targetPath);
      const bytes = staged === undefined ? await fs.readFile(targetPath) : Buffer.from(staged);
      return { content: [{ type: "image", mimeType: mime, data: bytes.toString("base64") }], details: { path: targetPath } };
    }
    const text = await vfs.read(targetPath);
    index.touch(rel);
    if (isString(params?.about)) {
      const pending = vfs.getOverlay(targetPath);
      const entry = pending === undefined ? index.entry(targetPath) : WorkspaceIndex.fromText(targetPath, pending);
      const outline = entry && outlineFile(entry, rel, params.about, outlineOptions(params, await referenceFinder(cwd, targetPath)));
      if (outline) {
        recordOutlineOrigins(rel, outline.text);
        return textResult(outline.text, { path: targetPath, outline: true, expanded: outline.expanded, declarations: outline.declarations });
      }
    }
    const explicit = isNumber(params?.offset) || isNumber(params?.limit);
    const firstLine = isNumber(params?.offset) ? Math.max(1, Math.floor(params.offset)) : 1;
    const sliced = sliceLines(text, params?.offset, params?.limit);
    const budget = Math.max(1, Math.min(config.maxCallResultChars ?? 65536, (config.maxReturnChars ?? 32000) - 256));
    if (sliced.length > budget) {
      const end = sliced.lastIndexOf("\n", budget - 160);
      if (end < 0) throw new Error(`line ${firstLine} exceeds the read budget; use bash to inspect a bounded substring`);
      const body = sliced.slice(0, end + 1);
      const next = firstLine + body.split("\n").length - 1;
      return textResult(body + `\n[read truncated; continue with read({path:${JSON.stringify(rel)}, offset:${next}})]`, { path: targetPath, outputTruncated: true, nextOffset: next });
    }
    ledger.recordOrigin(rel, firstLine, sliced.split("\n"), explicit);
    return textResult(sliced, { path: targetPath });
  }

  /**
   * The edit result answers the follow-ups a model would otherwise spend turns on: the post-edit
   * lines with numbers (so no verification re-read), a quick structural check, and every other
   * place a changed declaration is referenced (so callers are not forgotten).
   */
  async function editSummary(cwd, target, original, updated, diff) {
    const rel = relativeSlash(cwd, target);
    const newLines = updated.split("\n");
    const added = diff.lines.filter((l) => l.type === "add");
    const first = added.length ? Math.max(1, added[0].lineNum - 2) : 1;
    const last = added.length ? Math.min(newLines.length, added[added.length - 1].lineNum + 2) : Math.min(newLines.length, first + 6);
    const window = [];
    for (let l = first; l <= last && window.length < 40; l++) window.push(String(l).padStart(5) + " " + newLines[l - 1]);
    ledger.recordOrigin(rel, first, newLines.slice(first - 1, first - 1 + window.length));
    let out = `edited ${rel}:${first}–${first + window.length - 1}\n${window.join("\n")}`;
    const check = quickCheck(updated, path.extname(target));
    if (check && !check.ok) out += `\ncheck: ${check.message}`;
    const refs = await changedDeclarationRefs(cwd, target, original, updated, diff);
    if (refs) out += `\n${refs}`;
    return out;
  }

  async function changedDeclarationRefs(cwd, target, original, updated, diff) {
    // Diff rows carry the replaced fragments; declarations live on whole file lines.
    const oldLines = original.split("\n");
    const newLines = updated.split("\n");
    const names = new Set();
    for (const l of diff.lines) {
      if (l.type === "context") continue;
      const name = declaredName((l.type === "remove" ? oldLines : newLines)[l.lineNum - 1] ?? "");
      if (name) names.add(name);
    }
    if (names.size === 0) return "";
    const find = await referenceFinder(cwd, target);
    const parts = [];
    for (const name of [...names].slice(0, 3)) {
      const refs = find(name).filter((r) => !r.startsWith(relativeSlash(cwd, target) + ":"));
      if (refs.length) parts.push(`${name} also referenced in ${refs.slice(0, 6).join(", ")}${refs.length > 6 ? " (+" + (refs.length - 6) + ")" : ""}`);
    }
    return parts.join("\n");
  }

  const SOURCE_REF = /((?:[\w.@-]+\/)*[\w.@-]+\.(?:m?[jt]sx?|c[jt]s|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|json|ya?ml|toml))(?::|\()(\d+)/g;

  /** Source window (±2 lines, ► on the cited line) for one path:line, or null when it is outside the workspace/index. */
  function sourceWindow(cwd, file, lineNo) {
    const candidate = path.resolve(cwd, file);
    if (!candidate.startsWith(path.resolve(cwd) + path.sep)) return null;
    const entry = index.entry(candidate);
    if (!entry) return null;
    const { raw } = WorkspaceIndex.linesOf(entry);
    if (lineNo < 1 || lineNo > raw.length) return null;
    const rel = relativeSlash(cwd, candidate);
    const start = Math.max(1, lineNo - 2);
    const rows = [];
    for (let l = start; l <= Math.min(raw.length, lineNo + 2); l++) rows.push((l === lineNo ? "►" : " ") + String(l).padStart(4) + " " + raw[l - 1]);
    ledger.recordOrigin(rel, start, rows);
    return rel + ":" + lineNo + "\n" + rows.join("\n");
  }

  /** A failing command names path:line; the model wants those lines next. Attach them (≤4 sites). */
  function sourceForReferences(cwd, output) {
    const seen = new Set();
    const blocks = [];
    for (const m of output.matchAll(SOURCE_REF)) {
      const key = m[1] + ":" + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      const block = sourceWindow(cwd, m[1], Number(m[2]));
      if (block) blocks.push(block);
      if (blocks.length >= 4) break;
    }
    return blocks.length ? "\n--- source\n" + blocks.join("\n") : "";
  }

  function outlineOptions(params, references) {
    const options = { references };
    if (params?.maxChars) options.maxChars = params.maxChars;
    return options;
  }

  /** Outline lines carry their own line numbers ("  330 text"); provenance follows them. */
  function recordOutlineOrigins(rel, outlineText) {
    for (const line of outlineText.split("\n")) {
      const m = /^\s*(\d+) (.*)$/.exec(line);
      if (m && !/ … \d+ lines$/.test(line)) ledger.recordOrigin(rel, Number(m[1]), [line]);
    }
  }

  /** Where else a name appears (declaration line excluded), for outlines and edit results. */
  async function referenceFinder(cwd, targetPath) {
    const files = await index.files(cwd);
    if (!index.canScan(files)) return () => [];
    return (name, excludeLine) => {
      if (!name || name.length < 3) return [];
      const escaped = name.replace(/[$]/g, (c) => "\\" + c);
      const regex = new RegExp("\\b" + escaped + "\\b");
      return index
        .grepRows(files, regex, cwd)
        .filter((r) => !(r.line === excludeLine && r.rel === relativeSlash(cwd, targetPath)))
        .map((r) => r.rel + ":" + r.line);
    };
  }

  hooks.summarizeEdit = editSummary;
  return {
    read: readAdapter,
    async write(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "write", false);
      if (signal?.aborted) throw new Error("aborted");
      if (!isString(params?.content)) throw new Error("write requires string content");
      const content = params.content;
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
      const summary = await editSummary(cwd, target, content, updated, diff);
      return textResult(summary, { path: target, speculative, diff });
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
        signal,
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
      const res = await selectEvidence({ query: params.query, root: cwd, searchDir, index, overlayText: (p) => vfs.getOverlay(p), pendingPaths: vfs.getOverlayPaths(), options });
      for (const span of res.spans) ledger.recordOrigin(span.path, span.lines[0], span.text.split("\n"));
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
          env: hooks.commandEnv(),
          timeoutMs: params?.timeoutMs,
          signal,
          maxOutputChars: config.maxCallResultChars,
        });
      } finally {
        vfs.invalidateCache();
        index.invalidate();
      }
      const { stdout, stderr } = res;
      let text = stdout && stderr ? stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr : stdout || stderr;
      if (res.exitCode !== 0) text += sourceForReferences(cwd, text);
      return {
        content: [{ type: "text", text }],
        details: { exitCode: res.exitCode, signal: res.signal, outputTruncated: res.outputTruncated, transactionBarrier },
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
      return readDirectory(dirPath, signal);
    },
  };
}

export function createHostBridge({ pi, config, getCwd, registry, ledger: runLedger }) {
  const index = registry?.index ?? new WorkspaceIndex((argv, opts) => runCommand(argv, opts));
  const ledger = runLedger ?? new SeenLedger({ window: config.seenWindow ?? 40 });
  const vfs = new CausalVfs(() => index.invalidate());
  const executors = registry?.executors ?? new Map();
  const definitions = registry?.definitions ?? new Map();
  const sharedRegistry = registry ?? { executors, definitions, index, callSeq: 0 };
  let closed = false;
  const hooks = {};
  const natives = createNativeAdapters(getCwd, vfs, config, index, ledger, hooks);
  let callCount = 0;
  let activeCtx = null;
  let hostSession = null;
  let boundSessionId;
  let activeSignal = undefined;
  let trace = [];
  let callListener = null;
  const scheduler = createNativeScheduler();
  hooks.commandEnv = () => {
    const env = { ...process.env };
    const current = {
      PI_SESSION_ID: activeCtx?.sessionManager?.getSessionId?.(),
      PI_SESSION_FILE: activeCtx?.sessionManager?.getSessionFile?.(),
      PI_PROVIDER: activeCtx?.model?.provider,
      PI_MODEL: activeCtx?.model?.id,
      PI_REASONING_LEVEL: activeCtx?.thinkingLevel,
    };
    for (const [key, value] of Object.entries(current)) {
      if (isString(value)) env[key] = value;
      else delete env[key];
    }
    return env;
  };

  if (!registry && pi && isFunction(pi.registerTool)) {
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
        definitions.set(tool.name, tool);
      }
      return original(tool);
    };
  }

  function bindCallContext(ctx, signal) {
    activeCtx = ctx || null;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    boundSessionId = sessionId;
    const registry = pi?.pi?.AgentRegistry?.global?.();
    hostSession = sessionId && registry?.list
      ? registry.list().map(ref => ref.session).find(session => !session?.isDisposed && session?.sessionManager?.getSessionId?.() === sessionId) ?? null
      : null;
    activeSignal = signal;
    vfs.signal = signal;
  }

  function hostTool(name) {
    if (!hostSession) return undefined;
    const metadata = definitions.get(name);
    // Keep Supernova's transactional adapters for ordinary built-ins. Respect overrides.
    if (Object.hasOwn(natives, name) && metadata?.sourceInfo?.source === "builtin") return undefined;
    return hostSession.getToolForEvalBridge?.(name);
  }

  function isCallable(name) {
    if (name === "supernova" || (config.excludeTools ?? []).includes(name)) return false;
    if (hostSession && (hostSession.isDisposed || hostSession.sessionManager.getSessionId() !== boundSessionId)) return false;
    // An internal adapter belongs to Supernova, not the host's visible tool list.
    const nativeOwned = Object.hasOwn(natives, name) && !executors.has(name)
      && (!hostSession || !definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin");
    if (nativeOwned) return true;
    if (hostSession) {
      if (!hostSession.getEvalBridgeToolNames().includes(name) && definitions.has(name)) return false;
      return !!hostTool(name) || (Object.hasOwn(natives, name) && (!definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin"));
    }
    if (definitions.has(name) && isFunction(pi?.getActiveTools) && !pi.getActiveTools().includes(name)) return false;
    return executors.has(name) || Object.hasOwn(natives, name);
  }

  function refreshTools() {
    const tools = pi?.getAllTools?.() ?? [];
    for (const tool of tools) {
      if (!isString(tool?.name)) continue;
      definitions.set(tool.name, { ...definitions.get(tool.name), ...tool });
      if (!hostSession && isFunction(tool.execute)) executors.set(tool.name, tool.execute.bind(tool));
    }
    return [...definitions.values()].filter(tool => isCallable(tool.name));
  }

  function externalNames() {
    return [...definitions.keys()].filter(name => !!hostTool(name) || executors.has(name));
  }

  function resetCallBudget() {
    closed = false;
    vfs.closed = false;
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

  function beginSpeculation() {
    return vfs.begin();
  }

  async function commitSpeculation() {
    return await vfs.commit();
  }

  function rollbackSpeculation() {
    return vfs.rollback();
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
    if (closed) throw new Error("program is already complete");
    const maxCalls = config.maxBridgeCalls ?? 256;
    callCount += 1;
    if (callCount > maxCalls) {
      throw new Error(
        `host call budget exceeded (${maxCalls} calls per program): split the work across programs`,
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
        `${name} is blocked (excluded / non-reentrant).`,
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
    const callId = ++sharedRegistry.callSeq;
    assertCallableTarget(name);
    if (!isCallable(name)) throw new Error(unknownToolMessage(name, [...definitions.keys(), ...Object.keys(natives)].filter(isCallable)));

    const command = { apply_patch: "edit", surface: "read", evidence: "read", snap: "read" }[name] ?? name;
    const record = { name: command, adapter: name, args: args || {}, time: Date.now() };
    trace.push(record);
    notifyCall(record);

    try {
      const delegated = hostTool(name);
      const exec = delegated ? delegated.execute.bind(delegated) : hostSession ? undefined : executors.get(name);
      if (exec) {
        const fallbackDiff = await writeFallbackDiff(name, args);
        const mutating = isMutatingTool(name, config, args, definitions.get(name));
        if (mutating) await vfs.prepareExternalMutation(name);
        if (activeSignal?.aborted || closed) throw new Error("aborted");
        if (!isCallable(name)) throw new Error("tool is no longer enabled in this session: " + name);
        try {
          const res = await exec(`supernova:${name}:${callId}`, args || {}, activeSignal, undefined, delegated
            ? { ...activeCtx, settings: hostSession.settings, toolNames: hostSession.getEvalBridgeToolNames(), autoApprove: false }
            : activeCtx);
          completeRecord(record, res, fallbackDiff);
          return res;
        } finally {
          if (mutating) { vfs.invalidateCache(); index.invalidate(); clearPathCache(); }
        }
      }

      const native = Object.hasOwn(natives, name) ? natives[name] : undefined;
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
    record.ok = !hostResultFailed(res);
    const exitCode = isObject(res?.details) ? res.details.exitCode : undefined;
    if (Number.isInteger(exitCode) && exitCode !== 0) record.exitCode = exitCode;
  }

  async function call(name, args) {
    if (!isString(name) || !name) throw new Error("nova.call requires a tool name");
    const invoke = async () => packageHostResult(await invokeRaw(name, args), config);
    const kind = isMutatingTool(name, config, args, definitions.get(name)) ? "write" : "read";
    return scheduler.schedule(kind, invoke, activeSignal);
  }

  async function callMany(calls) {
    if (!Array.isArray(calls)) throw new TypeError("nova.callMany requires an array");
    const list = calls;
    if (list.some(item => !isString(item?.name) || !item.name)) throw new TypeError("nova.callMany entries require a tool name");
    const thunks = list.map((item) => {
      const n = item?.name;
      const a = item?.args;
      return () => call(n, a);
    });
    const names = list.map((item) => item?.name).filter((n) => isString(n));
    const wave = await runParallelWave(thunks, { names, calls: list, definitions: names.map(name => definitions.get(name)) }, { mode: "auto", config });
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
    definitions,
    natives,
    refreshTools,
    isCallable,
    externalNames,
    supportsBatchRead: () => !hostTool("read") && !executors.has("read"),
    summarizeEdit: (target, before, after, diff) => hooks.summarizeEdit(getCwd(), target, before, after, diff),
    invalidateFiles() { vfs.invalidateCache(); index.invalidate(); clearPathCache(); },
    fileOperations: {
      access: (target, mode) => fs.access(target, mode),
      readFile: async target => Buffer.from(await vfs.read(target), "utf8"),
      // VFS owns parent creation and atomic replacement, inside Pi's file queue.
      mkdir: async () => {},
      async writeFile(target, content) {
        await resolveWorkspacePath(getCwd(), target, "write", false);
        await vfs.write(target, content);
        index.touch(relativeSlash(getCwd(), target));
      },
    },
    fork(options) {
      return createHostBridge({ pi, config, getCwd: options.getCwd, registry: sharedRegistry, ledger: ledger.fork() });
    },
    close() { closed = true; vfs.closed = true; },
    bindCallContext,
    resetCallBudget,
    getTrace,
    setCallListener,
    barrier: run => scheduler.schedule("write", run, activeSignal),
    beginSpeculation,
    commitSpeculation,
    rollbackSpeculation,
    getVfsCacheSize: () => vfs.getCacheSize(),
    getOverlayDepth: () => vfs.getOverlayDepth(),
    call,
    callMany,
    ledger,
  };
}
