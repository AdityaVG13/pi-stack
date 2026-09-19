import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { isString, isNumber, isObject } from "../shared/decode.js";
import { assertFilesystemPath } from "./workspace.js";
import { MAX_DIFF_MATCHES } from "./diff.js";

const JSON_TWO_BYTE = new Set([0x22, 0x5c, 8, 9, 10, 12, 13]);

function jsonAsciiWidth(c) {
  if (JSON_TWO_BYTE.has(c)) return 2;

  if (c < 32) return 6;

  return 1;
}

function jsonUnitWidth(s, i) {
  const c = s.charCodeAt(i);

  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);

    if (d >= 0xDC00 && d <= 0xDFFF) return { add: 2, skip: 2 };

    return { add: 6, skip: 1 };
  }

  if (c >= 0xD800 && c <= 0xDFFF) return { add: 6, skip: 1 };

  return { add: jsonAsciiWidth(c), skip: 1 };
}

/** UTF-16 length of JSON.stringify(s) for a string, without allocating the JSON. */
export function jsonStringLength(s) {
  let n = 2;

  for (let i = 0; i < s.length; ) {
    const unit = jsonUnitWidth(s, i);
    n += unit.add;
    i += unit.skip;
  }

  return n;
}

/** Largest prefix whose JSON.stringify length is <= limit. */
export function maxJsonStringPrefix(s, limit) {
  let used = 2;
  let i = 0;

  while (i < s.length) {
    const unit = jsonUnitWidth(s, i);

    if (used + unit.add > limit) break;
    used += unit.add;
    i += unit.skip;
  }

  return i;
}

export function textResult(text, details) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details: details || {},
  };
}

export function resultDiff(response) {
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
export function unwrapIfFullyQuoted(s) {
  if (s.length < 2) return s;
  const q = s[0];

  if (q !== "'" && q !== '"') return s;

  if (s[s.length - 1] !== q) return s;
  const inner = s.slice(1, -1);

  if (inner.includes(q)) return s;

  return inner;
}

function totalContentLines(text) {
  if (text === "") return 1;

  return contentLineInfo(text).count + (text.endsWith("\n") ? 1 : 0);
}

function emptySliceInfo(text, totalLines) {
  return { text: "", end: totalLines, total: totalLines, count: 0, eof: true, whole: totalLines === 1 && text === "" };
}

function sliceWindow(text, startIndex, count, totalLines) {
  const endExclusive = Math.min(totalLines, startIndex + count);
  const start = lineStartIndex(text, startIndex + 1);
  const end = lineEndIndex(text, start, endExclusive - startIndex);
  let selected = text.slice(start, end);
  const eof = endExclusive >= totalLines || (endExclusive === totalLines - 1 && text.endsWith("\n"));

  if (endExclusive < totalLines && !selected.endsWith("\n")) selected += "\n";

  return { text: selected, end: endExclusive, total: totalLines, count: endExclusive - startIndex, eof, whole: startIndex === 0 && eof };
}

export function sliceLinesRawInfo(text, offset, limit) {
  const totalLines = totalContentLines(text);

  if (!isNumber(offset) && !isNumber(limit)) {
    return { text, end: totalLines, total: totalLines, count: totalLines, eof: true, whole: true };
  }

  const startIndex = (isNumber(offset) ? Math.max(1, Math.floor(offset)) : 1) - 1;
  const count = isNumber(limit) ? Math.max(0, Math.floor(limit)) : totalLines;

  if (count === 0 || startIndex >= totalLines) return emptySliceInfo(text, totalLines);

  return sliceWindow(text, startIndex, count, totalLines);
}

/** Read-window slicing preserves the selected lines' own line ending. */
export function sliceLinesRaw(text, offset, limit) {
  return sliceLinesRawInfo(text, offset, limit).text;
}

export function readLineParam(value, name) {
  if (value === undefined) return undefined;
  const number = isNumber(value) ? value : isString(value) && value.trim() !== "" ? Number(value) : NaN;

  if (!Number.isFinite(number)) throw new Error("read " + name + " must be a finite number");

  return Math.floor(number);
}

export function normalizeReadWindow(params) {
  if (!isObject(params)) return params;
  const normalized = { ...params };
  const offset = readLineParam(params.offset, "offset");
  const limit = readLineParam(params.limit, "limit");

  if (offset !== undefined) normalized.offset = Math.max(1, offset);
  if (limit !== undefined) normalized.limit = Math.max(0, limit);

  return normalized;
}

export function resolveReadPath(cwd, target) {
  if (!isString(target) || !target.trim()) throw new Error("read requires path");
  const input = assertFilesystemPath(target, "read");

  return path.resolve(cwd, input === "~" ? homedir() : input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input);
}

export async function probeExistingPath(cwd, targetParam, vfs) {
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

export const EDIT_PREVIEW_LINES = 16;

export const MAX_DIRECTORY_ENTRIES = 10000;

export function sourceLines(content) {
  const raw = content.split("\n");

  if (raw.at(-1) === "") raw.pop();

  return raw;
}

export function lineNumberAt(content, index) {
  let line = 1;

  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;

  return line;
}

export function formatNumberedLine(n, text) {
  return String(n).padStart(5) + " " + text;
}

export function numberedPreview(content, cap = EDIT_PREVIEW_LINES) {
  const { count, preview } = contentLineInfo(content, cap);

  if (count === 0) return "0 lines";
  const body = preview.map((line, i) => formatNumberedLine(i + 1, line)).join("\n");
  const suffix = count + " lines total";

  return body + "\n" + suffix;
}

function lineAt(content, n) {
  const range = lineTextRange(content, n);

  return content.slice(range.start, range.end).replace(/\r?\n$/, "");
}

function duplicateEditError(target, content, index, second) {
  const a = lineNumberAt(content, index);
  const b = lineNumberAt(content, second);

  return new Error("edit target is not unique in " + target + ": lines " + a + " and " + b + "; include more surrounding lines in oldText, or pass edits:[{oldText,newText},…]\n" + formatNumberedLine(a, lineAt(content, a)) + "\n" + formatNumberedLine(b, lineAt(content, b)));
}

/** Exact bytes at the closest guess: a byte-for-byte miss is usually indentation drift. */
function nearMissPreview(content, oldText) {
  const first = String(oldText).split("\n").find(line => line.trim().length > 0);

  if (!first) return null;
  const at = content.indexOf(first.trim());

  if (at < 0) return null;
  const line = lineNumberAt(content, at);
  const start = Math.max(1, line - 2);
  const from = lineStartIndex(content, start);
  const shown = content.slice(from, lineEndIndex(content, from, Math.min(5, line - start + 3))).replace(/\r?\n$/, "");

  return "first oldText line matches line " + line + " only after trimming; exact bytes there:\n"
    + shown.split("\n").map((text, index) => formatNumberedLine(start + index, text)).join("\n");
}
function matchReplacement(target, content, replacement) {
  if (!isString(replacement?.oldText) || replacement.oldText.length === 0) {
    throw new Error("edit requires non-empty oldText");
  }

  if (!isString(replacement?.newText)) throw new Error("edit requires newText");
  const oldText = String(replacement.oldText);
  const newText = String(replacement.newText);
  const index = content.indexOf(oldText);

  if (index < 0) {
    throw new Error("edit target not found in " + target + ": oldText must match the file byte-for-byte\n" + (nearMissPreview(content, oldText) ?? numberedPreview(content)));
  }
  const second = content.indexOf(oldText, index + 1);

  if (second >= 0) throw duplicateEditError(target, content, index, second);

  return { ...replacement, oldText, newText, index, end: index + oldText.length };
}

function assertNoOverlap(target, matches) {
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].index < matches[i - 1].end) throw new Error(`edit targets overlap in ${target}`);
  }
}

