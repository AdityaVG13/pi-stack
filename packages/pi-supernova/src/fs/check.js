// Quick structural check after an edit, not a parser. Catches the edit failures models make
// most: an unbalanced brace/bracket/paren or an unterminated string, with the line it happened
// on, so a broken edit is known now instead of after a test run. JSON is checked exactly.

const OPEN = { "{": "}", "[": "]", "(": ")" };

const CLOSE = new Set(["}", "]", ")"]);

const REGEX_PRECEDERS = new Set(["(", ",", "...", "=", "=>", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "/", "%", "<", ">", "~", "^", "return", "throw", "typeof", "void", "delete", "await", "yield", "debugger", "new", "case", "do", "else", "in", "instanceof"]);

const CONTROL_PARENS = new Set(["if", "while", "for", "with"]);

const RESTRICTED_PRODUCTIONS = new Set(["return", "yield", "break", "continue"]);

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

const OBJECT_PRECEDERS = new Set(["(", "[", "=", ",", "...", "?", "+", "-", "*", "/", "%", "<", ">", "&", "|", "^", "!", "~", "return", "throw", "typeof", "void", "delete", "yield", "await", "case", "in", "instanceof"]);

function skipString(text, i, quote, multiline = false, spliced = false) {
  for (let j = i + quote.length; j < text.length; j++) {
    if (text[j] === "\\") {
      let escaped = j + 1;

      // C/C++ removes line splices before interpreting escapes. An escape can
      // therefore reach a quote across one or more physical backslash-newlines.
      if (spliced) {
        while (text.startsWith("\\\n", escaped) || text.startsWith("\\\r\n", escaped)) escaped += text[escaped + 1] === "\r" ? 3 : 2;
      }

      // CRLF is one escaped line terminator, not an escaped CR followed by bare LF.
      j = escaped + (text[escaped] === "\r" && text[escaped + 1] === "\n" ? 1 : 0);
      continue;
    }

    if (text.startsWith(quote, j)) return j + quote.length;

    if (!multiline && quote !== "`" && text[j] === "\n") return -1;
  }

  return -1;
}

