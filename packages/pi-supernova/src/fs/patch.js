import { isString } from "../shared/decode.js";

function parseHunkHeader(line) {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);

  if (!match) return null;

  return { oldStart: Number(match[1]), oldLength: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]), newLength: match[4] === undefined ? 1 : Number(match[4]), lines: [], noNewline: [] };
}

function applyNoNewlineMarker(current) {
  if (!current.lines.length) throw new Error("newline marker requires a preceding hunk line");
  current.noNewline.push(current.lines.length - 1);
}

function pushHunkLine(current, line, oldCount, newCount) {
  if (oldCount === current.oldLength && newCount === current.newLength && /^--- |^\+\+\+ /.test(line)) {
    throw new Error("apply_patch accepts one file at a time");
  }

  current.lines.push(line);

  return {
    oldCount: line[0] !== "+" ? oldCount + 1 : oldCount,
    newCount: line[0] !== "-" ? newCount + 1 : newCount,
  };
}

function consumeHunkLine(current, line, oldCount, newCount) {
  if (line.startsWith("\\ No newline at end of file")) {
    applyNoNewlineMarker(current);

    return { oldCount, newCount };
  }

  if (!/^[+ -]/.test(line)) return { oldCount, newCount };

  return pushHunkLine(current, line, oldCount, newCount);
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
    } else if (current) {
      ({ oldCount, newCount } = consumeHunkLine(current, line, oldCount, newCount));
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

function findHunkMatch(fileLines, expectedOld, nominal, hunk, oldStart, floor) {
  const matchAt = index => index >= floor && index + expectedOld.length <= fileLines.length
    && expectedOld.every((line, i) => fileLines[index + i].text === line);

  if (matchAt(nominal)) return { index: nominal, relocated: 0 };

  if (!expectedOld.length) return { index: -1, relocated: 0 };

  const maxDrift = Math.min(Math.max(fileLines.length, 100), 200);
  const hits = [];

  for (let delta = 1; delta <= maxDrift; delta++) {
    if (matchAt(nominal + delta)) hits.push(nominal + delta);

    if (matchAt(nominal - delta)) hits.push(nominal - delta);
  }

  if (hits.length > 1) throw new Error("patch hunk " + hunk + " near line " + oldStart + " matches " + hits.length + " locations; add context lines to disambiguate");

  if (hits.length === 1) return { index: hits[0], relocated: hits[0] - nominal };

  return { index: -1, relocated: 0 };
}

function hunkLineText(hunk, i) {
  const text = hunk.lines[i].slice(1);

  // Without an original newline, a trailing CR is payload, not a CRLF ending.
  return hunk.noNewline.includes(i) ? text : text.replace(/\r$/, "");
}

function applyHunkLines(hunk, fileLines, matchIndex, ending) {
  const replacement = [];
  let oldIndex = matchIndex;

  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];

    if (line[0] === "+") {
      replacement.push({ text: hunkLineText(hunk, i), ending: hunk.noNewline.includes(i) ? "" : ending });
    } else {
      const original = fileLines[oldIndex++];

      if (hunk.noNewline.includes(i) && original.ending) throw new Error("patch newline marker does not match the file");

      if (line[0] === " ") replacement.push(original);
    }
  }

  return replacement;
}

function applyOneHunk(hunk, h, fileLines, offsetShift, relocationShift, ending, floor) {
  const expectedOld = hunk.lines.flatMap((line, i) => line[0] !== "+" ? [hunkLineText(hunk, i)] : []);
  const newCount = hunk.lines.filter(line => line[0] !== "-").length;

  if (expectedOld.length !== hunk.oldLength || newCount !== hunk.newLength) throw new Error("patch hunk " + (h + 1) + " length does not match its header");
  // The new coordinate also handles BSD diff's -1,0 header at file start.
  const nominal = hunk.oldLength === 0 ? hunk.newStart - 1 + relocationShift : hunk.oldStart - 1 + offsetShift;
  const match = findHunkMatch(fileLines, expectedOld, nominal, h + 1, hunk.oldStart, floor);

  if (match.index < 0) throw new Error("patch hunk " + (h + 1) + " rejected at line " + hunk.oldStart + ": context did not match");
  const replacement = applyHunkLines(hunk, fileLines, match.index, ending);
  const tailEnd = fileLines.length;
  const length = tailEnd + replacement.length - expectedOld.length;

  // Valid hunks can exceed the engine's argument-count limit. Move the tail
  // in place rather than passing every replacement line as a splice argument.
  if (length > tailEnd) fileLines.length = length;
  fileLines.copyWithin(match.index + replacement.length, match.index + expectedOld.length, tailEnd);
  fileLines.length = length;

  for (let i = 0; i < replacement.length; i++) fileLines[match.index + i] = replacement[i];

  return {
    relocationShift: relocationShift + match.relocated,
    offsetShift: offsetShift + match.relocated + replacement.length - expectedOld.length,
    relocated: match.relocated,
    floor: match.index + replacement.length,
  };
}

export function applyPatchToText(originalText, patchText) {
  if (!isString(patchText) || !patchText.trim()) throw new Error("apply_patch requires non-empty patch");
  const hunks = parsePatchHunks(patchText);
  const fileLines = splitFile(originalText);
  const ending = fileLines.find(line => line.ending)?.ending ?? "\n";
  const relocations = [];
  let offsetShift = 0;
  let relocationShift = 0;
  // Later hunks cannot reinterpret already-published output as original input.
  let floor = 0;

  for (let h = 0; h < hunks.length; h++) {
    const applied = applyOneHunk(hunks[h], h, fileLines, offsetShift, relocationShift, ending, floor);
    offsetShift = applied.offsetShift;
    relocationShift = applied.relocationShift;
    floor = applied.floor;

    if (applied.relocated !== 0) relocations.push({ hunk: h + 1, offset: applied.relocated });
  }

  return { resultText: fileLines.map(line => line.text + line.ending).join(""), hunkCount: hunks.length, relocations };
}
