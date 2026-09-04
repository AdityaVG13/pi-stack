import { isString } from "./decode.js";

function parseHunkHeader(line) {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) return null;
  return { oldStart: Number(match[1]), oldLength: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]), newLength: match[4] === undefined ? 1 : Number(match[4]), lines: [], noNewline: [] };
}

export function parsePatchHunks(patchText) {
  const hunks = [];
  let current;
  let oldCount = 0;
  let newCount = 0;
  for (const line of patchText.split("\n")) {
    const header = parseHunkHeader(line);
    if (header) {
      current = header;
      hunks.push(current);
      oldCount = 0;
      newCount = 0;
    } else if (current && line.startsWith("\\ No newline at end of file")) {
      if (!current.lines.length) throw new Error("newline marker requires a preceding hunk line");
      current.noNewline.push(current.lines.length - 1);
    } else if (current && /^[+ -]/.test(line)) {
      if (oldCount === current.oldLength && newCount === current.newLength && /^--- |^\+\+\+ /.test(line)) {
        throw new Error("apply_patch accepts one file at a time");
      }
      current.lines.push(line);
      if (line[0] !== "+") oldCount++;
      if (line[0] !== "-") newCount++;
    }
  }
  if (!hunks.length) throw new Error("no valid patch hunks found (expected @@ -old,len +new,len @@)");
  return hunks;
}

function splitFile(text) {
  if (!text) return [];
  const chunks = text.split("\n");
  const trailing = chunks.at(-1) === "";
  if (trailing) chunks.pop();
  return chunks.map((chunk, index) => {
    const newline = index < chunks.length - 1 || trailing;
    const crlf = newline && chunk.endsWith("\r");
    return { text: crlf ? chunk.slice(0, -1) : chunk, ending: newline ? (crlf ? "\r\n" : "\n") : "" };
  });
}

function findHunkMatch(fileLines, expectedOld, nominal) {
  const matchAt = index => index >= 0 && index + expectedOld.length <= fileLines.length
    && expectedOld.every((line, i) => fileLines[index + i].text === line);
  if (matchAt(nominal)) return nominal;
  if (!expectedOld.length) return -1;
  for (let delta = 1; delta <= Math.max(fileLines.length, 100); delta++) {
    if (matchAt(nominal + delta)) return nominal + delta;
    if (matchAt(nominal - delta)) return nominal - delta;
  }
  return -1;
}

export function applyPatchToText(originalText, patchText) {
  if (!isString(patchText) || !patchText.trim()) throw new Error("apply_patch requires non-empty patch");
  const hunks = parsePatchHunks(patchText);
  const fileLines = splitFile(originalText);
  const ending = fileLines.find(line => line.ending)?.ending ?? "\n";
  let offsetShift = 0;
  let relocationShift = 0;
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const textOf = line => line.slice(1).replace(/\r$/, "");
    const expectedOld = hunk.lines.filter(line => line[0] !== "+").map(textOf);
    const newCount = hunk.lines.filter(line => line[0] !== "-").length;
    if (expectedOld.length !== hunk.oldLength || newCount !== hunk.newLength) throw new Error("patch hunk " + (h + 1) + " length does not match its header");
    // The new coordinate also handles BSD diff's -1,0 header at file start.
    const nominal = hunk.oldLength === 0 ? hunk.newStart - 1 + relocationShift : hunk.oldStart - 1 + offsetShift;
    const matchIndex = findHunkMatch(fileLines, expectedOld, nominal);
    if (matchIndex < 0) throw new Error("patch hunk " + (h + 1) + " rejected at line " + hunk.oldStart + ": context did not match");
    const replacement = [];
    let oldIndex = matchIndex;
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      if (line[0] === "+") {
        replacement.push({ text: textOf(line), ending: hunk.noNewline.includes(i) ? "" : line.endsWith("\r") ? "\r\n" : ending });
      } else {
        const original = fileLines[oldIndex++];
        if (hunk.noNewline.includes(i) && original.ending) throw new Error("patch newline marker does not match the file");
        if (line[0] === " ") replacement.push(original);
      }
    }
    fileLines.splice(matchIndex, expectedOld.length, ...replacement);
    relocationShift += matchIndex - nominal;
    offsetShift += matchIndex - nominal + replacement.length - expectedOld.length;
  }
  return { resultText: fileLines.map(line => line.text + line.ending).join(""), hunkCount: hunks.length };
}