export function applyReplacements(target, content, requestedEdits) {
  if (requestedEdits.length === 0) throw new Error("edit requires at least one replacement");
  const matches = requestedEdits.map((replacement, index) => {
    try { return matchReplacement(target, content, replacement); }
    catch (error) {
      // Name the failing entry: a multi-edit miss is otherwise a guessing game.
      throw requestedEdits.length === 1 ? error : new Error("edit " + (index + 1) + " of " + requestedEdits.length + ": " + error.message);
    }
  });
  matches.sort((a, b) => a.index - b.index);
  assertNoOverlap(target, matches);
  let updated = content;

  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    updated = updated.slice(0, match.index) + match.newText + updated.slice(match.end);
  }

  return { updated, matches };
}

export function lineStartIndex(content, line) {
  let index = 0;

  for (let current = 1; current < line; current++) {
    const next = content.indexOf("\n", index);

    if (next < 0) return content.length;
    index = next + 1;
  }

  return Math.min(index, content.length);
}

export function lineEndIndex(content, startIndex, lineCount) {
  let index = startIndex;

  for (let i = 0; i < lineCount; i++) {
    const next = content.indexOf("\n", index);

    if (next < 0) return content.length;
    index = next + 1;
  }

  return index;
}

export function lineTextRange(content, line) {
  const start = lineStartIndex(content, line);

  return { start, end: lineEndIndex(content, start, 1) };
}

