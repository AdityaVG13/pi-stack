import {isNumber} from '../shared/decode.js';

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

export function lineStartIndex(content, line) {
  return lineEndIndex(content, 0, line - 1);
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

export function contentLineInfo(text, previewLimit = 0) {
  if (text === "") return { count: 0, preview: [], newlines: 0 };
  const preview = [];
  let count = 0;
  let start = 0;

  do {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;

    if (preview.length < previewLimit) preview.push(text.slice(start, end).replace(/\r$/, ""));
    count++;
    if (newline < 0) break;
    start = newline + 1;
  } while (start < text.length);

  return { count, preview, newlines: count - Number(!text.endsWith("\n")) };
}

export const EDIT_PREVIEW_LINES = 16;
