/** Bounded source context for parse and syntax diagnostics. */

export function sourceContext(source, line, column) {
  if (!Number.isInteger(line) || line < 1) return "";
  const text = String(source).split("\n")[line - 1];

  if (text === undefined) return "";
  const shown = text.length > 160 ? text.slice(0, 160) : text;
  const caret = Number.isInteger(column) ? " ".repeat(Math.min(column, shown.length)) + "^" : "";

  return "\n  " + shown + (caret ? "\n  " + caret : "");
}

/** acorn-style error that carries a loc, when it has one. */
export function errorContext(source, error) {
  return sourceContext(source, error?.loc?.line, error?.loc?.column);
}

/** V8 "(line 5 column 3)" or "at position 42" parse messages → a position. */
export function parsePosition(message, source) {
  const located = /\(line (\d+) column (\d+)\)/.exec(String(message));

  if (located) return { line: Number(located[1]), column: Number(located[2]) };
  const offsetMatch = /at position (\d+)/.exec(String(message));

  if (!offsetMatch) return null;
  const before = String(source).slice(0, Number(offsetMatch[1]));
  const lines = before.split("\n");

  return { line: lines.length, column: lines.at(-1).length };
}
