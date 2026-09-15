
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { packageHostResult, hostResultFailed } from "../output/bottleneck.js";
import { truncateChars } from "../output/format.js";
import { isString, isNumber, isFunction, isObject, looksLikePath } from "../shared/decode.js";
import { isMutatingTool, runParallelWave, createNativeScheduler } from "../runtime/parallel.js";
import { unknownToolMessage } from "./catalog.js";
import { extractStructuralSurface } from "../context/surface.js";
import { pickSpan } from "../context/spans.js";
import { buildEditDiff, buildMultiEditDiff, buildPatchDiff, buildWriteDiff } from "../fs/diff.js";
import { executeSnap, tokenizeQuery, stem } from "../context/snap.js";
import { selectEvidence } from "../context/evidence.js";
import { WorkspaceIndex } from "../context/repo-index.js";
import { outlineFile } from "../context/outline.js";
import { SeenLedger } from "../context/ledger.js";
import { quickCheck } from "../fs/check.js";
import { declaredName } from "../context/repo-index.js";
import { CausalVfs } from "../fs/vfs.js";
import { MAX_JSON_BYTES, jsonProjector, sessionJsonArgs, validateJsonRead } from "../fs/json-read.js";
import { applyPatchToText } from "../fs/patch.js";
import { resolveWorkspacePath, runCommand, clearPathCache, relativeSlash, assertFilesystemPath } from "../fs/workspace.js";
import { fuzzyFind, grepIndexed, listIndexed, listWithTools, rgGrepArgs, referencesForNames } from "../context/search.js";

function textResult(text, details) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details: details || {},
  };
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

function sliceLinesRawInfo(text, offset, limit) {
  const logical = contentLineInfo(text).count;
  const totalLines = text === "" ? 1 : logical + (text.endsWith("\n") ? 1 : 0);

  if (!isNumber(offset) && !isNumber(limit)) {
    return { text, end: totalLines, total: totalLines, count: totalLines, eof: true, whole: true };
  }

  const startIndex = (isNumber(offset) ? Math.max(1, Math.floor(offset)) : 1) - 1;
  const count = isNumber(limit) ? Math.max(0, Math.floor(limit)) : totalLines;

  if (count === 0 || startIndex >= totalLines) {
    const emptyFile = totalLines === 1 && text === "";

    return { text: "", end: totalLines, total: totalLines, count: 0, eof: true, whole: emptyFile };
  }

  const endExclusive = Math.min(totalLines, startIndex + count);
  const start = lineStartIndex(text, startIndex + 1);
  const end = lineEndIndex(text, start, endExclusive - startIndex);
  let selected = text.slice(start, end);
  const eof = endExclusive >= totalLines || (endExclusive === totalLines - 1 && text.endsWith("\n"));

  if (endExclusive < totalLines && !selected.endsWith("\n")) selected += "\n";

  return { text: selected, end: endExclusive, total: totalLines, count: endExclusive - startIndex, eof, whole: startIndex === 0 && eof };
}

/** Read-window slicing preserves the selected lines' own line ending. */
function sliceLinesRaw(text, offset, limit) {
  return sliceLinesRawInfo(text, offset, limit).text;
}

function readLineParam(value, name) {
  if (value === undefined) return undefined;
  const number = isNumber(value) ? value : isString(value) && value.trim() !== "" ? Number(value) : NaN;

  if (!Number.isFinite(number)) throw new Error("read " + name + " must be a finite number");

  return Math.floor(number);
}

function normalizeReadWindow(params) {
  if (!isObject(params)) return params;
  const normalized = { ...params };
  const offset = readLineParam(params.offset, "offset");
  const limit = readLineParam(params.limit, "limit");

  if (offset !== undefined) normalized.offset = Math.max(1, offset);
  if (limit !== undefined) normalized.limit = Math.max(0, limit);

  return normalized;
}

function resolveReadPath(cwd, target) {
  if (!isString(target) || !target.trim()) throw new Error("read requires path");
  const input = assertFilesystemPath(target, "read");

  return path.resolve(cwd, input === "~" ? homedir() : input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input);
}

async function probeExistingPath(cwd, targetParam, vfs) {
  const targetPath = resolveReadPath(cwd, targetParam);

  if (vfs.getOverlay(targetPath) !== undefined) {
    const overlay = vfs.getOverlay(targetPath);

    return { path: targetPath, directory: false, size: Buffer.byteLength(overlay, "utf8"), overlay };
  }

  try {
    const st = await fs.stat(targetPath);

    return { path: targetPath, directory: st.isDirectory(), size: st.size };
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;

    if (vfs.getOverlayPaths().some(file => file.startsWith(targetPath + path.sep))) return { path: targetPath, directory: true };

    return null;
  }
}

const EDIT_PREVIEW_LINES = 16;

const MAX_DIRECTORY_ENTRIES = 10000;

function sourceLines(content) {
  const raw = content.split("\n");

  if (raw.at(-1) === "") raw.pop();

  return raw;
}

function lineNumberAt(content, index) {
  let line = 1;

  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;

  return line;
}

function formatNumberedLine(n, text) {
  return String(n).padStart(5) + " " + text;
}

function numberedPreview(content, cap = EDIT_PREVIEW_LINES) {
  const { count, preview } = contentLineInfo(content, cap);

  if (count === 0) return "0 lines";
  const body = preview.map((line, i) => formatNumberedLine(i + 1, line)).join("\n");
  const suffix = count + " lines total";

  return body + "\n" + suffix;
}

function applyReplacements(target, content, requestedEdits) {
  if (requestedEdits.length === 0) throw new Error("edit requires at least one replacement");

  const matches = requestedEdits.map((replacement) => {
    if (!isString(replacement?.oldText) || replacement.oldText.length === 0) {
      throw new Error("edit requires non-empty oldText");
    }

    if (!isString(replacement?.newText)) throw new Error("edit requires newText");
    const oldText = String(replacement.oldText);
    const newText = String(replacement.newText);
    const index = content.indexOf(oldText);

    if (index < 0) {
      throw new Error("edit target not found in " + target + ": oldText must match the file byte-for-byte\n" + numberedPreview(content));
    }
    const second = content.indexOf(oldText, index + 1);

    if (second >= 0) {
      const a = lineNumberAt(content, index);
      const b = lineNumberAt(content, second);
      const lineText = n => {
        const range = lineTextRange(content, n);

        return content.slice(range.start, range.end).replace(/\r?\n$/, "");
      };

      throw new Error("edit target is not unique in " + target + ": lines " + a + " and " + b + "; include more surrounding lines in oldText, or pass edits:[{oldText,newText},…]\n" + formatNumberedLine(a, lineText(a)) + "\n" + formatNumberedLine(b, lineText(b)));
    }

    return { ...replacement, oldText, newText, index, end: index + oldText.length };
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

function lineStartIndex(content, line) {
  let index = 0;

  for (let current = 1; current < line; current++) {
    const next = content.indexOf("\n", index);

    if (next < 0) return content.length;
    index = next + 1;
  }

  return Math.min(index, content.length);
}

function lineEndIndex(content, startIndex, lineCount) {
  let index = startIndex;

  for (let i = 0; i < lineCount; i++) {
    const next = content.indexOf("\n", index);

    if (next < 0) return content.length;
    index = next + 1;
  }

  return index;
}

function lineTextRange(content, line) {
  const start = lineStartIndex(content, line);

  return { start, end: lineEndIndex(content, start, 1) };
}

function shiftDiffLines(diff, delta) {
  if (!diff || delta === 0) return diff;

  return {
    ...diff,
    lines: diff.lines.map(line => ({
      ...line,
      lineNum: line.lineNum + delta,
      newLineNum: line.newLineNum === undefined ? undefined : line.newLineNum + delta,
    })),
  };
}

function applyViewReplace(target, content, start, end, oldText, newText) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error("edit requires a valid view range in " + target);
  }

  const current = sliceLinesRaw(content, start, end - start + 1);

  if (current !== oldText) {
    const shown = current.length ? current : content;

    throw new Error("edit view is stale in " + target + ": lines " + start + "-" + end + " changed\n" + numberedPreview(shown));
  }

  const startIndex = lineStartIndex(content, start);
  const endIndex = lineEndIndex(content, startIndex, Math.max(0, end - start + 1));
  const hasSuffix = endIndex < content.length;
  const separator = hasSuffix && content.slice(Math.max(0, endIndex - 2), endIndex) === "\r\n" ? "\r\n" : "\n";
  const eofNewline = content.endsWith("\r\n") ? "\r\n" : "\n";
  let insert = newText;

  // A view replaces whole source lines. Preserve the separator before following
  // lines, but let an explicit trailing newline change a no-trailing-newline EOF.
  if (hasSuffix && insert !== "" && !insert.endsWith("\n")) insert += separator;
  if (!hasSuffix && content.endsWith("\n") && insert !== "" && !insert.endsWith("\n")) insert += eofNewline;
  const updated = content.slice(0, startIndex) + insert + content.slice(endIndex);

  return { updated, oldText, newText };
}

const WRITE_DIFF_MAX_READ_BYTES = 512 * 1024;
const WRITE_APPEND_MAX_READ_BYTES = 64 * 1024 * 1024;
const QUICK_CHECK_MAX_CHARS = 2 * 1024 * 1024;

async function countContentLines(target, signal) {
  const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    const stat = await file.stat();

    if (!stat.isFile()) return null;
    let newlines = 0;
    let last = -1;
    let total = 0;

    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
      last = chunk.at(-1);
      total += chunk.length;
    }

    return total === 0 ? 0 : newlines + (last === 10 ? 0 : 1);
  } finally { await file.close(); }
}

