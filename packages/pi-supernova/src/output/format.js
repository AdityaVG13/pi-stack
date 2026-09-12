import { isString, isObject } from "../shared/decode.js";

export function truncateChars(text, maxChars, label = "value") {
  const normalized = isString(text) ? text : String(text ?? "");
  const numericLimit = Number(maxChars);
  const limit = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : numericLimit === Infinity ? normalized.length : 0;

  if (normalized.length <= limit) return { text: normalized, truncated: false };

  if (limit <= 100) {
    return {
      text: normalized.slice(0, headEnd(normalized, limit)),
      truncated: true,
      originalChars: normalized.length,
    };
  }

  let head = headEnd(normalized, Math.floor(limit * 0.7));
  let tail = 0;
  let marker = "";

  for (;;) {
    const omitted = normalized.length - head - tail;
    marker = "\n…[" + label + " truncated " + omitted + " chars]…\n";

    if (marker.length > limit) return { text: normalized.slice(0, headEnd(normalized, limit)), truncated: true, originalChars: normalized.length };
    const budget = limit - marker.length;
    const nextHead = headEnd(normalized, Math.min(head, budget));
    const nextTail = normalized.length - tailStartIndex(normalized, Math.max(0, budget - nextHead));

    if (nextHead === head && nextTail === tail) break;
    head = nextHead;
    tail = nextTail;
  }

  return { text: normalized.slice(0, head) + marker + normalized.slice(normalized.length - tail), truncated: true, originalChars: normalized.length };
}

// Lone surrogates in a tool result make the message invalid UTF-8 at the API
// boundary, so a cut must never split a surrogate pair.
function headEnd(text, end) {
  const code = text.charCodeAt(end - 1);

  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function tailStartIndex(text, tail) {
  if (tail <= 0) return text.length;
  const start = text.length - tail;
  const code = text.charCodeAt(start);

  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

// Unicode mode matches lone surrogate code points, not valid UTF-16 pairs.
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

// Without the Unicode flag this class matches any surrogate code unit, including
// the halves of a valid pair, so it is a strictly wider test. Source text almost
// never contains a surrogate at all, and the wide scan decides those strings on
// its own; only text that really has one pays for the precise Unicode pass.
const SURROGATE_CODE_UNIT = /[\uD800-\uDFFF]/;

function hasUnpairedSurrogate(text) {
  return SURROGATE_CODE_UNIT.test(text) && UNPAIRED_SURROGATE.test(text);
}

function hasWellFormedStrings(values) {
  for (const value of values) if (!isString(value) || hasUnpairedSurrogate(value)) return false;

  return true;
}

/** Keep every array item in an oversized return by giving each a fair truncated share. */
export function formatBoundedStringArray(values, budget) {
  const n = values.length;
  const header = "strings[" + n + "]\n";
  let remaining = Math.max(0, budget - header.length);
  let out = header;

  for (let i = 0; i < n; i++) {
    const itemHeader = "[" + i + "] " + values[i].length + " UTF-16 units\n";
    const per = Math.max(32, Math.floor(remaining / (n - i)) - itemHeader.length - 1);
    const bounded = truncateChars(values[i], per, "return");
    const chunk = itemHeader + bounded.text + "\n";
    remaining = Math.max(0, remaining - chunk.length);
    out += chunk;
  }

  return out;
}

/** Lossless framing for source arrays, not string escaping or source compression. */
export function formatReturn(value) {
  if (isString(value)) return value;

  if (Array.isArray(value) && value.length && hasWellFormedStrings(value) && value.some(text => text.includes("\n"))) {
    const raw = "strings[" + value.length + "]\n" + value.map((text, i) => "[" + i + "] " + text.length + " UTF-16 units\n" + text + "\n").join("");
    const escapedSize = value.reduce((sum, text) => sum + JSON.stringify(text).length, value.length + 1);

    if (raw.length < escapedSize) return raw;
  }

  const escaped = formatValue(value);
  const strings = [];

  const visit = input => {
    if (isString(input) && input.includes("\n") && !hasUnpairedSurrogate(input) && JSON.stringify(input).length - input.length > 64) {
      const index = strings.push(input) - 1;

      return { [RAW_TEXT]: "raw[" + index + "]" };
    }

    if (Array.isArray(input)) return input.map(visit);

    if (isObject(input)) return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child)]));

    return input;
  };

  const referencedValue = visit(value);

  if (!strings.length) return escaped;
  // Keep every key, value, duplicate string and byte. References are unquoted
  // expressions, so literal "raw[0]" values and header-like source cannot collide.
  const framed = formatValue(referencedValue) + "\nraw strings[" + strings.length + "]\n" + strings.map((text, i) => "raw[" + i + "] " + text.length + " UTF-16 units\n" + text + "\n").join("");

  return framed.length < escaped.length ? framed : escaped;
}

