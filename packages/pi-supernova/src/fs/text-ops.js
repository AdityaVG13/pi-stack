import { fileChunks } from "./file-io.js";
export {MAX_DIRECTORY_ENTRIES,formatDirectoryEntry,formatLsEntry} from './directory.js';
export {textResult,resultDiff} from '../shared/result.js';
import {sliceLinesRaw,lineNumberAt,formatNumberedLine,numberedPreview,lineStartIndex,lineEndIndex,lineTextRange,contentLineInfo} from './lines.js';
export * from './lines.js';
export {jsonStringLength,maxJsonStringPrefix} from './json-size.js';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { isString, isNumber, isObject } from "../shared/decode.js";
import { assertFilesystemPath } from "./workspace.js";
import { MAX_DIFF_MATCHES } from "./diff.js";

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

    for await (const chunk of fileChunks(file, signal)) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
      last = chunk.at(-1);
      total += chunk.length;
    }

    return total === 0 ? 0 : newlines + (last === 10 ? 0 : 1);
  } finally { await file.close(); }
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
