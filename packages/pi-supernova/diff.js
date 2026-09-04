
import { isString } from "./decode.js";

export function buildEditDiff(filePath, originalText, oldText, newText) {
  const fileLines = contentLines(originalText);
  const idx = isString(originalText) ? originalText.indexOf(oldText) : -1;

  const startLine = idx >= 0 ? originalText.slice(0, idx).split("\n").length : 1;
  const oldLines = contentLines(oldText);
  const newLines = contentLines(newText);

  const lines = [];
  if (startLine > 1 && fileLines.length >= startLine - 1) {
    lines.push({ type: "context", lineNum: startLine - 1, text: fileLines[startLine - 2] });
  }

  for (let i = 0; i < oldLines.length; i++) {
    lines.push({ type: "remove", lineNum: startLine + i, text: oldLines[i] });
  }
  for (let i = 0; i < newLines.length; i++) {
    lines.push({ type: "add", lineNum: startLine + i, text: newLines[i] });
  }

  const afterSourceLine = startLine + oldLines.length;
  if (fileLines.length >= afterSourceLine) {
    lines.push({ type: "context", lineNum: startLine + newLines.length, text: fileLines[afterSourceLine - 1] });
  }

  return {
    path: filePath,
    op: "edit",
    added: newLines.length,
    removed: oldLines.length,
    lines,
  };
}

export function buildMultiEditDiff(filePath, originalText, replacements) {
  const parts = replacements.map(({ oldText, newText }) =>
    buildEditDiff(filePath, originalText, oldText, newText),
  );
  const lines = [];
  for (const part of parts) {
    for (const line of part.lines) {
      const previous = lines.at(-1);
      if (previous?.type === "context" && line.type === "context" && previous.lineNum === line.lineNum) continue;
      lines.push(line);
    }
  }
  return {
    path: filePath,
    op: "edit",
    added: parts.reduce((sum, part) => sum + part.added, 0),
    removed: parts.reduce((sum, part) => sum + part.removed, 0),
    lines,
  };
}

export function buildPatchDiff(filePath, patchText) {
  const patchLines = isString(patchText) ? patchText.replace(/\r\n/g, "\n").split("\n") : [];
  const lines = [];
  let added = 0;
  let removed = 0;
  let oldLineNum = 1;
  let newLineNum = 1;
  let inHunk = false;

  for (const patchLine of patchLines) {
    const headerMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/.exec(patchLine);
    if (headerMatch) {
      oldLineNum = Number(headerMatch[1]);
      newLineNum = Number(headerMatch[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || patchLine.startsWith("\\")) continue;
    if (patchLine.startsWith("-")) {
      removed += 1;
      lines.push({ type: "remove", lineNum: oldLineNum, text: patchLine.slice(1) });
      oldLineNum += 1;
    } else if (patchLine.startsWith("+")) {
      added += 1;
      lines.push({ type: "add", lineNum: newLineNum, text: patchLine.slice(1) });
      newLineNum += 1;
    } else if (patchLine.startsWith(" ")) {
      lines.push({ type: "context", lineNum: newLineNum, text: patchLine.slice(1) });
      oldLineNum += 1;
      newLineNum += 1;
    }
  }

  return { path: filePath, op: "apply_patch", added, removed, lines };
}

function contentLines(text) {
  if (!isString(text) || text.length === 0) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function buildWriteDiff(filePath, previousText, newText) {
  const newLines = contentLines(newText);
  const oldLines = contentLines(previousText);
  const maxStoredLines = 64;
  const lines = [];
  for (let i = 0; i < oldLines.length && lines.length < maxStoredLines; i++) {
    lines.push({ type: "remove", lineNum: i + 1, text: oldLines[i] });
  }
  for (let i = 0; i < newLines.length && lines.length < maxStoredLines; i++) {
    lines.push({ type: "add", lineNum: i + 1, text: newLines[i] });
  }
  return {
    path: filePath,
    op: "write",
    added: newLines.length,
    removed: oldLines.length,
    displayLineCount: oldLines.length + newLines.length,
    lines,
  };
}
