import { isString } from "./decode.js";

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

function isHunkLine(line) {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
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
    } else if (current && isHunkLine(line)) {
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

function splitHunkLines(hunk) {
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
  return { expectedOld, newLines };
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
    const { expectedOld, newLines } = splitHunkLines(hunk);

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
