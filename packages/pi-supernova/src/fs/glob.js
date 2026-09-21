const REGEX_SPECIAL = /[.+^${}()|\\]/g;

/** Translate one glob token at index i → [regexSource, nextIndex]. */
function globToken(glob, i) {
  const ch = glob[i];

  if (ch === "*" && glob[i + 1] === "*") {
    const slashAfter = glob[i + 2] === "/";

    return [slashAfter ? "(?:.*/)?" : ".*", i + (slashAfter ? 3 : 2)];
  }

  if (ch === "*") return ["[^/]*", i + 1];

  if (ch === "?") return ["[^/]", i + 1];

  if (ch === "{" || ch === "[") return globGroup(glob, i, ch);

  return [ch.replace(REGEX_SPECIAL, "\\$&"), i + 1];
}

/** {a,b} alternation or [..] class starting at i. */
function globGroup(glob, i, open) {
  const close = open === "{" ? "}" : "]";
  const end = glob.indexOf(close, i);

  if (end < 0) throw new SyntaxError("unclosed " + open + " in glob");
  const inner = glob.slice(i + 1, end);
  const source = open === "{"
    ? "(?:" + inner.split(",").map(globBody).join("|") + ")"
    : "[" + (inner.startsWith("!") ? "^" + inner.slice(1) : inner) + "]";

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
  const body = globBody(glob);

  return new RegExp(glob.includes("/") ? "^" + body + "$" : "(?:^|/)" + body + "$");
}