function contentLineInfo(text, previewLimit = 0) {
  if (text === "") return { count: 0, preview: [], newlines: 0 };
  const preview = [];
  let count = 0;
  let start = 0;

  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;

    if (end === text.length && end === start && text.endsWith("\n")) break;
    if (preview.length < previewLimit) preview.push(text.slice(start, end).replace(/\r$/, ""));
    count++;
    if (newline < 0) break;
    start = newline + 1;
  }

  return { count, preview, newlines: count - Number(!text.endsWith("\n")) };
}

function boundedEditDiff(target, original, matches) {
  const lines = [];
  let shift = 0;
  let added = 0;
  let removed = 0;

  for (const match of matches) {
    const oldInfo = contentLineInfo(match.oldText, 32);
    const newInfo = contentLineInfo(match.newText, 32);
    const start = lineNumberAt(original, match.index);
    const nextStart = start + shift;

    removed += oldInfo.count;
    added += newInfo.count;

    for (let i = 0; i < oldInfo.preview.length; i++) lines.push({ type: "remove", lineNum: start + i, newLineNum: nextStart + i, text: oldInfo.preview[i] });
    for (let i = 0; i < newInfo.preview.length; i++) lines.push({ type: "add", lineNum: nextStart + i, newLineNum: nextStart + i, text: newInfo.preview[i] });

    shift += newInfo.newlines - oldInfo.newlines;
  }

  return { path: target, op: "edit", added, removed, lines };
}