// C++ raw strings carry their own delimiter. Phase-two splices may split the
// encoding/R prefix, but the quoted raw payload keeps its original bytes.
function consumeCppRaw(text, i) {
  const prefix = /(?:(?:u(?:\\\r?\n)*8|[uUL])(?:\\\r?\n)*)?R(?:\\\r?\n)*"/y;
  prefix.lastIndex = i;

  if (!prefix.test(text)) return null;
  const start = prefix.lastIndex;
  const opener = /^([^\s()\\]{0,16})\(/.exec(text.slice(start, start + 17));

  if (!opener) return null;
  const end = text.indexOf(")" + opener[1] + '"', start + opener[0].length);

  return end < 0 ? { error: "unterminated raw string", at: i } : { end: end + opener[1].length + 2, prev: "value" };
}

// Rust r#"..."#, br#"..."#, cr#"..."# (and r"...") treat quotes, braces, and
// backslashes as payload. r#ident is a raw identifier, not a string.
function consumeRustRaw(text, i) {
  let j = i;

  if (text[j] === "b" || text[j] === "c") j++;

  if (text[j] !== "r") return null;
  j++;
  let hashes = 0;

  while (text[j] === "#") {
    hashes++;
    j++;
  }

  if (text[j] !== '"') return null;
  const closer = '"' + "#".repeat(hashes);
  const end = text.indexOf(closer, j + 1);

  return end < 0 ? { error: "unterminated raw string", at: i } : { end: end + closer.length, prev: "value" };
}

// Raw interpolation uses the dollar count as its brace delimiter. Nested C#
// expressions can contain quotes matching the enclosing raw-string delimiter.
function consumeCSharpRawInterpolation(text, i) {
  const prefix = /(\$+)("{3,})/y;
  prefix.lastIndex = i;
  const opener = prefix.exec(text);

  if (!opener) return null;
  const width = opener[1].length;
  const quote = opener[2];

  for (let j = i + opener[0].length; j < text.length; j++) {
    if (text.startsWith(quote, j)) return { end: j + quote.length, prev: "value" };

    if (text[j] !== "{") continue;
    let run = j + 1;

    while (text[run] === "{") run++;

    if (run - j < width) { j = run - 1; continue; }

    const end = balancedEnd(text, run - 1, [], false, false, false, false, ".cs", true);

    if (end < 0 || !text.startsWith("}".repeat(width - 1), end)) return { error: "unterminated string", at: i };
    j = end + width - 2;
  }

  return { error: "unterminated string", at: i };
}

// C# interpolation expressions are nested code, not enclosing-string payload.
// Verbatim payload escapes quotes by doubling them and leaves backslashes intact.
function consumeCSharpString(text, i) {
  const raw = consumeCSharpRawInterpolation(text, i);

  if (raw) return raw;
  const opener = /^(?:\$@"|@\$"|@"|\$")/.exec(text.slice(i, i + 3));

  if (!opener) return null;
  const verbatim = opener[0].includes("@");
  const interpolated = opener[0].includes("$");

  for (let j = i + opener[0].length; j < text.length; j++) {
    if (!verbatim && text[j] === "\\") { j++; continue; }

    if (interpolated && text[j] === "{") {
      if (text[j + 1] === "{") { j++; continue; }

      const end = balancedEnd(text, j, [], false, false, false, false, ".cs", true);

      if (end < 0) return { error: "unterminated string", at: i };
      j = end - 1;
      continue;
    }

    if (text[j] === '"') {
      if (verbatim && text[j + 1] === '"') { j++; continue; }

      return { end: j + 1, prev: "value" };
    }

    if (!verbatim && text[j] === "\n") break;
  }

  return { error: "unterminated string", at: i };
}

// Kotlin templates contain nested Kotlin code. Raw payload has no backslash
// escapes, but both ordinary and raw strings interpolate ${...} expressions.
function consumeKotlinString(text, i) {
  const quote = text.startsWith('"""', i) ? '"""' : '"';
  const raw = quote.length === 3;

  for (let j = i + quote.length; j < text.length; j++) {
    if (!raw && text[j] === "\\") { j++; continue; }

    if (text[j] === "$" && text[j + 1] === "{") {
      const end = balancedEnd(text, j + 1, [], false, false, false, false, ".kt");

      if (end < 0) return { error: "unterminated string", at: i };
      j = end - 1;
      continue;
    }

    if (text.startsWith(quote, j)) return { end: j + quote.length, prev: "value" };

    if (!raw && text[j] === "\n") break;
  }

  return { error: "unterminated string", at: i };
}

// Swift strings use matching hash counts on delimiters and escapes. Interpolation
// is nested Swift code; its quoted payload must not close the enclosing string.
function consumeSwiftString(text, i) {
  let start = i;

  while (text[start] === "#") start++;

  if (text[start] !== '"') return null;
  const hashes = text.slice(i, start);
  const quote = text.startsWith('"""', start) ? '"""' : '"';
  const closer = quote + hashes;

  for (let j = start + quote.length; j < text.length; j++) {
    if (text[j] === "\\" && text.startsWith(hashes, j + 1)) {
      const escaped = j + hashes.length + 1;

      if (text[escaped] === "(") {
        const end = balancedEnd(text, escaped, [], false, false, false, false, ".swift");

        if (end < 0) return { error: "unterminated string", at: i };
        j = end - 1;
      } else j = escaped;
      continue;
    }

    if (text.startsWith(closer, j)) return { end: j + closer.length, prev: "value" };

    if (quote.length === 1 && text[j] === "\n") break;
  }

  return { error: "unterminated string", at: i };
}

// Swift extended regexes close on / plus the opener's hash count. Bare slashes,
// quotes, brackets and multiline payload are pattern text, not source tokens.
function consumeSwiftRegex(text, i) {
  let start = i;

  while (text[start] === "#") start++;

  if (start === i || text[start] !== "/") return null;
  const closer = "/" + text.slice(i, start);

  for (let j = start + 1; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }

    if (text.startsWith(closer, j)) return { end: j + closer.length, prev: "value" };
  }

  return { error: "unterminated regex", at: i };
}

function skipTemplate(text, i, stack, stringExt) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }

    if (text[j] === "`") return j + 1;

    if (text[j] === "$" && text[j + 1] === "{") {
      const end = balancedEnd(text, j + 1, stack, false, false, false, true, stringExt);

      if (end < 0) return -1;
      j = end - 1; // loop increment lands on the char after "}"
    }
  }

  return -1;
}

/** Index just past the matching bracket at i, scanning nested code; −1 when unbalanced. */
function balancedEnd(text, i, stack, rust = false, cpp = false, go = false, js = true, stringExt = "", csharpInterpolation = false) {
  const depth = stack.length;
  const r = scan(text, i, stack, depth, rust, cpp, go, js, stringExt, csharpInterpolation);

  return r.error ? -1 : r.end;
}

