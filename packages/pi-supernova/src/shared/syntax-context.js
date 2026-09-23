import stringWidth from "string-width";

/** Bounded source context for parse and syntax diagnostics. */
const JS_LINES = /\r\n|[\n\r\u2028\u2029]/;

const JSON_LINES = /\r\n|[\n\r]/;

// Source columns are UTF-16 offsets; expand controls identically before the
// source token and the caret. JSON strings can contain literal Unicode LS/PS.
const displaySource = text => text.replaceAll("\t","    ").replaceAll("\u2028","\\u2028").replaceAll("\u2029","\\u2029");

export function sourceContext(source, line, column, lineBreaks = JS_LINES) {
  if (!Number.isInteger(line) || line < 1) return "";
  const text = String(source).split(lineBreaks)[line - 1];

  if (text === undefined) return "";
  const located = Number.isInteger(column) && column >= 0;
  const position = located ? Math.min(column, text.length) : 0;
  const start = Math.max(0, Math.min(position - 80, text.length - 160));
  const end = Math.min(text.length, start + 160);
  const prefix = start > 0 ? "…" : "";
  const shown = prefix + displaySource(text.slice(start, end)) + (end < text.length ? "…" : "");
  const caret = located ? " ".repeat(stringWidth(prefix + displaySource(text.slice(start, position)))) + "^" : "";

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
  const lines = String(source).slice(0, offset).split(JSON_LINES);

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

  if (native) return sourceContext(source, native.line, native.column, JSON_LINES);
  const offset = invalidJsonOffset(source);

  if (offset === null) return "";
  const { line, column } = offsetPosition(source, offset);

  return " (near line " + line + " column " + (column + 1) + ")" + sourceContext(source, line, column, JSON_LINES);
}
