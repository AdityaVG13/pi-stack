import * as path from 'node:path';
import {extractStructuralSurface} from './surface.js';
import { braceBlockEndLine } from "../fs/check.js";

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

function pythonHeaderEnd(raw, start, lineCount, suite = true) {
  let depth = 0;
  let quote = "";
  let escape = false;

  for (let i = start - 1; i < lineCount; i++) {
    let statement = raw[i].trimEnd();

    for (let j = 0; j < statement.length; j++) {
      const ch = statement[j];

      if (quote) {
        if (escape) { escape = false; continue; }

        if (ch === "\\") { escape = true; continue; }

        if (statement.startsWith(quote, j)) {
          j += quote.length - 1;
          quote = "";
        }

        continue;
      }

      // Comments only start outside strings; triple-quoted payload persists
      // across physical lines and closes on its full delimiter.
      if (ch === "#") { statement = statement.slice(0, j).trimEnd(); break; }

      if (ch === "'" || ch === "\"") {
        quote = statement.startsWith(ch.repeat(3), j) ? ch.repeat(3) : ch;
        j += quote.length - 1;
      }
      else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (suite && ch === ":" && depth === 0) return i + 1;
    }

    // A backslash escaping a physical newline does not escape the next line's
    // first character; the quote itself still persists.
    escape = false;

    // Assignments end at a logical newline, not at a suite-opening colon.
    if (!suite && depth === 0 && !quote && !statement.endsWith("\\")) return i + 1;
  }

  return lineCount;
}

function pythonDeclarationEnd(raw, lower, start, lineCount) {
  const base = lineIndent(raw, start - 1);
  // Only a top-level colon ends a header, including a header with an inline
  // suite. Colons in annotations, defaults and comments are not terminators.
  let end = pythonHeaderEnd(raw, start, lineCount);

  for (let i = end; i < lineCount; i++) {
    // Blank and comment-only lines do not dedent a Python suite. Include them
    // only when a later body line extends the span, preserving neighbor comments.
    if (lower[i] === "" || lower[i].startsWith("#")) continue;

    if (lineIndent(raw, i) <= base) break;
    // Dedentation inside a continued expression or string is payload, not a
    // suite boundary. Resume indentation checks after its logical newline.
    end = pythonHeaderEnd(raw, i + 1, lineCount, false);
    i = end - 1;
  }

  return Math.min(end, lineCount);
}

const BLOCK_DECLARATIONS = new Set(["function", "function*", "method", "class", "fn", "struct", "enum", "trait", "impl", "interface"]);

function declarationEnd(raw, lower, start, lineCount, ext, kind) {
  if (String(ext ?? "").toLowerCase() === ".py") return kind === "constant"
    ? pythonHeaderEnd(raw, start, lineCount, false)
    : pythonDeclarationEnd(raw, lower, start, lineCount);

  return Math.min(lineCount, Math.max(start, braceBlockEndLine(raw.join("\n"), start, ext, BLOCK_DECLARATIONS.has(kind))));
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
      let end = declarationEnd(raw, lower, start, lineCount, entry.ext, items[i].kind);

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