export function shiftDiffLines(diff, delta) {
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

function suffixSeparator(content, endIndex) {
  return content.slice(Math.max(0, endIndex - 2), endIndex) === "\r\n" ? "\r\n" : "\n";
}

function withLineEnding(insert, ending) {
  if (insert !== "" && !insert.endsWith("\n")) return insert + ending;

  return insert;
}

function viewInsertText(content, startIndex, endIndex, newText) {
  const hasSuffix = endIndex < content.length;
  // A view replaces whole source lines. Preserve the separator before following
  // lines, but let an explicit trailing newline change a no-trailing-newline EOF.
  if (hasSuffix) return content.slice(0, startIndex) + withLineEnding(newText, suffixSeparator(content, endIndex)) + content.slice(endIndex);
  const insert = content.endsWith("\n") ? withLineEnding(newText, content.endsWith("\r\n") ? "\r\n" : "\n") : newText;

  return content.slice(0, startIndex) + insert + content.slice(endIndex);
}

function assertViewRange(target, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error("edit requires a valid view range in " + target);
  }
}

export function applyViewReplace(target, content, start, end, oldText, newText) {
  assertViewRange(target, start, end);
  const current = sliceLinesRaw(content, start, end - start + 1);

  if (current !== oldText) {
    const shown = current.length ? current : content;

    throw new Error("edit view is stale in " + target + ": lines " + start + "-" + end + " changed\n" + numberedPreview(shown));
  }

  const startIndex = lineStartIndex(content, start);
  const endIndex = lineEndIndex(content, startIndex, Math.max(0, end - start + 1));

  return { updated: viewInsertText(content, startIndex, endIndex, newText), oldText, newText };
}

export const WRITE_DIFF_MAX_READ_BYTES = 512 * 1024;
export const WRITE_APPEND_MAX_READ_BYTES = 64 * 1024 * 1024;
export const QUICK_CHECK_MAX_CHARS = 2 * 1024 * 1024;

async function snapshotLargeFile(vfs, target, overlay, signal) {
  if (overlay !== undefined) return contentLineInfo(overlay).count;
  await vfs.captureExpected(target);

  try { return await countContentLines(target, signal); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;

    return 0;
  }
}

async function snapshotSmallFile(vfs, target, overlay) {
  // Diff/receipt snapshot only: a lossy decode is acceptable and must not block a replace.
  try { return overlay !== undefined ? overlay : await vfs.read(target, { maxBytes: WRITE_DIFF_MAX_READ_BYTES, preserveRead: true, strict: false }); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;

    return "";
  }
}

async function existingStat(target) {
  try { return await fs.stat(target); }
  catch (error) {
    if (error.code === "ENOTDIR") throw new Error("cannot use path: a parent component of " + target + " is a file, not a directory");

    if (error.code !== "ENOENT") throw error;
  }
}

/** Prior body (or line count) for a write receipt / CAS, without always materializing huge files. */
export async function writeSnapshot(vfs, target, signal) {
  const stat = await existingStat(target);
  const overlay = vfs.getOverlay(target);
  const existingBytes = overlay !== undefined ? Buffer.byteLength(overlay, "utf8") : stat?.size;

  if (existingBytes !== undefined && existingBytes > WRITE_DIFF_MAX_READ_BYTES) {
    return { previous: "", removedLines: await snapshotLargeFile(vfs, target, overlay, signal), overlay, existingBytes };
  }

  return { previous: await snapshotSmallFile(vfs, target, overlay), removedLines: undefined, overlay, existingBytes };
}

export async function countContentLines(target, signal) {
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

export function contentLineInfo(text, previewLimit = 0) {
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

export function boundedEditDiff(target, original, matches) {
  const rendered = matches.slice(0, MAX_DIFF_MATCHES);
  const lines = [];
  let shift = 0;
  let added = 0;
  let removed = 0;

  for (const match of matches) {
    removed += contentLineInfo(match.oldText).count;
    added += contentLineInfo(match.newText).count;
  }

  for (const match of rendered) {
    const oldInfo = contentLineInfo(match.oldText, 32);
    const newInfo = contentLineInfo(match.newText, 32);
    const start = lineNumberAt(original, match.index);
    const nextStart = start + shift;

    for (let i = 0; i < oldInfo.preview.length; i++) lines.push({ type: "remove", lineNum: start + i, newLineNum: nextStart + i, text: oldInfo.preview[i] });
    for (let i = 0; i < newInfo.preview.length; i++) lines.push({ type: "add", lineNum: nextStart + i, newLineNum: nextStart + i, text: newInfo.preview[i] });

    shift += newInfo.newlines - oldInfo.newlines;
  }

  return { path: target, op: "edit", added, removed, lines, omittedMatches: matches.length - rendered.length };
}

export function boundedWriteDiff(target, content, removed) {
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

export function formatDirectoryEntry(name, type, size = 0) {
  const sizeSuffix = size ? `, ${size} bytes` : "";

  return `${name}${type === "dir" ? "/" : ""} (${type}${sizeSuffix})`;
}

export async function formatLsEntry(dirPath, entry) {
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