function skipComment(text, i, nested = false, js = false, stringExt = "") {
  const spliced = [".c", ".cc", ".cpp", ".h", ".hpp"].includes(stringExt);
  // Translation-phase line splices can split either comment opener. Keep the
  // physical offsets so editable spans still include every original source line.
  const opener = spliced ? /\/(?:\\\r?\n)*([/*])/y : /\/([/*])/y;
  opener.lastIndex = i;
  const matchOpener = opener.exec(text);

  if (!matchOpener) return null;
  const start = opener.lastIndex;

  if (matchOpener[1] === "/") {
    // Java admits CR/LF; C# additionally admits NEXT_LINE and Unicode separators.
    const newline = js ? /[\r\n\u2028\u2029]/g
      : stringExt === ".cs" ? /[\r\n\u0085\u2028\u2029]/g
      : stringExt === ".java" ? /[\r\n]/g : /\n/g;

    newline.lastIndex = start;
    let match;

    while ((match = newline.exec(text))) {
      // C/C++ removes backslash-newline before comments are recognized. Even
      // a pair of backslashes continues the comment; these are not string escapes.
      const before = match.index - (text[match.index - 1] === "\r" ? 2 : 1);

      if (!spliced || text[before] !== "\\") return match.index;
    }

    return text.length;
  }

  // Rust, Kotlin and Swift block comments nest; other dialects close at the first */.
  // C/C++ line splices can split that closer without changing source coordinates.
  const closer = spliced ? /\*(?:\\\r?\n)*\//y : /\*\//y;
  let depth = 1;

  for (let j = start; j < text.length - 1; j++) {
    if (nested && text[j] === "/" && text[j + 1] === "*") { depth++; j++; }
    else if (text[j] === "*") {
      closer.lastIndex = j;

      if (!closer.test(text)) continue;

      if (--depth === 0) return closer.lastIndex;
      j = closer.lastIndex - 1;
    }
  }

  return -1;
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

// Consume full identifiers, including Unicode escapes, so payload braces and
// keyword suffixes never become code tokens. Preserve the spelling for context.
const IDENTIFIER = /(?:[$_\p{ID_Start}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))(?:[$\u200C\u200D\p{ID_Continue}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))*/uy;

function readIdentifier(text, i) {
  IDENTIFIER.lastIndex = i;

  return IDENTIFIER.test(text) ? IDENTIFIER.lastIndex : i;
}

function identifierContext(word, prev, stack, stringExt) {
  // TypeScript assertion operators expect a type; a following object type closes
  // the asserted operand, not a statement block. Bare identifiers stay operands.
  if ([".ts", ".tsx", ".mts", ".cts"].includes(stringExt) && ["as", "satisfies"].includes(word)
      && !REGEX_PRECEDERS.has(prev)
      && !["", ".", "const", "let", "var", "function", "class", "interface", "enum", "namespace", "module", "type"].includes(prev)) return "=";

  // `of` is an identifier except after the binding in a for-of header.
  const forOf = word === "of" && stack.at(-1)?.forOf === true && prev !== "."
    && !["", "const", "let", "var"].includes(prev) && (prev === "}" || !REGEX_PRECEDERS.has(prev));

  return prev === "." ? "value" : forOf ? "=" : word;
}

function punctuationContext(text, i, stack, conditionals, js) {
  const c = text[i];

  // Property values and conditional alternatives begin expressions; labels and
  // switch cases begin statements. Match a conditional colon at its own depth.
  if (js && c === "?" && !["?", "."].includes(text[i + 1]) && text[i - 1] !== "?") conditionals.push(stack.length);

  if (js && c === ":") {
    const conditional = conditionals.at(-1) === stack.length;

    if (conditional) conditionals.pop();

    if (conditional || stack.at(-1)?.object) return "=";
  }

  return c;
}

function consumeQuoted(text, i, stack, go, rust, stringExt) {
  const c = text[i];

  // Go raw strings and Kotlin escaped identifiers have neither escapes nor
  // JavaScript template interpolation.
  if ((go || stringExt === ".kt") && c === "`") {
    const end = text.indexOf("`", i + 1);

    return end < 0 ? { error: go ? "unterminated raw string" : "unterminated escaped identifier", at: i } : { end: end + 1, prev: "value" };
  }

  if (c === "`") {
    const end = skipTemplate(text, i, stack, stringExt);

    return end < 0 ? { error: "unterminated template literal", at: i } : { end, prev: "value" };
  }

  // C# raw strings have no backslash escapes; their closers match the opener's
  // whole quote run, not merely three quotes.
  if (stringExt === ".cs" && text.startsWith('"""', i)) {
    const quote = /^"{3,}/.exec(text.slice(i))[0];
    const end = text.indexOf(quote, i + quote.length);

    return end < 0 ? { error: "unterminated string", at: i } : { end: end + quote.length, prev: "value" };
  }

  // Java text blocks close on an unescaped triple
  // delimiter; individual quotes and physical newlines are payload.
  const quote = stringExt === ".java" && text.startsWith('"""', i) ? '"""' : c;
  const end = skipString(text, i, quote, quote.length === 3 || rust && c === '"', [".c", ".cc", ".cpp", ".h", ".hpp"].includes(stringExt));

  return end < 0 ? { error: "unterminated string", at: i } : { end, prev: "value" };
}

function consumeSlash(text, i, prev, rust, js, stringExt) {
  const commentEnd = skipComment(text, i, rust || stringExt === ".kt" || stringExt === ".swift", js, stringExt);

  if (commentEnd !== null) {
    if (commentEnd < 0) return { error: "unterminated comment", at: i };

    // Restricted productions end at a line break, including one in a comment.
    const restricted = RESTRICTED_PRODUCTIONS.has(prev);

    return { end: commentEnd, prev: restricted && /[\r\n\u2028\u2029]/.test(text.slice(i, commentEnd)) ? ";" : prev, trivia: true };
  }

  // Slash-delimited regex literals belong to JS/TS and Swift, not the other
  // scanned dialects where JavaScript keywords can be ordinary identifiers.
  if (!js && stringExt !== ".swift") return null;

  // JS/TS class heritage and Swift try begin operands, not completed identifiers.
  if (prev !== "" && !REGEX_PRECEDERS.has(prev) && !(js && prev === "extends") && !(stringExt === ".swift" && prev === "try")) return null;
  const end = skipRegex(text, i);

  return end > 0 ? { end, prev: "value" } : null;
}

function nextExpressionToken(text, i, allowNewline = true) {
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      if (!allowNewline && /[\r\n\u2028\u2029]/.test(text[i])) return -1;
      i++;
      continue;
    }

    if (!text.startsWith("/*", i) && !text.startsWith("//", i)) break;
    const end = skipComment(text, i, false, true);

    if (end < 0 || !allowNewline && /[\r\n\u2028\u2029]/.test(text.slice(i, end))) return -1;
    i = end;
  }

  return i;
}

function expressionBlockKeyword(text, i) {
  let end = readIdentifier(text, i);
  let word = text.slice(i, end);

  if (word === "async") {
    const next = nextExpressionToken(text, end, false);

    if (next < 0) return "";
    end = readIdentifier(text, next);
    word = text.slice(next, end);

    if (word !== "function") return "";
  }

  if (word !== "function" && word !== "class") return "";
  const next = nextExpressionToken(text, end);

  // Keyword-named properties are not block expressions.
  if (next < 0 || readIdentifier(text, next) === next && !(word === "function" ? ["(", "*"].includes(text[next]) : text[next] === "{")) return "";

  return word;
}

function consumeExpressionBlock(text, i, stack, stringExt) {
  const keyword = expressionBlockKeyword(text, i);

  if (!keyword) return null;
  const { open } = firstDeclarationOpen(text, i, text.length, false, false, false, true, keyword === "function", stringExt);

  if (open < 0) return null;
  const result = scan(text, open, stack, stack.length, false, false, false, true, stringExt);

  return result.error ? result : { end: result.end, prev: "value" };
}

/** Consume a literal, expression object, comment, or update operator at i. Returns { end, prev } | { error, at } | null. */
function consumeLiteral(text, i, stack, prev, rust, cpp, go, js, prevEnd, stringExt) {
  const c = text[i];

  if (cpp && ["R", "u", "U", "L"].includes(c)) {
    const raw = consumeCppRaw(text, i);

    if (raw) return raw;
  }

  // C++ numeric tokens can contain apostrophe digit separators, exponent signs
  // and suffixes. Phase-two splices can split those tokens; retain their physical
  // extent without treating a continued separator as a character-literal opener.
  if (cpp && (/[0-9]/.test(c) || c === "." && /[0-9]/.test(text[i + 1]))) {
    const number = /^(?:[0-9]|\.[0-9])(?:[eEpP](?:\\\r?\n)*[+-]|[\w.]|'(?:\\\r?\n)*[\w]|\\\r?\n)*/.exec(text.slice(i));

    return { end: i + number[0].length, prev: "value" };
  }

  // Consume JS numeric operands atomically: a decimal's trailing dot is not a
  // member operator, whereas the second dot in 42..valueOf() is.
  if (js && (/[0-9]/.test(c) || c === "." && /[0-9]/.test(text[i + 1]))) {
    const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?/.exec(text.slice(i));

    return { end: i + number[0].length, prev: "value" };
  }

  if (rust && ["r", "b", "c"].includes(c)) {
    const raw = consumeRustRaw(text, i);

    if (raw) return raw;

    // A raw identifier is an operand, not the keyword after its r# prefix.
    if (c === "r" && text[i + 1] === "#") {
      const end = readIdentifier(text, i + 2);

      if (end > i + 2) return { end, prev: "value" };
    }
  }

  if (rust && c === "'") {
    const lifetime = /^'[\p{ID_Start}_][\p{ID_Continue}]*/u.exec(text.slice(i));
    const end = i + (lifetime?.[0].length ?? 0);

    // A closing apostrophe makes this a character literal, not a lifetime/label.
    if (lifetime && text[end] !== "'") return { end, prev: "value" };
  }

  if (stringExt === ".cs" && (c === "@" || c === "$")) {
    const literal = consumeCSharpString(text, i);

    if (literal) return literal;
  }

  // C# verbatim identifiers keep escaped keywords in operand context.
  if (stringExt === ".cs" && c === "@") {
    const end = readIdentifier(text, i + 1);

    if (end > i + 1) return { end, prev: "value" };
  }

  if (stringExt === ".swift" && (c === "#" || c === '"')) {
    const literal = consumeSwiftString(text, i) ?? consumeSwiftRegex(text, i);

    if (literal) return literal;
  }

  if (stringExt === ".kt" && c === '"') return consumeKotlinString(text, i);

  if (['"', "'", "`"].includes(c)) return consumeQuoted(text, i, stack, go, rust, stringExt);

  // An arrow is not a comparison operator; its brace opens a body, not an object.
  if (js && text.startsWith("=>", i)) return { end: i + 2, prev: "=>" };

  // A private name is one operand token, even when its name is a keyword.
  if (js && c === "#") {
    const end = readIdentifier(text, i + 1);

    if (end > i + 1) return { end, prev: "value" };
  }

  // Spread introduces an operand; its final dot is not member access.
  if (js && c === "." && text.startsWith("...", i)) return { end: i + 3, prev: "..." };

  // Postfix ! closes an operand. C# permits trivia; TypeScript excludes line
  // breaks; Swift requires left adjacency and keeps try! in prefix context.
  if (c === "!" && text[i + 1] !== "=" && prev !== "" && !REGEX_PRECEDERS.has(prev)
      && (stringExt === ".cs" || js && !/[\r\n\u2028\u2029]/.test(text.slice(prevEnd, i))
        || stringExt === ".swift" && prevEnd === i && prev !== "try")) return { end: i + 1, prev: "value" };

  // Function/class expression bodies close a value; declarations still close a
  // statement. Heritage constructors can themselves be function/class expressions.
  if (js && (OBJECT_PRECEDERS.has(prev) || prev === "new" || prev === "extends")) {
    const expression = consumeExpressionBlock(text, i, stack, stringExt);

    if (expression) return expression;
  }

  // Expression aggregates close a value, not a statement block. Consume array
  // bindings too so the declaration scanner can retain trailing continuations.
  if (c === "{" && OBJECT_PRECEDERS.has(prev) && (js || prev !== "<" && prev !== ">")
      || js && c === "[" && prev === "=") {
    const depth = stack.length;
    stack.push({ c, at: i, object: c === "{" });
    const result = scan(text, i + 1, stack, depth, rust, cpp, go, js, stringExt);

    return result.error ? result : { end: result.end, prev: "value" };
  }

  // Only postfix updates close a value. Prefix updates still expect an operand,
  // and JavaScript postfix updates cannot cross a line terminator, even in a comment.
  if ((c === "+" || c === "-") && text[i + 1] === c) {
    const prefix = prev === "" || REGEX_PRECEDERS.has(prev) || js && /[\r\n\u2028\u2029]/.test(text.slice(prevEnd, i));

    return { end: i + 2, prev: prefix ? c : "value" };
  }

  if (c !== "/") return null;

  return consumeSlash(text, i, prev, rust, js, stringExt);
}

/** Push/pop a bracket; returns an error, a stop, or null to continue. */
function bracket(c, i, stack, stopDepth, prev, js) {
  if (OPEN[c]) {
    stack.push({ c, at: i, control: c === "(" && CONTROL_PARENS.has(prev), forOf: js && c === "(" && prev === "for" });

    return null;
  }

  if (!CLOSE.has(c)) return null;
  const top = stack.pop();

  if (!top || OPEN[top.c] !== c) return { error: "unexpected '" + c + "'", at: i };

  if (stopDepth !== undefined && stack.length <= stopDepth) return { end: i + 1 };

  return null;
}

/** Skips comments, strings, templates and regex literals; `prev` is the last code token, which decides regex-vs-division. */
function scan(text, start, stack, stopDepth, rust = false, cpp = false, go = false, js = true, stringExt = "", csharpInterpolation = false) {
  const conditionals = [];
  let i = start;
  let prev = "";
  let prevEnd = start;

  while (i < text.length) {
    const c = text[i];

    if (RESTRICTED_PRODUCTIONS.has(prev) && /[\r\n\u2028\u2029]/.test(c)) prev = ";";
    const literal = consumeLiteral(text, i, stack, prev, rust, cpp, go, js, prevEnd, stringExt);

    if (literal) {
      if (literal.error) return literal;
      i = literal.end;
      prev = literal.prev;
      prevEnd = literal.trivia ? prevEnd : i;
      continue;
    }

    // A top-level interpolation colon starts a format string, not C# code.
    if (csharpInterpolation && c === ":" && stack.length === stopDepth + 1) {
      const end = text.indexOf("}", i + 1);

      if (end < 0) return { error: "unterminated string", at: i };
      i = end;
      continue;
    }

    const j = readIdentifier(text, i);

    if (j > i) {
      const word = text.slice(i, j);

      // Preserve jump labels until their line break, and `for await` control headers.
      if (prev !== "break" && prev !== "continue" && (prev !== "for" || word !== "await")) prev = identifierContext(word, prev, stack, stringExt);

      i = j;
      prevEnd = i;
      continue;
    }

    // Closing a control condition starts a statement, unlike closing a call or
    // grouped expression. Nested parens retain their own division context.
    const closesControl = c === ")" && stack.at(-1)?.control === true;
    const outcome = bracket(c, i, stack, stopDepth, prev, js);

    if (outcome) return outcome;

    if (!/\s/.test(c)) {
      prev = closesControl ? ";" : punctuationContext(text, i, stack, conditionals, js);
      prevEnd = i + 1;
    }

    i++;
  }

  return { end: i };
}

function offsetOfLine(text, line) {
  if (line <= 1) return 0;
  let n = 1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && ++n === line) return i + 1;
  }

  return -1;
}

