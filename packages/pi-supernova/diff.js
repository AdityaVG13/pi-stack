
import { isString } from "./decode.js";

export function buildEditDiff(filePath, originalText, oldText, newText) {
  const fileLines = isString(originalText) ? originalText.split("\n") : [];
  const idx = isString(originalText) ? originalText.indexOf(oldText) : -1;

  const startLine = idx >= 0 ? originalText.slice(0, idx).split("\n").length : 1;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

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

  const afterLine = startLine + oldLines.length;
  if (fileLines.length >= afterLine) {
    lines.push({ type: "context", lineNum: afterLine, text: fileLines[afterLine - 1] });
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
  let currentLineNum = 1;
  let inHunk = false;

  for (const pLine of patchLines) {
    const headerMatch = /^@@\s+-(\d+)/.exec(pLine);
    if (headerMatch) {
      currentLineNum = parseInt(headerMatch[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || pLine.startsWith("\\")) continue;
    if (pLine.startsWith("-")) {
      removed += 1;
      lines.push({ type: "remove", lineNum: currentLineNum, text: pLine.slice(1) });
      currentLineNum += 1;
    } else if (pLine.startsWith("+")) {
      added += 1;
      lines.push({ type: "add", lineNum: currentLineNum, text: pLine.slice(1) });
    } else if (pLine.startsWith(" ")) {
      lines.push({ type: "context", lineNum: currentLineNum, text: pLine.slice(1) });
      currentLineNum += 1;
    }
  }

  return {
    path: filePath,
    op: "apply_patch",
    added,
    removed,
    lines,
  };
}

export function buildWriteDiff(filePath, previousText, newText) {
  const newLines = isString(newText) ? newText.split("\n") : [];
  const oldLines = isString(previousText) ? previousText.split("\n") : [];

  if (oldLines.length === 0 || (oldLines.length === 1 && oldLines[0] === "")) {
    const sampleCount = Math.min(newLines.length, 6);
    const lines = [];
    for (let i = 0; i < sampleCount; i++) {
      lines.push({ type: "add", lineNum: i + 1, text: newLines[i] });
    }
    return {
      path: filePath,
      op: "write",
      added: newLines.length,
      removed: 0,
      lines,
    };
  }

  const sampleCount = Math.min(newLines.length, 6);
  const lines = [];
  for (let i = 0; i < sampleCount; i++) {
    lines.push({ type: "add", lineNum: i + 1, text: newLines[i] });
  }
  return {
    path: filePath,
    op: "write",
    added: newLines.length,
    removed: oldLines.length,
    lines,
  };
}