function boundedWriteDiff(target, content, removed) {
  const added = contentLineInfo(content, 64);

  return {
    path: target,
    op: "write",
    added: added.count,
    removed: removed ?? 0,
    displayLineCount: (removed ?? 0) + added.count,
    lines: added.preview.map((text, i) => ({ type: "add", lineNum: i + 1, text })),
  };
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

  async function sourceRead(query, searchDir, signal, params = {}) {
    params = { ...params, resolve: params.resolve !== false };
    const cwd = getCwd();

    const includeHidden = path.relative(cwd, searchDir).split(path.sep)
      .some(segment => segment.startsWith(".") && segment.length > 1);

    const result = await executeSnap({ query, searchDir, root: cwd, includeHidden,
      pathContext: { frecency: index.frecency, currentFile: index.lastTouched },
      overlayText: p => vfs.getOverlay(p), pendingPaths: vfs.getOverlayPaths(), signal });

    return openSource(result, params, signal, undefined, query);
  }

  async function openSource(result, params, signal, resolvedPath, query) {
    const cwd = getCwd();

    if (result.status !== "found") return textResult(JSON.stringify(result), { isSnap: true });
    signal?.throwIfAborted();
    const target = resolvedPath ?? path.resolve(cwd, result.path);
    let bounded = isString(query) && params.complete !== true;

    if (bounded) {
      const overlay = vfs.getOverlay(target);

      if (overlay !== undefined) bounded = Buffer.byteLength(overlay, "utf8") > 512 * 1024;
      else try { bounded = (await fs.stat(target)).size > 512 * 1024; } catch { bounded = false; }
    }

    const opened = await readFile(target, bounded
      ? { ...params, about: undefined, offset: Math.max(1, result.line - 4), limit: params.limit ?? 120 }
      : { ...params, about: undefined }, result.line, result.path, bounded ? undefined : query, signal);
    const block = opened.content?.[0];

    if (block?.type !== "text") throw new Error("source resolution requires a text file; read the image path directly");
    const { firstLine, lastLine, sourceChars, nextOffset, complete, viewComplete } = opened.details;

    if (lastLine < firstLine) return textResult(JSON.stringify({ status: "incomplete", path: result.path, line: result.line, signature: result.signature ?? "", confidence: result.confidence ?? 0, context: result.context ?? [], message: "offset is beyond the end of " + result.path }), { ...opened.details, isSnap: true });
    const source = { status: "found", path: result.path, line: result.line, lines: [firstLine, lastLine],
      text: block.text.slice(0, sourceChars), complete, nextOffset };

    return textResult(params.resolve ? JSON.stringify(source) : "// " + result.path + ":" + firstLine + "-" + lastLine + "\n" + block.text,
      { ...opened.details, isSnap: true });
  }

  async function readDirectory(dirPath, signal) {
    signal?.throwIfAborted();
    const rows = new Map();
    let truncated = false;

    for (const file of vfs.getOverlayPaths()) {
      if (rows.size >= MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
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

    for (let i = 0; i < entries.length; i++) {
      if ((i & 127) === 0) signal?.throwIfAborted();
      if (rows.size >= MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
      if (!rows.has(entries[i].name)) rows.set(entries[i].name, await formatLsEntry(dirPath, entries[i]));
    }

    const values = [...rows.values()];
    const text = values.join("\n") + (truncated ? "\n[directory listing truncated at " + MAX_DIRECTORY_ENTRIES + " entries]" : "");

    return textResult(text, { path: dirPath, directory: true, count: rows.size, entries: values, outputTruncated: truncated });
  }

  /** Read an explicit line window without materializing the whole file when possible. */
  async function readWindow(targetPath, startLine, lineCount, maxBytes, signal) {
    const overlay = vfs.getOverlay(targetPath);

    if (overlay !== undefined) {
      const window = sliceLinesRawInfo(overlay, startLine, lineCount);
      const satisfied = lineCount === undefined || lineCount === 0 || window.text === "" || window.count >= lineCount || window.eof;

      return { text: window.text, satisfied, whole: window.whole };
    }

    let file;

    try { file = await fs.open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if (error.code === "ENOENT") {
        const missing = new Error("no such file: " + targetPath + " (locate it with read using a directory path or source question)");
        missing.code = "ENOENT";
        throw missing;
      }

      throw error;
    }

    try {
      const stat = await file.stat();

      if (!stat.isFile()) throw new Error("read requires a regular file: " + targetPath);
      if (lineCount === 0) {
        if (stat.size === 0) vfs.setCache(targetPath, "");

        return { text: "", satisfied: true, whole: stat.size === 0 };
      }

      const wantedLines = lineCount === undefined ? Infinity : startLine + lineCount - 1;
      const scan = Buffer.alloc(64 * 1024);
      const parts = [];
      let position = 0;
      let linesSeen = 0;
      let started = startLine === 1;
      let startByte = started ? 0 : -1;
      let done = false;
      let doneByte = -1;
      let collected = 0;

      while (position < stat.size && !done && collected <= maxBytes) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(scan, 0, scan.length, position);

        if (bytesRead <= 0) break;
        let begin = 0;

        if (!started) {
          while (begin < bytesRead && linesSeen < startLine - 1) if (scan[begin++] === 10) linesSeen++;
          if (linesSeen < startLine - 1) {
            position += bytesRead;
            continue;
          }
          started = true;
          startByte = position + begin;
        }

        let end = bytesRead;

        if (wantedLines !== Infinity) {
          for (let i = begin; i < bytesRead; i++) {
            if (scan[i] !== 10) continue;
            linesSeen++;
            if (linesSeen === wantedLines) {
              end = i + 1;
              done = true;
              doneByte = position + end;
              break;
            }
          }
        }

        const takeBegin = position === startByte ? begin : Math.max(0, startByte - position);
        const takeEnd = Math.min(end, takeBegin + Math.max(0, maxBytes + 1 - collected));

        if (takeEnd > takeBegin) {
          parts.push(Buffer.from(scan.subarray(takeBegin, takeEnd)));
          collected += takeEnd - takeBegin;
        }

        position += bytesRead;
      }

      if (!started) {
        if (stat.size === 0) vfs.setCache(targetPath, "");

        return { text: "", satisfied: true, whole: stat.size === 0 };
      }
      const text = Buffer.concat(parts, collected).toString("utf8");
      const satisfied = (done && startByte + collected >= doneByte) || startByte + collected >= stat.size;
      const whole = startLine === 1 && startByte === 0 && startByte + collected >= stat.size;

      // Even a bounded window owns a full byte snapshot. The observed stat
      // ties signing to the file version that supplied these window bytes.
      await vfs.recordExpected(targetPath, stat);
      if (whole) vfs.setCache(targetPath, text);

      return { text, satisfied, whole };
    } finally {
      await file.close();
    }
  }

  async function readAdapter(params, signal) {
    signal?.throwIfAborted();
    params = normalizeReadWindow(params);
    if (!isObject(params)) throw new Error("read requires an options object");
    const cwd = getCwd();
    const targetParam = params?.path ?? params?.target;

    if (params?.path !== undefined && params?.target !== undefined && params.path !== params.target) throw new Error("read accepts either path or target, not both");

    if (Array.isArray(targetParam)) {
      if (targetParam.length > 64) throw new Error("read accepts at most 64 paths per batch");

      for (const p of targetParam) if (!isString(p) || !p.trim()) throw new Error("read paths must be non-empty strings");

      const results = await Promise.all(targetParam.map(async p => {
        try {
          const res = await readAdapter({ ...params, path: p, target: undefined }, signal);
          const block = res.content?.[0];
          const item = block?.type === "image" ? block
            : res.details?.directory === true && Array.isArray(res.details.entries) ? res.details.entries
            : block?.text ?? "";

          return { text: item };
        } catch (error) {
          signal?.throwIfAborted();

          return { text: `[read error: ${p}] ${error.message}`, error: { path: p, message: error.message } };
        }
      }));

      signal?.throwIfAborted();
      const response = textResult("", { count: results.length, batch: true, independent: params._independent === true, items: results.map(r => r.text), itemErrors: results.map(r => r.error?.message ?? null), errors: results.filter(r => r.error).map(r => r.error) });
      response.isError = params._independent !== true && results.some(r => r.error);

      return response;
    }

    return reads.schedule("read", () => readSingle(params, cwd, targetParam, signal), signal);
  }

  async function resolveSessionResource(uri, signal) {
    const match = /^(agent|artifact):\/\/([^/?#]+)$/i.exec(uri);

    if (!match) throw new Error("session resource reads support bare agent://<id> and artifact://<number>; use offset/limit for pagination");
    const kind = match[1].toLowerCase();
    const id = decodeURIComponent(match[2]);

    if (!id || id === "." || id === ".." || (/[/\\]/u.test(id) || Array.from(id).some(char => char.charCodeAt(0) < 32)) || (kind === "artifact" && !/^\d+$/.test(id))) throw new Error("invalid session resource ID");
    const dir = hooks.artifactsDir?.();

    if (!isString(dir) || !dir) throw new Error("this host session does not expose an artifacts directory for " + uri);
    signal?.throwIfAborted();
    const root = await fs.realpath(dir);
    let file = id + ".md";

    if (kind === "artifact") {
      const matches = [];
      let count = 0;

      for await (const entry of await fs.opendir(root)) {
        signal?.throwIfAborted();

        if (++count > 4096) throw new Error("session artifact lookup exceeded its directory budget");

        if (entry.name.startsWith(id + ".") && !entry.isDirectory()) matches.push(entry.name);
      }

      if (matches.length !== 1) throw new Error(matches.length ? "ambiguous session artifact: " + uri : "session artifact not found: " + uri);
      file = matches[0];
    }

    const target = await fs.realpath(path.join(root, file));

    if (!target.startsWith(root + path.sep)) throw new Error("session resource escapes its artifacts directory");

    if (!(await fs.stat(target)).isFile()) throw new Error("session resource is not a file: " + uri);
    signal?.throwIfAborted();

    return target;
  }

  async function readSingle(params, cwd, targetParam, signal) {
    params = sessionJsonArgs({ ...params, path: targetParam });
    validateJsonRead(params);
    for (const [key, value] of [["resolve", params.resolve], ["complete", params.complete], ["outline", params.outline], ["evidence", params.evidence]]) {
      if (value !== undefined && typeof value !== "boolean") throw new Error("read " + key + " must be a boolean");
    }

    if (params.about !== undefined && !isString(params.about)) throw new Error("read about must be a string");
    if (params.query !== undefined && !isString(params.query)) throw new Error("read query must be a string");
    const focusModes = [params.about !== undefined, params.query !== undefined, params.outline === true].filter(Boolean).length;

    if (focusModes > 1 || (params.outline === true && params.evidence === true)) throw new Error("read accepts only one of about, query, outline, or evidence");
    if (params.resolve === true && params.complete === true) throw new Error("read accepts either resolve or complete, not both");
    if ((focusModes === 1 || params.evidence === true) && params.complete === true) throw new Error("complete:true requires a raw file read, not a source view");
    targetParam = params.path;

    if (isString(targetParam) && /^(?:agent|artifact):\/\//i.test(targetParam)) {
      if (focusModes || params.evidence === true) throw new Error("session resources do not support about/query/outline/evidence views");
      const target = await resolveSessionResource(targetParam, signal);

      return params.resolve
        ? openSource({status:"found",path:targetParam,line:params.offset ?? 1}, params, signal, target)
        : readFile(target, params, undefined, targetParam, undefined, signal);
    }

    if (params.evidence === true) {
      const query = params.about ?? params.query ?? targetParam;
      const scope = targetParam !== query || looksLikePath(targetParam) ? targetParam : undefined;

      return adapters.evidence({ ...params, query, path: scope }, signal);
    }

    if (isString(params?.query)) {
      const scope = targetParam && targetParam !== params.query ? resolveReadPath(cwd, targetParam) : cwd;

      return sourceRead(params.query, scope, signal, params);
    }

    if (params.outline === true) {
      const targetPath = resolveReadPath(cwd, targetParam);
      const text = await vfs.read(targetPath, { maxBytes: 2 * 1024 * 1024 });
      const outline = extractStructuralSurface(text, path.extname(targetPath));

      return textResult(JSON.stringify(outline, null, 2), { path: targetPath, count: outline.items.length });
    }

    const existing = await probeExistingPath(cwd, targetParam, vfs);

    if (params.resolve === true && isString(params.about) && existing && !existing.directory) {
      throw new Error("resolve:true cannot combine with about on a file; use about for a focused outline or resolve for source text");
    }

    if (existing) {
      if (!existing.directory) {
        if (isString(params.about) && existing.size > 512 * 1024) {
          if (existing.overlay !== undefined) return focusedOverlayText(existing.path, relativeSlash(cwd, existing.path), existing.overlay, params.about, signal);
          return focusedLargeFile(existing.path, relativeSlash(cwd, existing.path), params.about, signal);
        }

        return params.resolve
          ? openSource({ status: "found", path: relativeSlash(cwd, existing.path), line: params.offset ?? 1 }, params, signal)
          : readFile(existing.path, params, undefined, undefined, undefined, signal);
      }

      if (params.json !== undefined) throw new Error("JSON read requires a file, not a directory");

      return isString(params?.about) ? sourceRead(params.about, existing.path, signal, params) : readDirectory(existing.path, signal);
    }

    if (params.json === undefined && !looksLikePath(targetParam)) {
      const scope = isString(params.about) ? resolveReadPath(cwd, targetParam) : cwd;

      return sourceRead(isString(params.about) ? params.about : targetParam, scope, signal, params);
    }
    if (params.resolve === true && params.complete !== true) {
      return textResult(JSON.stringify({ status: "not_found", path: null, line: null, signature: "", confidence: 0, context: [] }), { isSnap: true });
    }
    const targetPath = resolveReadPath(cwd, targetParam);

    return readFile(targetPath, params, undefined, undefined, undefined, signal);
  }

  /** Focus a huge file through rg instead of materializing it just to fold declarations. */
  async function focusedLargeFile(targetPath, rel, about, signal) {
    const tokens = tokenizeQuery(about).tokens;
    const stems = [...new Set(tokens.map(token => stem(token).slice(0, 128)))];

    if (tokens.length > 16) throw new Error("about is too broad; use at most 16 keywords");
    if (!stems.length) throw new Error("about needs at least one searchable keyword");
    const budget = Math.max(1, Math.min(config.maxCallResultChars ?? 65536, config.maxReturnChars ?? 32000) - 256);
    const args = ["rg", "--fixed-strings", "--ignore-case", "--line-number", "--before-context", "3", "--after-context", "3"];

    for (const token of stems) args.push("-e", token);
    args.push("--", targetPath);
    const observed = await fs.stat(targetPath);
    const res = await runCommand(args, { cwd: path.dirname(targetPath), timeoutMs: 15000, maxOutputChars: budget, signal });

    if (res.exitCode === 0 || res.exitCode === 1) await vfs.recordExpected(targetPath, observed);
    if (res.exitCode === 1) return textResult("// " + rel + " · no matching text\n", { path: targetPath, outputTruncated: false, complete: false });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `rg exited ${res.exitCode}`);
    const marker = res.outputTruncated ? "\n[focused read truncated; narrow about or use read(path, line, count)]" : "";

    return textResult("// " + rel + " · focused text windows (not a complete file); read(path, line, count) for raw text\n" + res.stdout + marker,
      { path: targetPath, outputTruncated: res.outputTruncated, complete: false });
  }

  /** Focus a large staged file without materializing another bounded window of its whole text. */
  function focusedOverlayText(targetPath, rel, overlay, about, signal) {
    const { tokens } = tokenizeQuery(about);

    if (tokens.length > 16) throw new Error("about is too broad; use at most 16 keywords");
    const stems = tokens.map(token => stem(token).slice(0, 128));
    const hits = [];
    let line = 1;
    let start = 0;

    while (start <= overlay.length) {
      signal?.throwIfAborted();
      const newline = overlay.indexOf("\n", start);
      const end = newline < 0 ? overlay.length : newline + 1;
      const row = overlay.slice(start, newline < 0 ? end : newline).replace(/\r$/, "");

      if (stems.some(st => row.toLowerCase().includes(st))) {
        hits.push(line);
        if (hits.length >= 200) break;
      }

      if (end === overlay.length) break;
      start = end;
      line++;
    }

    const out = [];
    let cursor = 1;
    let used = 0;
    const budget = Math.max(1, Math.min(config.maxCallResultChars ?? 65536, config.maxReturnChars ?? 32000) - 256);
    let truncated = hits.length >= 200;

    for (const hit of hits) {
      const from = Math.max(cursor, hit - 3);
      const to = hit + 3;
      const first = lineStartIndex(overlay, from);
      const last = lineTextRange(overlay, Math.min(to, line)).end;
      const body = overlay.slice(first, last);

      if (used + body.length > budget) { truncated = true; break; }
      if (out.length && from > cursor) out.push("...");
      out.push(`// ${rel}:${from}\n${body}`);
      used += body.length;
      cursor = Math.max(cursor, to + 1);
    }

    if (!out.length) return textResult("// " + rel + (hits.length
      ? " · matching text exceeds view budget; first match at line " + hits[0] + "; use read(path, line, count)\n"
      : " · no matching staged text\n"), { path: targetPath, outputTruncated: truncated, complete: false });

    const marker = truncated ? "\n[focused read truncated; narrow about or use read(path, line, count)]" : "";

    return textResult("// " + rel + " · focused staged text windows (not a complete file)\n" + out.join("\n") + marker, { path: targetPath, outputTruncated: truncated, complete: false });
  }

  /** Plain text, a line window, or (with `about`) a relevance-folded outline of the whole file. */
  async function readFile(targetPath, params, sourceLine, displayPath, query, signal) {
    const cwd = getCwd();
    const rel = displayPath ?? relativeSlash(cwd, targetPath);

    if (isString(params?.about) && tokenizeQuery(params.about).tokens.length > 16) {
      throw new Error("about is too broad; use at most 16 keywords");
    }

    if (params.json !== undefined) {
      const project = jsonProjector(params.json);
      const text = await vfs.read(targetPath, { maxBytes: MAX_JSON_BYTES, label: "JSON input" });
      let document;

      try { document = JSON.parse(text); }
      catch { throw new Error("invalid JSON in " + rel + "; the entire document must parse before projection"); }

      const many = Array.isArray(params.json);
      const selectors = many ? params.json.map(selector => String(selector)) : [params.json === true ? "." : String(params.json)];
      const budget = Math.max(1, Math.min(config.maxCallResultChars ?? 65536, config.maxReturnChars ?? 32000) - 256) - (many ? params.json.length + 1 : 0);
      let remaining = budget;
      const parts = [];

      try {
        let index = 0;

        for (const value of project(document)) {
          const encoded = JSON.stringify(value);

          if (encoded.length > remaining) {
            throw new Error("JSON selection exceeds the read budget for " + rel + " (" + (selectors[index] ?? "selector") + ": " + encoded.length + " chars, " + remaining + " remaining of " + budget + "); select narrower fields or an array slice such as .items[0:10]");
          }

          remaining -= encoded.length;
          parts.push(encoded);
          index++;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("JSON selection exceeds the read budget")) throw error;
        throw new Error("JSON selection failed for " + rel + " (" + selectors.join(", ") + "): " + (error instanceof Error ? error.message : String(error)));
      }

      return textResult(many ? "[" + parts.join(",") + "]" : parts[0], { path: targetPath, json: true, complete: true });
    }

    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }[path.extname(targetPath).toLowerCase()];

    if (mime) {
      const staged = vfs.getOverlay(targetPath);
      let bytes;

      if (staged !== undefined) {
        const size = Buffer.byteLength(staged, "utf8");

        if (size > 20 * 1024 * 1024) throw new Error("image " + rel + " is " + size + " bytes (" + (size / 1024 / 1024).toFixed(1) + " MiB); the image read limit is 20971520 bytes (20 MiB); resize or select fewer/smaller images");
        bytes = Buffer.from(staged);
      } else {
        let file;

        try { file = await fs.open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
        catch (error) {
          if (error.code === "ENOENT") {
            const missing = new Error("no such file: " + targetPath + " (locate it with read using a directory path or source question)");
            missing.code = "ENOENT";
            throw missing;
          }

          throw error;
        }

        try {
          const stat = await file.stat();

          if (!stat.isFile()) throw new Error("image read requires a regular file: " + targetPath);
          if (stat.size > 20 * 1024 * 1024) throw new Error("image " + rel + " is " + stat.size + " bytes (" + (stat.size / 1024 / 1024).toFixed(1) + " MiB); the image read limit is 20971520 bytes (20 MiB); resize or select fewer/smaller images");
          bytes = await file.readFile({ signal });
          await vfs.recordExpected(targetPath, stat);
        } finally { await file.close(); }
      }

      if (bytes.length > 20 * 1024 * 1024) throw new Error("image " + rel + " is " + bytes.length + " bytes (" + (bytes.length / 1024 / 1024).toFixed(1) + " MiB); the image read limit is 20971520 bytes (20 MiB); resize or select fewer/smaller images");

      return { content: [{ type: "image", mimeType: mime, data: bytes.toString("base64") }], details: { path: targetPath } };
    }

    const explicit = isNumber(params?.offset) || isNumber(params?.limit);
    const budget = Math.max(1, Math.min(config.maxCallResultChars ?? 65536, config.maxReturnChars ?? 32000) - (params.resolve ? 1024 : 256));
    let text;
    let windowed = false;
    let windowSatisfied = true;
    let windowWhole = false;

    const canWindow = params.complete !== true && !isString(params?.about) && !isString(query);

    if (canWindow) {
      const startLine = isNumber(params?.offset) ? Math.max(1, Math.floor(params.offset)) : 1;
      const lineCount = isNumber(params?.limit) ? Math.max(0, Math.floor(params.limit)) : undefined;
      const window = await readWindow(targetPath, startLine, lineCount, budget * 4 + 1024, signal);
      text = window.text;
      windowed = true;
      windowSatisfied = window.satisfied;
      windowWhole = window.whole === true;
    } else {
      text = await vfs.read(targetPath, { maxBytes: 64 * 1024 * 1024 });
    }

    index.touch(rel);

    if (isString(params?.about)) {
      const entry = WorkspaceIndex.fromText(targetPath, text);
      const outline = entry && outlineFile(entry, rel, params.about, outlineOptions(params, await referenceFinder(cwd, targetPath)));

      if (outline) {
        recordOutlineOrigins(rel, outline.text);

        return textResult(outline.text, { path: targetPath, outline: true, expanded: outline.expanded, declarations: outline.declarations });
      }
    }

    let offset = params?.offset;
    let limit = params?.limit;
    let viewComplete;

    if (params.resolve && isString(query)) {
      const spans = WorkspaceIndex.spansOf(WorkspaceIndex.fromText(targetPath, text));
      const span = pickSpan(spans, { line: sourceLine, name: query });

      if (span) {
        const spanLines = span.end - span.start + 1;
        offset = span.start;
        limit = isNumber(params.limit) ? Math.min(params.limit, spanLines) : spanLines;
        viewComplete = limit >= spanLines;
      }
    }

    offset ??= sourceLine && text.length > budget ? Math.max(1, sourceLine - 2) : 1;
    const firstLine = isNumber(offset) ? Math.max(1, Math.floor(offset)) : 1;
    const sliced = windowed ? text : sliceLinesRaw(text, offset, limit);

    if (params.complete === true && (sliced !== text || sliced.length > budget || (params.resolve && JSON.stringify(sliced).length > budget))) {
      throw new Error(`incomplete read of ${rel}: complete:true requires the entire file within the read budget; use json:".field" for JSON reports, about for text selection, edit() for replacements, or reconstruct resolve:true source windows`);
    }

    if (sliced.length > budget || (params.resolve && JSON.stringify(sliced).length > budget) || (windowed && !windowSatisfied)) {
      if (!explicit && !params.resolve && path.extname(targetPath).toLowerCase() === ".json") throw new Error("incomplete JSON read of " + rel + "; use the json selector option to parse the whole document before projection, or explicit offset/limit for raw text windows");
      let cap = budget - 160;

      if (params.resolve) {
        // Budget the actual JSON string, not a pessimistic fixed escape multiplier.
        let low = 0, high = Math.max(0, cap);

        while (low < high) {
          const mid = Math.ceil((low + high) / 2);

          if (JSON.stringify(sliced.slice(0, mid)).length <= budget - 160) low = mid;
          else high = mid - 1;
        }

        cap = low;
      }

      const end = sliced.lastIndexOf("\n", cap);

      if (end < 0) throw new Error(`line ${firstLine} exceeds the read budget; use bash to inspect a bounded substring`);
      const body = sliced.slice(0, end + 1);
      const next = firstLine + body.split("\n").length - 1;
      ledger.recordOrigin(rel, firstLine, sourceLines(body), explicit);

      return textResult(body + `\n[read truncated; continue with read({path:${JSON.stringify(rel)}, offset:${next}})]`, { path: targetPath, outputTruncated: true, nextOffset: next, firstLine, lastLine: next - 1, sourceChars: body.length, complete: false, viewComplete: false });
    }

    const slicedLines = sliced.length <= 512 * 1024 ? sourceLines(sliced) : null;
    const slicedLineCount = slicedLines?.length ?? contentLineInfo(sliced).count;

    if (slicedLines) ledger.recordOrigin(rel, firstLine, slicedLines, explicit);

    return textResult(sliced, { path: targetPath, firstLine, lastLine: firstLine + slicedLineCount - 1, sourceChars: sliced.length, complete: windowed ? windowWhole : sliced === text, viewComplete });
  }

  /**
   * The edit result answers the follow-ups a model would otherwise spend turns on: the post-edit
   * lines with numbers, a quick structural check, and bounded lexical reference hints.
   * These do not replace tests or semantic caller resolution.
   */
  async function editSummary(cwd, target, original, updated, diff, signal, span) {
    const rel = relativeSlash(cwd, target);
    const smallUpdated = updated.length <= 512 * 1024;
    const newLines = smallUpdated ? updated.split("\n") : null;
    const lineCount = newLines ? newLines.length : contentLineInfo(updated).count;
    const lineAt = n => {
      if (newLines) return newLines[n - 1] ?? "";
      const { start, end } = lineTextRange(updated, n);

      return updated.slice(start, end).replace(/\r?\n$/, "");
    };
    const ranges = [];

    if (span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 1 && span.end >= span.start) {
      const end = Math.min(lineCount, span.end);

      if (span.start <= end) ranges.push({ start: span.start, end });
    } else {
      const positions = diff.lines.filter(row => row.type !== "context")
        .map(row => Math.min(lineCount, row.newLineNum ?? row.lineNum)).sort((a, b) => a - b);

      for (const line of positions) {
        const start = Math.max(1, line - 2), end = Math.min(lineCount, line + 2);

        if (ranges.length && start <= ranges.at(-1).end + 1) ranges.at(-1).end = Math.max(ranges.at(-1).end, end);
        else ranges.push({ start, end });
      }
    }

    const blocks = [];
    const perRange = Math.max(1, Math.floor(40 / Math.max(1, ranges.length)));

    for (const { start, end } of ranges) {
      const last = Math.min(end, start + perRange - 1);
      const lines = Array.from({ length: Math.max(0, last - start + 1) }, (_, i) => lineAt(start + i));
      ledger.recordOrigin(rel, start, lines);
      blocks.push("edited " + rel + ":" + start + "-" + last + "\n" + lines.map((line, i) => String(start + i).padStart(5) + " " + line).join("\n"));

      if (last < end) blocks.push("[continue with read({path:" + JSON.stringify(rel) + ",offset:" + (last + 1) + ",limit:" + (end - last) + "})]");
    }

    let out = blocks.join("\n");
    const check = updated.length <= QUICK_CHECK_MAX_CHARS ? quickCheck(updated, path.extname(target)) : null;

    if (check && !check.ok) out += `\ncheck: ${check.message}`;
    const refs = await changedDeclarationRefs(cwd, target, original, updated, diff, signal);

    if (refs) out += `\n${refs}`;

    return out;
  }

  async function changedDeclarationRefs(cwd, target, original, updated, diff, signal) {
    // Diff rows carry the replaced fragments; declarations live on whole file lines.
    // Large-file edits skip owner-span mapping: it duplicates source bodies and can exhaust the guest heap.
    const canMapOwners = original.length <= 512 * 1024 && updated.length <= 512 * 1024;
    const oldLines = canMapOwners ? original.split("\n") : null;
    const newLines = canMapOwners ? updated.split("\n") : null;
    const changedLine = (text, lines, number) => {
      if (lines) return lines[number - 1] ?? "";
      const { start, end } = lineTextRange(text, number);

      return text.slice(start, end).replace(/\r?\n$/, "");
    };
    const names = new Set();
    const spans = new Map();

    for (const l of diff.lines) {
      if (l.type === "context") continue;
      const number = l.type === "remove" ? l.lineNum : l.newLineNum ?? l.lineNum;
      const name = declaredName(changedLine(l.type === "remove" ? original : updated, l.type === "remove" ? oldLines : newLines, number));

      if (name) names.add(name);
      else if (canMapOwners) {
        if (!spans.has(l.type)) spans.set(l.type, WorkspaceIndex.spansOf(WorkspaceIndex.fromText(target, l.type === "remove" ? original : updated)));
        const owner = spans.get(l.type).find(span => span.start <= number && number <= span.end);

        if (owner?.name) names.add(owner.name);
      }

      if (names.size >= 3) break;
    }

    if (names.size === 0) return "";

    try {
      const { references, incomplete } = await referencesForNames({ root: cwd, names: [...names].slice(0, 3),
        excludePath: target, overlayText: file => vfs.getOverlay(file), pendingPaths: vfs.getOverlayPaths(), signal });

      const parts = [];

      for (const [name, refs] of references) {
        if (refs.length) parts.push(name + " also referenced in " + refs.slice(0, 6).join(", ") + (refs.length > 6 ? " (more matches)" : ""));
      }

      if (incomplete) parts.push("references incomplete: search budget reached");

      return parts.join("\n");
    } catch (error) {
      signal?.throwIfAborted();

      return "references unavailable: " + error.message;
    }
  }

  const SOURCE_REF = /((?:\/|[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:m?[jt]sx?|c[jt]s|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|json|ya?ml|toml))(?::|\()(\d+)/g;

  /** Fresh bounded source window for a diagnostic; no index warmup or stale cached bodies. */
  async function sourceWindow(cwd, commandCwd, file, lineNo, signal) {
    const candidate = path.resolve(commandCwd, file);
    let text, rel;

    try {
      const root = await fs.realpath(cwd);
      const cwdPrefix = path.resolve(cwd).endsWith(path.sep) ? path.resolve(cwd) : path.resolve(cwd) + path.sep;
      const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;

      if (!candidate.startsWith(cwdPrefix) && !candidate.startsWith(rootPrefix)) return null;
      const real = await fs.realpath(candidate);
      const handle = await fs.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

      try {
        const stat = await handle.stat();

        if (!real.startsWith(rootPrefix) || !stat.isFile() || stat.size > 1024 * 1024) return null;
        const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        let offset = 0;

        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);

          if (bytesRead <= 0) break;
          offset += bytesRead;
          signal?.throwIfAborted();
        }

        text = buffer.subarray(0, offset).toString("utf8");
      } finally { await handle.close(); }
      rel = relativeSlash(root, real);
    } catch { return null; }

    const raw = text.split("\n");

    if (lineNo < 1 || lineNo > raw.length) return null;
    const start = Math.max(1, lineNo - 2);
    const rows = [];

    for (let l = start; l <= Math.min(raw.length, lineNo + 2); l++) rows.push((l === lineNo ? "►" : " ") + String(l).padStart(4) + " " + raw[l - 1]);
    ledger.recordOrigin(rel, start, rows);

    return rel + ":" + lineNo + "\n" + rows.join("\n");
  }

  /** A failing command names path:line; the model wants those lines next. Attach them (≤4 sites). */
  async function sourceForReferences(cwd, commandCwd, output, signal) {
    const seen = new Set();
    const blocks = [];

    for (const m of output.matchAll(SOURCE_REF)) {
      const key = m[1] + ":" + m[2];

      if (seen.has(key)) continue;

      if (seen.size >= 4) break;
      seen.add(key);
      const block = await sourceWindow(cwd, commandCwd, m[1], Number(m[2]), signal);

      if (block) blocks.push(block);
    }

    return blocks.length ? "\n--- source\n" + blocks.join("\n") : "";
  }

  function outlineOptions(params, references) {
    const options = { references };

    if (Number.isInteger(params?.maxChars) && params.maxChars > 0) options.maxChars = Math.min(params.maxChars, config.maxCallResultChars ?? 65536);

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
    let files;

    try { files = [...new Set([...await index.files(cwd), ...vfs.getOverlayPaths()])]; }
    catch { return () => []; }

    if (!index.canScan(files)) return () => [];

    return (name, excludeLine) => {
      if (!name || name.length < 3) return [];
      const escaped = name.replace(/[$]/g, (c) => "\\" + c);
      const regex = new RegExp("\\b" + escaped + "\\b");

      return index
        .grepRows(files, regex, cwd, file => vfs.getOverlay(file))
        .filter((r) => !(r.line === excludeLine && r.rel === relativeSlash(cwd, targetPath)))
        .map((r) => r.rel + ":" + r.line);
    };
  }

  hooks.summarizeEdit = editSummary;

  const adapters = {
    read: readAdapter,
    async write(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "write", false);

      if (signal?.aborted) throw new Error("aborted");

      if (!isString(params?.content)) throw new Error("write requires string content");

      if (params.append !== undefined && params.append !== true && params.append !== false) throw new Error("write append must be a boolean");
      if (params.allowReadArtifacts !== undefined && typeof params.allowReadArtifacts !== "boolean") throw new Error("write allowReadArtifacts must be a boolean");
      let content = String(params.content);

      if (params.allowReadArtifacts !== true && /\[read truncated;|…\[[^\]\n]*truncated[^\]\n]*\]…/u.test(content)) {
        throw new Error("refusing to write truncated read output; use edit() or reconstruct complete source windows. Set allowReadArtifacts:true only to intentionally write literal truncation-marker text");
      }

      let prevText = "";
      let removedLines;
      let stat;

      try { stat = await fs.stat(target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }

      const overlay = vfs.getOverlay(target);
      const existingBytes = overlay !== undefined ? Buffer.byteLength(overlay, "utf8") : stat?.size;

      if (params.append === true) {
        if (existingBytes > WRITE_APPEND_MAX_READ_BYTES) throw new Error("append input exceeds " + WRITE_APPEND_MAX_READ_BYTES + " bytes; stream it with bash redirection instead");

        try { prevText = overlay !== undefined ? overlay : await vfs.read(target, { maxBytes: WRITE_APPEND_MAX_READ_BYTES, preserveRead: true }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        content = prevText + content;
      } else if (existingBytes !== undefined && existingBytes > WRITE_DIFF_MAX_READ_BYTES) {
        if (overlay === undefined) {
          // Keep the CAS baseline without materializing a huge old body just to draw a receipt.
          await vfs.captureExpected(target);

          try { removedLines = await countContentLines(target, signal); }
          catch (error) { if (error.code !== "ENOENT") throw error; else removedLines = 0; }
        } else {
          removedLines = contentLineInfo(overlay).count;
        }
      } else {
        try { prevText = overlay !== undefined ? overlay : await vfs.read(target, { maxBytes: WRITE_DIFF_MAX_READ_BYTES, preserveRead: true }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }

      const { speculative } = await vfs.write(target, content);
      index.touch(relativeSlash(cwd, target));
      const diff = removedLines === undefined && content.length <= WRITE_DIFF_MAX_READ_BYTES
        ? buildWriteDiff(target, prevText, content)
        : boundedWriteDiff(target, content, removedLines ?? contentLineInfo(prevText).count);
      const tag = speculative ? " (speculative)" : "";
      const check = content.length <= QUICK_CHECK_MAX_CHARS ? quickCheck(content, path.extname(target)) : null;
      const warning = check && !check.ok ? "\ncheck: " + check.message : "";

      return textResult(`wrote ${target}${tag}${warning}`, { path: target, speculative, diff });
    },
    async edit(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "edit", false);

      if (signal?.aborted) throw new Error("aborted");

      const content = await vfs.read(target, { maxBytes: 64 * 1024 * 1024 });

      if (isNumber(params?.viewStart) && isNumber(params?.viewEnd) && isString(params?.viewText) && isString(params?.newText)) {
        const viewText = String(params.viewText);
        const nextText = String(params.newText);
        const windowNext = isString(params.oldText)
          ? applyReplacements(target, viewText, [{ oldText: String(params.oldText), newText: nextText }]).updated
          : nextText;
        const { updated } = applyViewReplace(target, content, params.viewStart, params.viewEnd, viewText, windowNext);
        const { speculative } = await vfs.write(target, updated);
        index.touch(relativeSlash(cwd, target));
        const diffFrom = isString(params.oldText) ? String(params.oldText) : viewText;
        const diffTo = isString(params.oldText) ? nextText : windowNext;
        const localDiff = buildEditDiff(target, viewText, diffFrom, diffTo);
        const diff = shiftDiffLines(localDiff, params.viewStart - 1);
        const inserted = sourceLines(windowNext);
        const spanEnd = params.viewStart + Math.max(inserted.length, 1) - 1;
        const summary = await editSummary(cwd, target, content, updated, diff, signal, { start: params.viewStart, end: spanEnd });

        return textResult(summary, { path: target, speculative, diff });
      }

      const requestedEdits = Array.isArray(params?.edits)
        ? params.edits
        : [{ oldText: params?.oldText, newText: params?.newText }];
      const { updated, matches } = applyReplacements(target, content, requestedEdits);
      const { speculative } = await vfs.write(target, updated);
      index.touch(relativeSlash(cwd, target));

      const diff = content.length > 512 * 1024 || updated.length > 512 * 1024
        ? boundedEditDiff(target, content, matches)
        : matches.length === 1
          ? buildEditDiff(target, content, matches[0].oldText, matches[0].newText)
          : buildMultiEditDiff(target, content, matches);

      const summary = await editSummary(cwd, target, content, updated, diff, signal);

      return textResult(summary, { path: target, speculative, diff });
    },
    async apply_patch(params, signal) {
      const cwd = getCwd();
      let inputPath = params?.path;

      if (!inputPath && isString(params?.patch)) {
        for (const match of params.patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)/gm)) {
          const candidate = match[1].trim().replace(/^[ab]\//, "");

          if (candidate !== "/dev/null") { inputPath = candidate; break; }
        }
      }

      const target = await resolveWorkspacePath(cwd, inputPath, "apply_patch", false);

      if (!isString(params?.patch) || !params.patch.trim()) {
        throw new Error("apply_patch requires patch");
      }

      if (signal?.aborted) throw new Error("aborted");

      let original;

      try {
        original = await vfs.read(target, { maxBytes: 64 * 1024 * 1024, preserveRead: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        original = "";
      }
      if (original.length > 2 * 1024 * 1024) throw new Error("apply_patch input exceeds 2 MiB; use edit() for targeted replacements");
      const { resultText, hunkCount } = applyPatchToText(original, params.patch);
      const { speculative } = await vfs.write(target, resultText);
      const diff = buildPatchDiff(target, params.patch);
      index.touch(relativeSlash(cwd, target));
      const summary = await editSummary(cwd, target, original, resultText, diff, signal);

      return textResult(summary, {
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
        overlayText: (p) => vfs.getOverlay(p),
        pendingPaths: vfs.getOverlayPaths(),
        signal,
      });

      return textResult(JSON.stringify(res, null, 2), res);
    },
    async evidence(params, signal) {
      const cwd = getCwd();

      if (!isString(params?.query) || !params.query.trim()) throw new Error("evidence requires query");
      if (tokenizeQuery(params.query).tokens.length > 16) throw new Error("evidence query is too broad; use at most 16 keywords");

      if (signal?.aborted) throw new Error("aborted");
      const searchDir = params?.path ? await resolveWorkspacePath(cwd, params.path, "evidence", true) : cwd;
      const options = {};

      if (Number.isInteger(params?.k) && params.k > 0) options.k = Math.min(params.k, 20);

      if (Number.isInteger(params?.maxChars) && params.maxChars > 0) options.maxChars = Math.min(params.maxChars, config.maxCallResultChars ?? 65536);
      const res = await selectEvidence({ query: params.query, root: cwd, searchDir, index, overlayText: (p) => vfs.getOverlay(p), pendingPaths: vfs.getOverlayPaths(), options });

      for (const span of res.spans) ledger.recordOrigin(span.path, span.lines[0], span.text.split("\n"));

      return textResult(JSON.stringify(res), { route: res.route, count: res.spans.length });
    },
    async surface(params, signal) {
      const cwd = getCwd();
      const target = await resolveWorkspacePath(cwd, params?.path, "surface", false);

      if (signal?.aborted) throw new Error("aborted");
      const text = await vfs.read(target, { maxBytes: 2 * 1024 * 1024 });
      const ext = path.extname(target);
      const outline = extractStructuralSurface(text, ext);

      return textResult(JSON.stringify(outline, null, 2), { path: target, count: outline.items.length });
    },
    async bash(params, signal) {
      const cwd = getCwd();
      const literal = Array.isArray(params?.args) && process.platform !== "win32" && params.args.length === Object.keys(params.args).length && params.args.every(isString);

      if (params?.command !== undefined && !isString(params.command)) throw new Error("bash command must be a string");
      if (literal && (!isString(params.command) || !Array.isArray(params.args) || params.args.some(arg => !isString(arg)))) throw new Error("bash argv requires a command string and an array of string args");
      const command = literal ? String(params.command) : unwrapIfFullyQuoted(String(params?.command ?? "").trim());

      if (!command.trim()) throw new Error("bash requires command");
      const targetCwd = params?.cwd ? await resolveWorkspacePath(cwd, params.cwd, "bash cwd", true) : cwd;

      // String commands keep shell semantics; literal argv needs no quoting or shell startup.
      const argv = literal ? [command, ...params.args] : ["bash", "-c", command];

      const transactionBarrier = await vfs.prepareExternalMutation("bash");
      let res;

      try {
        res = await runCommand(argv, {
          cwd: targetCwd,
          env: hooks.commandEnv(),
          commandLabel: literal ? command : undefined,
          timeoutMs: params?.timeoutMs,
          signal,
          maxOutputChars: config.maxCallResultChars,
        });
      } catch (error) {
        if (!signal?.aborted) error.message += await sourceForReferences(cwd, targetCwd, error.message, signal);
        throw error;
      } finally {
        vfs.invalidateCache();
        index.invalidate();
        clearPathCache();
        hooks.workspaceChanged();
      }

      const { stdout, stderr } = res;
      let text = stdout && stderr ? stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr : stdout || stderr;

      if (res.exitCode !== 0) text += await sourceForReferences(cwd, targetCwd, text, signal);

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
      const indexed = await grepIndexed(index, pattern, params, searchPath, cwd, file => vfs.getOverlay(file), vfs.getOverlayPaths());

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
      const fuzzy = await fuzzyFind(index, cwd, cwd, pattern, 20, vfs.getOverlayPaths());

      if (fuzzy !== null) return textResult(fuzzy, { via: "fuzzy" });
      const indexed = await listIndexed(index, cwd, cwd, pattern, vfs.getOverlayPaths());

      if (indexed !== null) return textResult(indexed, { via: "index" });

      return listWithTools(cwd, pattern, cwd, signal, vfs.getOverlayPaths());
    },
    async find(params, signal) {
      const cwd = getCwd();
      const searchDir = params?.path ? await resolveWorkspacePath(cwd, params.path, "find", true) : cwd;
      const pattern = params?.pattern || params?.glob;

      if (signal?.aborted) throw new Error("aborted");
      const globPattern = pattern ? String(pattern) : null;
      const fuzzy = await fuzzyFind(index, searchDir, cwd, globPattern, 20, vfs.getOverlayPaths());

      if (fuzzy !== null) return textResult(fuzzy, { via: "fuzzy" });
      const indexed = await listIndexed(index, searchDir, cwd, globPattern, vfs.getOverlayPaths());

      if (indexed !== null) return textResult(indexed, { via: "index" });

      return listWithTools(searchDir, globPattern, cwd, signal, vfs.getOverlayPaths());
    },
    async ls(params, signal) {
      const cwd = getCwd();
      const dirPath = params?.path ? await resolveWorkspacePath(cwd, params.path, "ls", true) : cwd;
      const pending = vfs.getOverlay(dirPath);

      if (pending !== undefined) {
        const entry = formatDirectoryEntry(path.basename(dirPath), "file", Buffer.byteLength(pending, "utf8"));

        return textResult(entry, { path: dirPath, directory: false, count: 1, entries: [entry] });
      }
      const stat = await fs.stat(dirPath).catch(() => null);

      if (stat?.isFile()) {
        const entry = formatDirectoryEntry(path.basename(dirPath), "file", stat.size);

        return textResult(entry, { path: dirPath, directory: false, count: 1, entries: [entry] });
      }

      return readDirectory(dirPath, signal);
    },
  };

  return adapters;
}

/**
 * Fused INVOKE kernel. Guest RPC is the only caller; fuel is cwd + vfs + signal.
 * BIND stays downward (see tests/contracts/layers.test.mjs). Do not split this
 * closure into pass-through files that re-import each other.
 */
export function createHostBridge({ pi, config, getCwd, registry, ledger: runLedger, budget }) {
  const index = registry?.index ?? new WorkspaceIndex((argv, opts) => runCommand(argv, opts));
  const ledger = runLedger ?? new SeenLedger({ window: config.seenWindow ?? 0 });

  const vfs = new CausalVfs(paths => {
    index.invalidate();
    notifyWorkspaceChanged(paths);
  }, target => resolveWorkspacePath(getCwd(), target, "commit", false, true));

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

  // Advisory host event, not a tool or a transaction participant. Consumers
  // invalidate synchronously; failures must never affect committed bytes.
  function notifyWorkspaceChanged(paths = null) {
    if (!isFunction(pi?.events?.emit)) return;

    const event = Object.freeze({
      version: 1, cwd: path.resolve(getCwd()),
      paths: paths === null ? null : Object.freeze([...new Set(paths)]),
    });

    try { pi.events.emit("workspace:changed", event)?.catch?.(() => {}); } catch {}
  }

  hooks.workspaceChanged = notifyWorkspaceChanged;
  hooks.artifactsDir = () => activeCtx?.sessionManager?.getArtifactsDir?.();
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
    let sessions = [];

    try { sessions = registry?.list?.() ?? []; } catch {}
    if (!Array.isArray(sessions)) sessions = [];
    hostSession = sessionId
      ? sessions.map(ref => ref.session).find(session => !session?.isDisposed && session?.sessionManager?.getSessionId?.() === sessionId) ?? null
      : null;
    activeSignal = signal;
    vfs.signal = signal;
  }

  function evalToolNames() {
    try { return hostSession?.getEvalBridgeToolNames?.() ?? []; }
    catch { return []; }
  }

  function hostTool(name) {
    if (!hostSession) return undefined;
    const metadata = definitions.get(name);

    // Keep Supernova's transactional adapters for ordinary built-ins. Respect overrides.
    if (Object.hasOwn(natives, name) && metadata?.sourceInfo?.source === "builtin") return undefined;

    try { return hostSession.getToolForEvalBridge?.(name); }
    catch { return undefined; }
  }

  function isCallable(name) {
    if (name === "supernova" || (config.excludeTools ?? []).includes(name)) return false;

    if (hostSession && (hostSession.isDisposed || hostSession.sessionManager?.getSessionId?.() !== boundSessionId)) return false;

    // An internal adapter belongs to Supernova, not the host's visible tool list.
    const nativeOwned = Object.hasOwn(natives, name) && !executors.has(name)
      && (!hostSession || !definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin");

    if (nativeOwned) return true;

    if (hostSession) {
      const evalNames = evalToolNames();

      if (!evalNames.includes(name) && definitions.has(name)) return false;

      return !!hostTool(name) || (Object.hasOwn(natives, name) && (!definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin"));
    }

    let activeTools;

    try { activeTools = isFunction(pi?.getActiveTools) ? pi.getActiveTools() : undefined; } catch {}

    if (definitions.has(name) && Array.isArray(activeTools) && !activeTools.includes(name)) return false;

    return executors.has(name) || Object.hasOwn(natives, name);
  }

  function refreshTools() {
    let listed = [];

    try { listed = pi?.getAllTools?.() ?? []; } catch {}
    const tools = Array.isArray(listed) ? listed : [];

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

  function notifyCall(record) {
    if (!callListener) return;

    try {
      callListener(record, [...trace]);
    } catch {}
  }

  function checkCallBudget(name) {
    if (closed) throw new Error("program is already complete");
    const maxCalls = config.maxBridgeCalls ?? 256;

    if (budget && ++budget.calls > maxCalls) throw new Error("host call budget exceeded (" + maxCalls + " calls per program batch): split the batch");
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
    let removedLines;
    let stat;

    try { stat = await fs.stat(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    const overlay = vfs.getOverlay(target);
    const existingBytes = overlay !== undefined ? Buffer.byteLength(overlay, "utf8") : stat?.size;

    if (existingBytes !== undefined && existingBytes > WRITE_DIFF_MAX_READ_BYTES) {
      if (overlay === undefined) {
        await vfs.captureExpected(target);

        try { removedLines = await countContentLines(target, activeSignal); }
        catch (error) { if (error.code !== "ENOENT") throw error; else removedLines = 0; }
      } else {
        removedLines = contentLineInfo(overlay).count;
      }
    } else {
      try {
        previous = overlay !== undefined ? overlay : await vfs.read(target, { maxBytes: WRITE_DIFF_MAX_READ_BYTES, preserveRead: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    return removedLines === undefined ? buildWriteDiff(target, previous, args.content) : boundedWriteDiff(target, args.content, removedLines);
  }

  function completeRecord(record, res, fallbackDiff) {
    const diff = resultDiff(res) || fallbackDiff;
    finishRecord(record, res);

    if (diff && record.ok) record.diff = diff;
    notifyCall(record);
  }

  function traceArgs(args) {
    if (!isObject(args)) return {};
    const out = {};

    for (const key of ["path", "target", "query", "pattern", "command", "cwd", "glob", "action", "op"]) {
      const value = args[key];

      if (isString(value)) out[key] = truncateChars(value, 240, "trace").text;
      else if (Array.isArray(value)) out[key] = value.slice(0, 128).map(item => isString(item) ? truncateChars(item, 240, "trace").text : typeof item);
    }

    if (isString(args.content)) out.content = args.content.length + " chars";
    if (Array.isArray(args.edits)) out.edits = args.edits.length + " edits";
    if (Array.isArray(args.args)) out.args = args.args.length + " argv";

    return out;
  }

  async function invokeRaw(name, args) {
    checkCallBudget(name);
    const callId = ++sharedRegistry.callSeq;
    assertCallableTarget(name);

    if (!isCallable(name)) throw new Error(unknownToolMessage(name, [...definitions.keys(), ...Object.keys(natives)].filter(isCallable)));

    const command = { apply_patch: "edit", surface: "read", evidence: "read", snap: "read" }[name] ?? name;
    const record = { name: command, adapter: name, args: traceArgs(args), time: Date.now() };
    trace.push(record);
    notifyCall(record);

    try {
      const delegated = hostTool(name);
      const exec = delegated ? delegated.execute.bind(delegated) : hostSession ? undefined : executors.get(name);
      const argvOwned = name === "bash" && Array.isArray(args?.args) && process.platform !== "win32" && args.args.length === Object.keys(args.args).length && args.args.every(isString);
      // Explicit overrides own all reads. Options, even false-valued ones,
      // must not silently bypass the host executor.
      if (exec && !argvOwned) {
        if (name === "read" && (args?.json !== undefined || /^(agent|artifact):\/\/.*\?/i.test(String(args?.path)))) throw new Error("JSON projection requires the Supernova-owned read adapter, not an external override");

        if (name === "write" && args?.append === true) throw new Error("append requires the Supernova-owned write adapter, not an external override");
        const fallbackDiff = await writeFallbackDiff(name, args);
        const mutating = isMutatingTool(name, config, args, definitions.get(name));

        if (mutating) await vfs.prepareExternalMutation(name);

        if (activeSignal?.aborted || closed) throw new Error("aborted");

        if (!isCallable(name)) throw new Error("tool is no longer enabled in this session: " + name);

        try {
          const res = await exec(`supernova:${name}:${callId}`, args || {}, activeSignal, undefined, delegated
            ? { ...activeCtx, settings: hostSession.settings, toolNames: evalToolNames(), autoApprove: false }
            : activeCtx);

          completeRecord(record, res, fallbackDiff);

          return res;
        } finally {
          if (mutating) { vfs.invalidateCache(); index.invalidate(); clearPathCache(); notifyWorkspaceChanged(); }
        }
      }

      const native = Object.hasOwn(natives, name) ? natives[name] : undefined;

      if (native) {
        const res = await native(argvOwned ? { ...(args || {}), args: args.args.map(String) } : args || {}, activeSignal);
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
    const text = isObject(res) && Array.isArray(res.content)
      ? res.content.filter(part => part?.type === "text" && isString(part.text)).map(part => part.text).join("\n")
      : undefined;

    if (text) record.resultText = truncateChars(text, 4096, "trace").text;
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
    // Windows command shims need shell handling; preserve the existing route there.
    supportsNativeArgv: () => process.platform !== "win32" && !hostTool("bash") && !executors.has("bash"),
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
      return createHostBridge({ pi, config, getCwd: options.getCwd, registry: sharedRegistry, ledger: ledger.fork(), budget: options.budget });
    },
    close() { closed = true; vfs.closed = true; },
    bindCallContext,
    resetCallBudget,
    getTrace,
    getMutations: () => ({ ...vfs.mutations }),
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
