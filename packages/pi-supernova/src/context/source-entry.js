import * as path from 'node:path';
import {extractStructuralSurface} from './surface.js';

const IDENT_TOKEN = /[A-Za-z_$][\w$]*/g;

const EMPTY = Object.freeze([]);

const DEF_PATTERN = /^(?:pub\s+)?(?:export\s+)?(?:async\s+)?(?:default\s+)?(?:(function|class|def|fn|const|let|interface|type|struct|enum)\s+([a-zA-Z0-9_$]+)|([A-Z][A-Z0-9_$]*)\s*(?::[^=\n]+)?=)/;

/** Declared identifier on a line (function/class/UPPER_CASE constant/…), or ""; the same rule snap and grep use. */
export function declaredName(line) {
  const match = DEF_PATTERN.exec(String(line).trim());

  return match?.[2] ?? match?.[3] ?? "";
}

function lineIndent(raw, i) {
  return raw[i].length - raw[i].trimStart().length;
}

function pythonDeclarationEnd(raw, lower, start, lineCount) {
  const base = lineIndent(raw, start - 1);
  let end = start;

  for (let i = start; i < lineCount; i++) {
    if (lower[i] === "") { end = i + 1; continue; }
    if (lineIndent(raw, i) <= base) break;
    end = i + 1;
  }

  return Math.min(end, lineCount);
}

function braceDelta(text) {
  let depth = 0;

  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }

  return depth;
}

function braceDeclarationEnd(raw, start, lineCount) {
  let depth = braceDelta(raw[start - 1] ?? "");

  if (depth <= 0) return start;

  for (let i = start; i < raw.length; i++) {
    depth += braceDelta(raw[i]);

    if (depth <= 0) return i + 1;
  }

  return lineCount;
}

function declarationEnd(raw, lower, start, lineCount, ext) {
  if (ext === ".py") return pythonDeclarationEnd(raw, lower, start, lineCount);

  return braceDeclarationEnd(raw, start, lineCount);
}

export function fromText(filePath, text) {
    return { text, lower: text.toLowerCase(), ext: path.extname(filePath), surface: undefined, lines: undefined, spans: undefined };
  }

export function linesOf(entry) {
    if (entry.lines) return entry.lines;
    const raw = entry.text.split("\n");
    const lower = [];
    const defNames = [];
    const idents = [];

    for (let i = 0; i < raw.length; i++) {
      const trimmed = raw[i].trim();
      lower[i] = trimmed.toLowerCase();
      const declared = DEF_PATTERN.exec(trimmed);
      defNames[i] = (declared?.[2] ?? declared?.[3] ?? "").toLowerCase();
      idents[i] = trimmed.match(IDENT_TOKEN) || EMPTY;
    }

    entry.lines = { raw, lower, defNames, idents };

    return entry.lines;
  }

export function spansOf(entry) {
    if (entry.spans) return entry.spans;
    const { items, lineCount } = surfaceOf(entry);
    const { lower, raw } = linesOf(entry);
    const spans = [];

    for (let i = 0; i < items.length; i++) {
      const start = items[i].line;
      let end = declarationEnd(raw, lower, start, lineCount, entry.ext);

      while (end > start && lower[end - 1] === "") end--;
      spans.push({ start, end, name: items[i].name, kind: items[i].kind, isExport: items[i].isExport === true });
    }

    entry.spans = spans;

    return spans;
  }

export function surfaceOf(entry) {
    if (!entry.surface) entry.surface = extractStructuralSurface(entry.text, entry.ext);

    return entry.surface;
  }
