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

  if (located) return { line: Number(located[1]), column: Number(located[2]) - 1 };
  const offsetMatch = /at position (\d+)/.exec(String(message));

  if (!offsetMatch) return null;
  return offsetPosition(source, Number(offsetMatch[1]));
}

function offsetPosition(source, offset) {
  const lines = String(source).slice(0, offset).split("\n");

  return { line: lines.length, column: lines.at(-1).length };
}

// Diagnostic-only JSON grammar: recover a failing token when the engine omits
// offsets. JSON.parse remains the authority; cap extra work at 65,536 characters.
// eslint-disable-next-line no-control-regex -- RFC 8259 excludes unescaped control characters from strings.
const JSON_TOKEN = /("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|[{}[\]:,]/y;
const JSON_NEXT = {
  end: { eof: [] },
  value: { string: [], number: [], literal: [], "{": ["object"], "[": ["array"] },
  array: { "]": [] },
  arrayNext: { "]": [], ",": ["arrayNext", "value"] },
  object: { "}": [] },
  key: { string: ["colon"] },
  colon: { ":": ["objectNext", "value"] },
  objectNext: { "}": [], ",": ["key"] },
};

function jsonTokenAt(source, start) {
  while (start < source.length && " \t\r\n".includes(source[start])) start++;
  JSON_TOKEN.lastIndex = start;
  const match = JSON_TOKEN.exec(source);

  if (!match) return { start, end: start, kind: start === source.length ? "eof" : "invalid" };
  const kind = ["string", "number", "literal"][match.slice(1).findIndex(Boolean)] ?? match[0];

  return { start, end: JSON_TOKEN.lastIndex, kind };
}

function invalidJsonOffset(source) {
  if (source.length > 64 * 1024) return null;
  const stack = ["end", "value"];
  let offset = 0;

  while (stack.length) {
    const token = jsonTokenAt(source, offset);
    let state = stack.pop();
    if (state === "array" && token.kind !== "]") { stack.push("arrayNext"); state = "value"; }
    if (state === "object" && token.kind !== "}") state = "key";
    const next = JSON_NEXT[state][token.kind];
    if (!next) return token.start;
    stack.push(...next);
    offset = token.end;
  }

  return null;
}

export function jsonErrorContext(message, source) {
  const native = parsePosition(message, source);
  if (native) return sourceContext(source, native.line, native.column);
  const offset = invalidJsonOffset(source);
  if (offset === null) return "";
  const { line, column } = offsetPosition(source, offset);

  return " (near line " + line + " column " + (column + 1) + ")" + sourceContext(source, line, column);
}
