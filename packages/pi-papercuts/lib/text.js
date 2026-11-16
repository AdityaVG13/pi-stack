import { stripVTControlCharacters } from "node:util";

// C0/C1 controls other than tab and newline: replaying them to a TTY executes them.
const CONTROL_SOURCE = "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f";

const HAS_CONTROL = new RegExp(`[${CONTROL_SOURCE}]`);

const ALL_CONTROLS = new RegExp(`[${CONTROL_SOURCE}]`, "g");

/** Terminal-safe text: ANSI sequences and executable controls removed, tab/newline kept, CR normalized. */
export function displayText(value) {
  const stripped = stripVTControlCharacters(String(value ?? ""));

  // Hot path: most rows have no controls, so skip both rewrite passes.
  if (!HAS_CONTROL.test(stripped)) return stripped;

  return stripped.replace(/\r\n?/g, "\n").replace(ALL_CONTROLS, "");
}

/** One visual line: terminal-safe, whitespace collapsed. Used for every inline field. */
export function flattenText(value) {
  return displayText(value).replace(/\s+/g, " ").trim();
}

/** At most maxChars UTF-16 units including the ellipsis, never splitting a surrogate pair. */
export function clipText(value, maxChars) {
  const text = flattenText(value);

  if (text.length <= maxChars) return text;
  let end = maxChars - 1;

  if (text.codePointAt(end - 1) > 0xffff) end--;

  return `${text.slice(0, end)}…`;
}
