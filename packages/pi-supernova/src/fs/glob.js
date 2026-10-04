const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const utf8Bytes = text => Buffer.from(text, "utf8").toString("latin1");

// Ripgrep glob wildcards and classes consume UTF-8 bytes, not UTF-16 characters.
class Utf8GlobRegExp extends RegExp {
  test(filePath) {
    return super.test(utf8Bytes(filePath));
  }
}

/** Translate one glob token at index i → [regexSource, nextIndex]. */
function globToken(glob, i, branchStart = false, inGroup = false) {
  const ch = glob[i];

  if (ch === "\\" && i + 1 < glob.length) return [glob[i + 1].replace(REGEX_SPECIAL, "\\$&"), i + 2];

  if (ch === "*" && glob[i + 1] === "*") {
    const slashAfter = glob[i + 2] === "/";
    // Brace endings terminate slash-prefixed recursive suffixes, not bare ** branches.
    const branchSuffix = inGroup && glob[i - 1] === "/" && (glob[i + 2] === "," || glob[i + 2] === "}");
    const recursive = (branchStart || i === 0 || glob[i - 1] === "/") && (slashAfter || i + 2 === glob.length || branchSuffix);

    if (!recursive) return ["[^/]*", i + 2];

    return [slashAfter ? "(?:.*/)?" : ".*", i + (slashAfter ? 3 : 2)];
  }

  if (ch === "*") return ["[^/]*", i + 1];

  if (ch === "?") return ["[^/]", i + 1];

  if (ch === "{" || ch === "[") return globGroup(glob, i, ch);

  return [ch.replace(REGEX_SPECIAL, "\\$&"), i + 1];
}

/** {a,b} alternation or [..] class starting at i. */
function globGroup(glob, i, open) {
  if (open === "{") {
    const alternatives = [];
    let source = "", next = i + 1, branchStart = true;

    while (next < glob.length) {
      if (glob[next] === "}" || glob[next] === ",") {
        // rg discards empty alternatives; an all-empty group contributes no text.
        if (source) alternatives.push(source);

        if (glob[next] === "}") return [alternatives.length ? "(?:" + alternatives.join("|") + ")" : "", next + 1];
        source = "";
        next++;
        branchStart = true;
        continue;
      }

      // Nested groups and escaped punctuation belong to a single alternative.
      const [piece, end] = globToken(glob, next, branchStart, true);
      source += piece;
      next = end;
      branchStart = false;
    }

    throw new SyntaxError("unclosed { in glob");
  }

  let start = i + 1;

  if (glob[start] === "!" || glob[start] === "^") start++;

  // A leading ] after optional negation is a member, not the class terminator.
  if (glob[start] === "]") start++;

  const end = glob.indexOf("]", start);

  if (end < 0) throw new SyntaxError("unclosed [ in glob");
  // rg treats class backslashes literally and chained ranges replace the last
  // range's endpoint: [a-c-e] is a-e, while [a-c-b] is a-b.
  const negated = glob[i + 1] === "!" || glob[i + 1] === "^";
  const inner = glob.slice(i + 1 + (negated ? 1 : 0), end);
  const ranges = [];

  for (let j = 0; j < inner.length; j++) {
    if (inner[j] === "-" && ranges.length && j + 1 < inner.length) {
      const range = ranges.at(-1);
      range[1] = inner[++j];

      if (range[0] > range[1]) throw new SyntaxError("invalid range in glob");
    } else ranges.push([inner[j], inner[j]]);
  }

  const escapeByte = byte => "\\][^-".includes(byte) ? "\\" + byte : byte;
  const source = "[" + (negated ? "^" : "") + ranges.map(([first, last]) => escapeByte(first) + (first === last ? "" : "-" + escapeByte(last))).join("") + "]";

  return [source, end + 1];
}

function globBody(glob) {
  let source = "";
  let i = 0;

  while (i < glob.length) {
    const [piece, next] = globToken(glob, i);
    source += piece;
    i = next;
  }

  return source;
}

/** gitignore-style glob (rg -g) → RegExp over a "/"-separated relative path. No slash ⇒ basename match anywhere. */
export function globToRegExp(glob) {
  const excluded = glob.startsWith("!");

  if (excluded) glob = glob.slice(1);
  const rooted = glob.startsWith("/");
  const directoryOnly = excluded && glob.endsWith("/");

  if (directoryOnly) {
    glob = glob.slice(0, -1);
    // Removing an escaped separator must not leave its escape as filename payload.
    const escapes = /\\+$/.exec(glob)?.[0].length ?? 0;

    if (escapes % 2) glob = glob.slice(0, -1);
  }

  const anchored = rooted || glob.includes("/");

  if (glob.startsWith("/")) glob = glob.slice(1);
  const body = globBody(utf8Bytes(glob));

  // An excluded directory prunes its descendants, not only an exact path.
  // Dot-all keeps CR/LF filename bytes inside recursive and basename prefixes.
  if (excluded) return new Utf8GlobRegExp("^(?!" + (anchored ? "" : "(?:.*/)?") + body + (directoryOnly ? "/" : "(?:/|$)") + ")[\\s\\S]*$", "s");

  return new Utf8GlobRegExp(anchored ? "^" + body + "$" : "(?:^|/)" + body + "$", "s");
}
