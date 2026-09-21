import * as fs from "node:fs/promises";
import { decodeUtf8Strict, decodeUtf8Window } from "../shared/utf8.js";
import { sliceLinesRawInfo } from "./lines.js";
import { fileChunks, remapReadError } from "./file-io.js";

/** Advance through newline-delimited bytes without decoding or retaining skipped data. */
function advanceLines(bytes, start, remaining) {
  while (remaining > 0) {
    const newline = bytes.indexOf(10, start);
    if (newline < 0) return { offset: bytes.length, remaining };
    start = newline + 1;
    remaining--;
  }
  return { offset: start, remaining };
}

async function scanWindow(file, stat, startLine, lineCount, maxBytes, signal) {
  const scan = { parts: [], collected: 0, startByte: undefined, endByte: undefined };
  let skip = startLine - 1, take = lineCount ?? Infinity, position = 0;
  for await (const chunk of fileChunks(file, signal, stat.size)) {
    const head = advanceLines(chunk, 0, skip);
    skip = head.remaining;
    const start = position;
    position += chunk.length;
    if (skip) continue;
    scan.startByte ??= start + head.offset;
    const tail = advanceLines(chunk, head.offset, take);
    take = tail.remaining;
    if (take === 0) scan.endByte = start + tail.offset;
    const end = Math.min(tail.offset, head.offset + maxBytes + 1 - scan.collected);
    if (end > head.offset) {
      scan.parts.push(Buffer.from(chunk.subarray(head.offset, end)));
      scan.collected += end - head.offset;
    }
    if (take === 0 || scan.collected > maxBytes) break;
  }
  return scan;
}

function overlayWindow(overlay, startLine, lineCount) {
  const window = sliceLinesRawInfo(overlay, startLine, lineCount);
  const satisfied = lineCount === undefined || lineCount === 0 || window.text === "" || window.count >= lineCount || window.eof;
  return { text: window.text, satisfied, whole: window.whole };
}

async function openReadFile(target) {
  try { return await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
  catch (error) { remapReadError(error, target); }
}

export function createWindowReader(vfs) {
  return async function readWindow(target, startLine, lineCount, maxBytes, signal) {
    const overlay = vfs.getOverlay(target);
    if (overlay !== undefined) {
      const window = overlayWindow(overlay,startLine,lineCount);
      window.satisfied &&= Buffer.byteLength(window.text,"utf8") <= maxBytes;
      return window;
    }
    const file = await openReadFile(target);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("read requires a regular file: " + target);
      if (lineCount === 0) return { text: "", satisfied: true, whole: stat.size === 0 };
      const scan = await scanWindow(file, stat, startLine, lineCount, maxBytes, signal);
      if (scan.startByte === undefined) return { text: "", satisfied: true, whole: stat.size === 0 };
      const bytes = Buffer.concat(scan.parts, scan.collected);
      const end = scan.startByte + scan.collected;
      const eof = end >= stat.size;
      const text = eof ? decodeUtf8Strict(bytes, target) : decodeUtf8Window(bytes);
      await vfs.recordExpected(target, stat);
      return { text, satisfied: end >= scan.endByte || eof, whole: startLine === 1 && scan.startByte === 0 && eof };
    } finally { await file.close(); }
  };
}
