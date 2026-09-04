// Quick structural check after an edit, not a parser. Catches the edit failures models make
// most: an unbalanced brace/bracket/paren or an unterminated string, with the line it happened
// on, so a broken edit is known now instead of after a test run. JSON is checked exactly.

const OPEN = { "{": "}", "[": "]", "(": ")" };
const CLOSE = new Set(["}", "]", ")"]);
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "return", "typeof", "case", "do", "else", "in", "of"]);

function skipString(text, i, quote) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === quote) return j + 1;
    if (quote !== "`" && text[j] === "\n") return -1;
  }
  return -1;
}

function skipTemplate(text, i, stack) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === "`") return j + 1;
    if (text[j] === "$" && text[j + 1] === "{") {
      const end = balancedEnd(text, j + 1, stack);
      if (end < 0) return -1;
      j = end - 1; // loop increment lands on the char after "}"
    }
  }
  return -1;
}

/** Index just past the "}" matching the "{" at i, scanning nested code; −1 when unbalanced. */
function balancedEnd(text, i, stack) {
  const depth = stack.length;
  const r = scan(text, i, stack, depth);
  return r.error ? -1 : r.end;
}

function skipComment(text, i) {
  if (text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl;
  }
  const end = text.indexOf("*/", i + 2);
  return end < 0 ? text.length : end + 2;
}

function skipRegex(text, i) {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
  }
  return -1;
}

function lineOf(text, i) {
  let n = 1;
  for (let j = 0; j < i && j < text.length; j++) if (text[j] === "\n") n++;
  return n;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

function readIdentifier(text, i) {
  let j = i + 1;
  while (j < text.length && IDENT_PART.test(text[j])) j++;
  return j;
}

function consumeQuoted(text, i, stack) {
  const c = text[i];
  if (c === "`") {
    const end = skipTemplate(text, i, stack);
    return end < 0 ? { error: "unterminated template literal", at: i } : { end, prev: "value" };
  }
  const end = skipString(text, i, c);
  return end < 0 ? { error: "unterminated string", at: i } : { end, prev: "value" };
}

/** Try to consume a comment, string, template, or regex at i. Returns { end, prev } | { error, at } | null. */
function consumeLiteral(text, i, stack, prev) {
  const c = text[i];
  if (c === '"' || c === "'" || c === "`") return consumeQuoted(text, i, stack);
  if (c !== "/") return null;
  if (text[i + 1] === "/" || text[i + 1] === "*") return { end: skipComment(text, i), prev };
  if (prev !== "" && !REGEX_PRECEDERS.has(prev)) return null;
  const end = skipRegex(text, i);
  return end > 0 ? { end, prev: "value" } : null;
}

/** Push/pop a bracket; returns an error, a stop, or null to continue. */
function bracket(c, i, stack, stopDepth) {
  if (OPEN[c]) {
    stack.push({ c, at: i });
    return null;
  }
  if (!CLOSE.has(c)) return null;
  const top = stack.pop();
  if (!top || OPEN[top.c] !== c) return { error: "unexpected '" + c + "'", at: i };
  if (stopDepth !== undefined && stack.length <= stopDepth) return { end: i + 1 };
  return null;
}

/** Skips comments, strings, templates and regex literals; `prev` is the last code token, which decides regex-vs-division. */
function scan(text, start, stack, stopDepth) {
  let i = start;
  let prev = "";
  while (i < text.length) {
    const c = text[i];
    const literal = consumeLiteral(text, i, stack, prev);
    if (literal) {
      if (literal.error) return literal;
      i = literal.end;
      prev = literal.prev;
      continue;
    }
    if (IDENT_START.test(c)) {
      const j = readIdentifier(text, i);
      prev = text.slice(i, j);
      i = j;
      continue;
    }
    const outcome = bracket(c, i, stack, stopDepth);
    if (outcome) return outcome;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { end: i };
}

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".swift", ".css", ".scss"]);

/** { ok: true } | { ok: false, message }; message names the problem and line. */
export function quickCheck(text, ext) {
  if (ext === ".json") {
    try {
      JSON.parse(text);
      return { ok: true, kind: "json" };
    } catch (err) {
      return { ok: false, kind: "json", message: String(err.message).replace(/^JSON\.parse: /, "") };
    }
  }
  if (!CODE_EXT.has(ext)) return null;
  const stack = [];
  const r = scan(text, 0, stack);
  if (r.error) return { ok: false, kind: "balance", message: r.error + " at line " + lineOf(text, r.at) };
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { ok: false, kind: "balance", message: "unclosed '" + top.c + "' opened at line " + lineOf(text, top.at) };
  }
  return { ok: true, kind: "balance" };
}