function firstDeclarationOpen(text, start, limit, rust, cpp, go, js, typedSignature = false, stringExt = "", bodyExpected = false) {
  const stack = [];
  const conditionals = [];
  let i = start;
  let prev = "";
  let prevEnd = start;
  let depth = 0;
  let returnType = false;
  let predicateTarget = false;
  let genericDepth = 0;
  let parametersStarted = false;
  let heritageHeader = false;
  let bindingType = false;
  let typeAlias = false;

  while (i < text.length) {
    if (i >= limit) {
      // Declaration names can put parameters or TypeScript generics after trivia.
      // Completed overloads must not resume at a later expression opener.
      const nextParameters = js && bodyExpected && !parametersStarted
        && text[nextExpressionToken(text, i)] === "(";

      const nextGenerics = typedSignature && !parametersStarted
        && text[nextExpressionToken(text, i)] === "<";

      // Wrapped parameters, generic headers and return types remain unfinished
      // inside delimiters. A next-line union/intersection also continues a return
      // type; completed overloads still stop here.
      const nextTypeOperator = typedSignature && returnType && prev !== ";"
        && ["|", "&"].includes(text[nextExpressionToken(text, i)]);

      // `asserts` is a prefix only before an assertion target, not when an
      // overload returns a type alias named asserts.
      const target = prev === "asserts" ? nextExpressionToken(text, i) : -1;
      const targetEnd = target < 0 ? -1 : readIdentifier(text, target);
      const afterTarget = targetEnd > target ? nextExpressionToken(text, targetEnd, false) : -1;

      const nextAssertionTarget = targetEnd > target
        && !/^(?:export|function|class|const|var|let|import|enum|default)$/.test(text.slice(target, targetEnd))
        && (afterTarget < 0 || afterTarget === text.length || ["{", ";"].includes(text[afterTarget])
          || text.slice(afterTarget, readIdentifier(text, afterTarget)) === "is");

      // Bindings remain unfinished after assignment, an arrow, a constructor
      // prefix or an operand-introducing operator, including intervening trivia.
      const nextInitializer = js && (prev === "=" || !bodyExpected && (prev === "=>" || prev === "new" || OBJECT_PRECEDERS.has(prev)));

      // A leading member operator continues the previous initializer, unlike a
      // leading decimal literal, which can start a separate statement after ASI.
      const nextMember = js && !bodyExpected && prev !== ";"
        && (prev === "." || /^(?:\.(?![\d.])|\?\.(?!\d))/.test(text.slice(nextExpressionToken(text, i))));

      // Binary operators and declarator commas can lead continuation lines, but
      // a next-line ++/-- starts a separate prefix-update statement under ASI.
      const next = nextExpressionToken(text, i);

      const nextBinary = js && !bodyExpected && prev !== ";"
        && (/^(?:\+(?!\+)|-(?!-)|[*/%<>&|^,]|[=!]=|=(?!>)|\?\?)/.test(text.slice(next))
          || ["in", "instanceof"].includes(text.slice(next, readIdentifier(text, next))));

      // Conditional branches continue at their matching colon, not a label.
      const nextConditional = js && !bodyExpected && prev !== ";"
        && (text[next] === "?" || text[next] === ":" && conditionals.at(-1) === stack.length);

      // A tagged template can follow its tag across trivia without ending the
      // binding. A semicolon instead starts a separate untagged expression.
      const nextTaggedTemplate = js && !bodyExpected && prev !== ";" && text[next] === "`";

      // Calls may put arguments on later lines and continue after their closer.
      // A semicolon instead starts a separate parenthesized statement.
      const nextCall = js && !bodyExpected && prev !== ";" && (text[next] === "(" || depth > 0);

      // Computed members continue across trivia, including wrapped keys. An
      // explicit semicolon instead begins a standalone array expression.
      const nextComputedMember = js && !bodyExpected && prev !== ";"
        && (text[next] === "[" || stack.some(frame => frame.c === "["));

      // Class/interface declarations cannot finish before their body, including
      // wrapped heritage clauses. Keyword-named methods remain ordinary headers.
      if (!heritageHeader && !nextInitializer && !nextMember && !nextBinary && !nextConditional && !nextTaggedTemplate && !nextCall && !nextComputedMember && !nextParameters && !nextGenerics && (!typedSignature || !(depth || genericDepth || returnType && (stack.length || nextTypeOperator || nextAssertionTarget
          || [":", "|", "&", "<", ",", "?", "[", "=>", "keyof", "readonly", "typeof", "extends", "type-predicate"].includes(prev))))) break;
      const lineEnd = text.indexOf("\n", i + 1);
      limit = lineEnd < 0 ? text.length : lineEnd;
    }

    // A binding's block arrow is an initializer value. Keep scanning for later
    // declarators instead of ending the binding at this function body.
    if (js && !bodyExpected && text[i] === "{" && prev === "=>") {
      const end = balancedEnd(text, i, [], rust, cpp, go, js, stringExt);

      if (end < 0) return { open: -1, end: text.length };
      i = end;
      prev = "value";
      prevEnd = i;
      continue;
    }

    // A declaration signature ending in a generic > still opens its real body.
    if (typedSignature && depth === 0 && text[i] === "{" && prev === ">") return { open: i, end: i };
    const literal = consumeLiteral(text, i, stack, prev, rust, cpp, go, js, prevEnd, stringExt);

    if (literal) {
      if (literal.error) return { open: -1, end: limit };
      i = literal.end;

      // A multiline generic default is consumed as an expression object. Its
      // closing line still contains the signature and possibly the body opener.
      if (typedSignature && depth === 0 && i > limit) {
        const lineEnd = text.indexOf("\n", i);
        limit = lineEnd < 0 ? text.length : lineEnd;
      }

      prev = literal.prev;
      prevEnd = literal.trivia ? prevEnd : i;
      continue;
    }

    const j = readIdentifier(text, i);

    if (j > i) {
      const word = text.slice(i, j);

      if (js && bodyExpected && depth === 0 && genericDepth === 0
          && (word === "class" || typedSignature && word === "interface")) {
        const next = nextExpressionToken(text, j);

        if (word === "class" ? expressionBlockKeyword(text, i) === "class" : next >= 0 && readIdentifier(text, next) > next) heritageHeader = true;
      }

      if (js && depth === 0 && word === "type" && ["", "export", "declare"].includes(prev)
          && [".ts", ".tsx", ".mts", ".cts"].includes(stringExt)) typeAlias = true;

      const typePredicate = predicateTarget && word === "is";
      // `is` is contextual: a return alias named is (including typeof is) is
      // not a predicate. Only a leading target, optionally after asserts, is.
      predicateTarget = returnType && [":", "asserts"].includes(prev)
        && !["asserts", "typeof"].includes(word);
      // Binding annotations and type aliases introduce a type operand; in
      // value initializers these words stay identifiers.
      prev = (bindingType || typeAlias) && ["keyof", "readonly", "unique", "infer", "abstract", "extends"].includes(word) ? "="
        : typePredicate ? "type-predicate" : prev === "for" && word === "await" ? prev : identifierContext(word, prev, stack, stringExt);
      i = j;
      prevEnd = i;
      continue;
    }

    if (typedSignature && depth === 0) {
      if (text[i] === "<") genericDepth++;
      else if (text[i] === ">") genericDepth = Math.max(0, genericDepth - 1);
    }

    if (text[i] === "(") {
      if (depth === 0 && genericDepth === 0) parametersStarted = true;
      depth++;
    } else if (text[i] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && typedSignature && text[i] === ":" && prev === ")") returnType = true;

    // TypeScript generic constraints and return types can contain object types
    // before the body. Consume wrapped members without ending the declaration.
    if (depth === 0 && typedSignature && text[i] === "{" && (prev === "extends"
        || prev === "readonly" && (genericDepth > 0 || returnType)
        || genericDepth > 0 && ["keyof", "=>"].includes(prev)
        || returnType && [":", "|", "&", "<", ",", "?", "[", "=>", "keyof", "type-predicate"].includes(prev))) {
      const end = balancedEnd(text, i, [], rust, cpp, go, js, stringExt);

      if (end < 0) return { open: -1, end: limit };
      i = end;

      // The type can cross the initial line bound. Scan the rest of its closing
      // line too: a conditional-type suffix can precede the actual body there.
      if (i > limit) {
        const lineEnd = text.indexOf("\n", i);
        limit = lineEnd < 0 ? text.length : lineEnd;
      }

      prev = "value";
      prevEnd = i;
      continue;
    }

    if (depth === 0 && (text[i] === "{" || (text[i] === "[" && prev === "="))) return { open: i, end: i };
    bracket(text[i], i, stack, undefined, prev, js);

    if (!/\s/.test(text[i])) {
      // A top-level binding annotation introduces a type value, not a body.
      // Its object brace must not end the declaration before the initializer.
      const annotation = !bodyExpected && [".ts", ".tsx", ".mts", ".cts"].includes(stringExt)
        && text[i] === ":" && stack.length === 0;

      if (annotation) bindingType = true;
      else if (stack.length === 0 && ["=", ";"].includes(text[i])) bindingType = false;
      prev = annotation ? "=" : punctuationContext(text, i, stack, conditionals, js);
      prevEnd = i + 1;
    }

    i++;
  }

  // An unfinished assignment may put its aggregate initializer on the next
  // line. Use the last code token, not a textual '=', so comments cannot
  // make an already completed binding absorb a separate block.
  if (depth === 0 && prev === "=") {
    const next = js ? nextExpressionToken(text, i) : limit + /^\s*/.exec(text.slice(limit))[0].length;

    if (["{", "["].includes(text[next])) return { open: next, end: i };

    // Literal and function/class bindings can start after the assignment's newline.
    // Retain the complete expression, without absorbing a later declaration.
    if (js) {
      const expression = consumeLiteral(text, next, [], "=", rust, cpp, go, js, next, stringExt);

      if (expression) return { open: -1, end: expression.error ? text.length : expression.end };
    }
  }

  // Literal consumers can cross the first newline without exposing a bracket.
  // Preserve that extent for bindings initialized by a multiline template/raw string.
  return { open: -1, end: i };
}