const RAW_TEXT = Symbol("raw text reference");

const IDENT_KEY = /^[A-Za-z_$][\w$]*$/;

const FORMAT_WIDTH = 120;

function formatKey(key) {
  return IDENT_KEY.test(key) ? key : JSON.stringify(key);
}

function formatPrimitive(value) {
  if (value === undefined) return "undefined";

  if (Number.isNaN(value) || value === Infinity || value === -Infinity) return String(value);

  return JSON.stringify(value) ?? String(value);
}

/**
 * Single-line rendering that gives up the moment it would exceed `limit` characters.
 *
 * formatValue consults this at every level, so the previous build-the-whole-string
 * form re-walked each subtree once per ancestor: a container that is too wide paid
 * the full cost of its children and then paid for them again while descending.
 * Abandoning at the budget keeps the pass linear. Returning null is exactly
 * equivalent to "the flat form is longer than limit", because an abandoned walk
 * always has at least `used` characters still to come.
 */
function formatFlatWithin(value, limit) {
  const parts = [];
  let used = 0;

  const push = (chunk) => {
    if (used + chunk.length > limit) return false;
    used += chunk.length;
    parts.push(chunk);

    return true;
  };

  return walkFlat(value, push) ? parts.join("") : null;
}

function walkFlat(value, push) {
  if (value?.[RAW_TEXT] !== undefined) return push(value[RAW_TEXT]);

  if (!isObject(value) && !Array.isArray(value)) return push(formatPrimitive(value));

  if (Array.isArray(value)) {
    if (value.length === 0) return push("[]");

    if (!push("[")) return false;

    for (let i = 0; i < value.length; i++) {
      if (i && !push(",")) return false;

      if (!walkFlat(value[i] === undefined ? null : value[i], push)) return false;
    }

    return push("]");
  }

  const keys = Object.keys(value).filter((key) => value[key] !== undefined);

  if (keys.length === 0) return push("{}");

  for (let i = 0; i < keys.length; i++) {
    if (!push((i ? "," : "{") + formatKey(keys[i]) + ":")) return false;

    if (!walkFlat(value[keys[i]], push)) return false;
  }

  return push("}");
}

/**
 * Compact JS-literal rendering for the model: containers that fit in FORMAT_WIDTH
 * stay on one line with no separator whitespace, identifier keys are unquoted,
 * indent is one space. Whitespace is what costs tokens: this measures ~43% fewer
 * than JSON.stringify(value, null, 2) on typical shaped returns (gpt-tokenizer).
 */
export function formatValue(value, indent = "", width = FORMAT_WIDTH) {
  if (value?.[RAW_TEXT] !== undefined) return value[RAW_TEXT];

  if (!isObject(value) && !Array.isArray(value)) return formatPrimitive(value);
  const flat = formatFlatWithin(value, width - indent.length);

  if (flat !== null) return flat;
  const pad = indent + " ";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    return "[\n" + value.map((item) => pad + formatValue(item === undefined ? null : item, pad, width)).join(",\n") + "\n" + indent + "]";
  }

  const keys = Object.keys(value).filter((key) => value[key] !== undefined);

  if (keys.length === 0) return "{}";

  return "{\n" + keys.map((key) => pad + formatKey(key) + ":" + formatValue(value[key], pad, width)).join(",\n") + "\n" + indent + "}";
}
