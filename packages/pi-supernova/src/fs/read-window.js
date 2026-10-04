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

async function scanWindow(file, startLine, lineCount, maxBytes, signal) {
  const scan = { parts: [], collected: 0, startByte: undefined, endByte: undefined, readBytes: 0, eof: false };
  // Empty windows need an emptiness probe, not a seek to the requested line.
  let skip = lineCount === 0 ? 0 : startLine - 1, take = lineCount ?? Infinity;

  // Regular virtual files can report zero, undersized or oversized stat lengths.
  // Only the read stream establishes EOF and whether a selected window is whole.
  for await (const chunk of fileChunks(file, signal, Infinity, lineCount === 0 ? 1 : undefined)) {
    const head = advanceLines(chunk, 0, skip);
    skip = head.remaining;
    const start = scan.readBytes;
    scan.readBytes += chunk.length;

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

    if (scan.collected > maxBytes || take === 0 && tail.offset < chunk.length) return scan;
  }

  scan.eof = true;

  return scan;
}

function overlayWindow(overlay, startLine, lineCount) {
  const window = sliceLinesRawInfo(overlay, startLine, lineCount);
  const satisfied = lineCount === undefined || lineCount === 0 || window.text === "" || window.count >= lineCount || window.eof;

  return { text: window.text, satisfied, whole: window.whole };
}

async function openReadFile(target) {
  try { return await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
  catch (error) { await remapReadError(error, target); }
}

export function createWindowReader(vfs) {
  return async function readWindow(target, startLine, lineCount, maxBytes, signal) {
    const overlay = await vfs.getOverlay(target);

    if (overlay !== undefined) {
      const window = overlayWindow(overlay,startLine,lineCount);
      window.satisfied &&= Buffer.byteLength(window.text,"utf8") <= maxBytes;

      return window;
    }

    const file = await openReadFile(target);

    let stat, result, wholeBytes;

    try {
      stat = await file.stat();

      if (!stat.isFile()) throw new Error("read requires a regular file: " + target);

      const scan = await scanWindow(file, startLine, lineCount, maxBytes, signal);

      if (scan.startByte === undefined) {
        result = { text: "", satisfied: true, whole: scan.eof && scan.readBytes === 0 };
      } else {
        if (scan.collected > maxBytes) return { text: "", satisfied: false, whole: false };
        const bytes = Buffer.concat(scan.parts, scan.collected);
        const end = scan.startByte + scan.collected;
        const eof = scan.eof;
        const text = eof ? decodeUtf8Strict(bytes, target) : decodeUtf8Window(bytes, target);
        const whole = startLine === 1 && scan.startByte === 0 && eof;
        // The digest-reuse contract requires bytes agreeing with observed size.
        wholeBytes = whole && bytes.length === stat.size ? bytes : undefined;
        result = { text, satisfied: end >= scan.endByte || eof, whole };
      }
    } finally { await file.close(); }

    // An open read handle can prevent Windows from restoring a rollback backup.
    await vfs.recordExpected(target, stat, wholeBytes);

    return result;
  };
}