function unmatchedOpenParen(text, start, limit, rust, cpp, go, js, stringExt) {
  const stack = [];
  const parens = [];
  const conditionals = [];
  let i = start;
  let prev = "";
  let prevEnd = start;

  while (i < limit) {
    const literal = consumeLiteral(text, i, stack, prev, rust, cpp, go, js, prevEnd, stringExt);

    if (literal) {
      if (literal.error) return -1;
      i = literal.end;
      prev = literal.prev;
      prevEnd = literal.trivia ? prevEnd : i;
      continue;
    }

    const j = readIdentifier(text, i);

    if (j > i) {
      prev = prev === "for" && text.slice(i, j) === "await" ? prev : identifierContext(text.slice(i, j), prev, stack, stringExt);
      i = j;
      prevEnd = i;
      continue;
    }

    if (text[i] === "(") parens.push(i);
    else if (text[i] === ")") parens.pop();
    bracket(text[i], i, stack, undefined, prev, js);

    if (!/\s/.test(text[i])) {
      prev = punctuationContext(text, i, stack, conditionals, js);
      prevEnd = i + 1;
    }

    i++;
  }

  return parens[0] ?? -1;
}

/** 1-indexed last line of a declaration block; bodyExpected permits a next-line opening brace. */
export function braceBlockEndLine(text, startLine, ext = "", bodyExpected = false) {
  ext = String(ext ?? "").toLowerCase();
  const rust = ext === ".rs";
  const go = ext === ".go";
  const js = JS_EXT.has(ext);
  const cpp = [".cc", ".cpp", ".h", ".hpp"].includes(ext);
  const start = offsetOfLine(text, startLine);

  if (start < 0) return startLine;
  const lineEnd = text.indexOf("\n", start);
  const limit = lineEnd < 0 ? text.length : lineEnd;
  const typedSignature = bodyExpected && [".ts", ".tsx", ".mts", ".cts"].includes(ext);
  const declaration = firstDeclarationOpen(text, start, limit, rust, cpp, go, js, typedSignature, ext, bodyExpected);
  let open = declaration.open;

  // Wrapped signatures and call initializers both leave an unmatched `(`.
  // A binding's call ends at its own `)`, not the next declaration's `{`.
  if (open < 0) {
    const paren = unmatchedOpenParen(text, start, Math.max(limit, declaration.end), rust, cpp, go, js, ext);

    if (paren >= 0) {
      const end = balancedEnd(text, paren, [], rust, cpp, go, js, ext);

      // Function expressions and arrow signatures still need their body.
      if (!bodyExpected && end >= 0 && !/^\s*(?:=>|\{)/.test(text.slice(end))) return lineOf(text, end - 1);
      open = firstDeclarationOpen(text, start, text.length, rust, cpp, go, js, typedSignature, ext).open;
    }
  }

  if (open < 0 && bodyExpected) {
    // A completed signature may put its body on the next line. Do not apply
    // this to bindings, where a following block can be a separate statement.
    const nextStart = Math.max(limit, declaration.end);
    const next = js ? nextExpressionToken(text, nextStart) : nextStart + /^\s*/.exec(text.slice(nextStart))[0].length;

    if (text[next] === "{") open = next;
  }

  if (open < 0) return Math.max(startLine, lineOf(text, declaration.end - 1));
  const end = balancedEnd(text, open, [], rust, cpp, go, js, ext);

  return end < 0 ? lineOf(text, Math.max(0, text.length - 1)) : lineOf(text, end - 1);
}

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".swift", ".css", ".scss"]);

/** { ok: true } | { ok: false, message }; message names the problem and line. */
export function quickCheck(text, ext) {
  ext = String(ext ?? "").toLowerCase();

  if (ext === ".json") {
    try {
      // RFC 8259: a single leading BOM is ignorable; do not flag valid JSON.
      JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

      return { ok: true, kind: "json" };
    } catch (err) {
      return { ok: false, kind: "json", message: String(err.message).replace(/^JSON\.parse: /, "") };
    }
  }

  if (!CODE_EXT.has(ext)) return null;
  const stack = [];
  const r = scan(text, 0, stack, undefined, ext === ".rs", [".cc", ".cpp", ".h", ".hpp"].includes(ext), ext === ".go", JS_EXT.has(ext), ext);

  if (r.error) return { ok: false, kind: "balance", message: r.error + " at line " + lineOf(text, r.at) };

  if (stack.length) {
    const top = stack[stack.length - 1];

    return { ok: false, kind: "balance", message: "unclosed '" + top.c + "' opened at line " + lineOf(text, top.at) };
  }

  return { ok: true, kind: "balance" };
}
