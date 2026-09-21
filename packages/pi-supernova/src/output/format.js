import { isString, isObject, mapChangedChildren } from "../shared/decode.js";
import {maxJsonStringPrefix} from "../fs/json-size.js";

function normalizeText(text) {
  return isString(text) ? text : String(text ?? "");
}

function charLimit(maxChars, length) {
  const numericLimit = Number(maxChars);

  return Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : numericLimit === Infinity ? length : 0;
}

function truncatedSlice(text, end) {
  return { text: text.slice(0, headEnd(text, end)), truncated: true, originalChars: text.length };
}

function truncateHeadTail(normalized, limit, label) {
  let head = headEnd(normalized, Math.floor(limit * 0.7));
  let tail = 0;
  let marker = "";

  for (;;) {
    const omitted = normalized.length - head - tail;
    marker = "\n…[" + label + " truncated " + omitted + " chars]…\n";

    if (marker.length > limit) return truncatedSlice(normalized, limit);
    const budget = limit - marker.length;
    const nextHead = headEnd(normalized, Math.min(head, budget));
    const nextTail = normalized.length - tailStartIndex(normalized, Math.max(0, budget - nextHead));

    if (nextHead === head && nextTail === tail) break;
    head = nextHead;
    tail = nextTail;
  }

  return { text: normalized.slice(0, head) + marker + normalized.slice(normalized.length - tail), truncated: true, originalChars: normalized.length };
}

export function truncateChars(text, maxChars, label = "value") {
  const normalized = normalizeText(text);
  const limit = charLimit(maxChars, normalized.length);

  if (normalized.length <= limit) return { text: normalized, truncated: false };

  if (limit <= 100) return truncatedSlice(normalized, limit);

  return truncateHeadTail(normalized, limit, label);
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

export function isStringArray(value) {
  if (!Array.isArray(value) || !value.length) return false;
  for (const item of value) if (!isString(item)) return false;
  return true;
}

function hasWellFormedStrings(values) {
  for (const value of values) if (!isString(value) || hasUnpairedSurrogate(value)) return false;

  return true;
}

function boundedStringText(value, limit) {
  const text = truncateChars(value,limit,"return").text;
  return hasUnpairedSurrogate(text) ? truncateChars(JSON.stringify(text),limit,"return").text : text;
}

/** Give displayed array items a fair share; disclose any omitted items. */
export function formatBoundedStringArray(values, budget) {
  const n = values.length;
  const header = "strings[" + n + "]\n";
  let remaining = Math.max(0, budget - header.length);
  let out = header;
  if (header.length >= budget) return truncateChars(header,budget,"return").text;
  const omitted = count => "…[return truncated; " + count + " string items omitted]…\n";

  for (let i = 0; i < n; i++) {
    const itemHeader = "[" + i + "] " + values[i].length + " UTF-16 units\n";
    const footer = i + 1 < n ? omitted(n - i - 1) : "";
    if (remaining < itemHeader.length + Math.min(32,values[i].length) + 1 + footer.length) {
      return out + truncateChars(omitted(n - i),remaining,"return").text;
    }
    const per = Math.min(remaining - itemHeader.length - 1 - footer.length, Math.max(32, Math.floor(remaining / (n - i)) - itemHeader.length - 1));
    const chunk = itemHeader + boundedStringText(values[i],per) + "\n";
    remaining = Math.max(0, remaining - chunk.length);
    out += chunk;
  }

  return out;
}

function formatRawStringArray(value) {
  if (!(Array.isArray(value) && value.length && hasWellFormedStrings(value) && value.some(text => text.includes("\n")))) return null;
  const raw = "strings[" + value.length + "]\n" + value.map((text, i) => "[" + i + "] " + text.length + " UTF-16 units\n" + text + "\n").join("");
  const escapedSize = value.reduce((sum, text) => sum + JSON.stringify(text).length, value.length + 1);

  return raw.length < escapedSize ? raw : null;
}

function rawStringSize(input) {
  if (!isString(input) || !input.includes("\n") || hasUnpairedSurrogate(input)) return 0;
  const size = JSON.stringify(input).length;

  return size - input.length > 64 ? size : 0;
}

function visitRawStrings(input, acc) {
  const size = rawStringSize(input);

  if (size) {
    const index = acc.strings.push(input) - 1;
    acc.escapedChars += size;

    return { [RAW_TEXT]: "raw[" + index + "]" };
  }

  return mapChangedChildren(input, visitRawStrings, acc);
}

function framedReturn(value) {
  const acc = { strings: [], escapedChars: 0 };
  const referencedValue = visitRawStrings(value, acc);
  const { strings } = acc;

  if (!strings.length) return formatValue(value);
  // Keep every key, value, duplicate string and byte. References are unquoted
  // expressions, so literal "raw[0]" values and header-like source cannot collide.
  const framed = formatValue(referencedValue) + "\nraw strings[" + strings.length + "]\n" + strings.map((text, i) => "raw[" + i + "] " + text.length + " UTF-16 units\n" + text + "\n").join("");

  // The ordinary rendering contains at least these complete escaped literals.
  // If framing beats even that lower bound, do not build the discarded rendering.
  if (framed.length < acc.escapedChars) return framed;
  const escaped = formatValue(value);

  return framed.length < escaped.length ? framed : escaped;
}

/** Lossless framing for source arrays, not string escaping or source compression. */
export function formatReturn(value) {
  if (isString(value)) return hasUnpairedSurrogate(value) ? JSON.stringify(value) : value;
  const rawArray = formatRawStringArray(value);

  if (rawArray !== null) return rawArray;

  return framedReturn(value);
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

  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
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

  return walkFlat(value, push, new Set()) ? parts.join("") : null;
}

function walkFlatArray(value, push, seen) {
  if (value.length === 0) return push("[]");

  if (!push("[")) return false;

  for (let i = 0; i < value.length; i++) {
    if (i && !push(",")) return false;

    if (!walkFlat(value[i] === undefined ? null : value[i], push, seen)) return false;
  }

  return push("]");
}

function walkFlatObject(value, push, seen) {
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);

  if (keys.length === 0) return push("{}");

  for (let i = 0; i < keys.length; i++) {
    if (!push((i ? "," : "{") + formatKey(keys[i]) + ":")) return false;

    if (!walkFlat(value[keys[i]], push, seen)) return false;
  }

  return push("}");
}

function walkFlat(value, push, seen) {
  if (value?.[RAW_TEXT] !== undefined) return push(value[RAW_TEXT]);

  if (!isObject(value) && !Array.isArray(value)) return push(formatPrimitive(value));

  if (seen.has(value)) return push("[Circular]");
  seen.add(value);

  try {
    return Array.isArray(value) ? walkFlatArray(value, push, seen) : walkFlatObject(value, push, seen);
  } finally {
    seen.delete(value);
  }
}

function definedKeys(value) {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

function formatArray(value, indent, width, seen) {
  if (value.length === 0) return "[]";
  const pad = indent + " ";

  return "[\n" + value.map((item) => pad + formatValue(item === undefined ? null : item, pad, width, seen)).join(",\n") + "\n" + indent + "]";
}

function formatObject(value, indent, width, seen) {
  const keys = definedKeys(value);

  if (keys.length === 0) return "{}";
  const pad = indent + " ";

  return "{\n" + keys.map((key) => pad + formatKey(key) + ":" + formatValue(value[key], pad, width, seen)).join(",\n") + "\n" + indent + "}";
}

/**
 * Compact JS-literal rendering for the model: containers that fit in FORMAT_WIDTH
 * stay on one line with no separator whitespace, identifier keys are unquoted,
 * indent is one space. Whitespace is what costs tokens: this measures ~43% fewer
 * than JSON.stringify(value, null, 2) on typical shaped returns (gpt-tokenizer).
 */
export function formatValue(value, indent = "", width = FORMAT_WIDTH, seen = new Set()) {
  if (value?.[RAW_TEXT] !== undefined) return value[RAW_TEXT];

  if (!isObject(value) && !Array.isArray(value)) return formatPrimitive(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  try {
    const flat = formatFlatWithin(value, width - indent.length);

    if (flat !== null) return flat;

    return Array.isArray(value) ? formatArray(value, indent, width, seen) : formatObject(value, indent, width, seen);
  } finally {
    seen.delete(value);
  }
}


function displayKeys(value) {
  return Array.isArray(value) ? value.keys() : Object.keys(value);
}

/** A cheap lower bound stops before expanding large/shared result subtrees. */
export function displayExceeds(value, budget) {
  const seen = new Set();
  const spend = units => (budget -= units) < 0;
  function container(item) {
    if (seen.has(item)) return false;
    seen.add(item);
    const array = Array.isArray(item);
    if (array && spend(item.length)) return true;
    for (const key of displayKeys(item)) {
      if (!array && spend(key.length+1)) return true;
      if (visit(item[key])) return true;
    }
    seen.delete(item);
    return false;
  }
  function visit(item) {
    if (spend(isString(item) ? item.length : 1)) return true;
    return isObject(item) || Array.isArray(item) ? container(item) : false;
  }
  return visit(value);
}

/** Display-only prefix; never constructs an oversized JSON/string rendering. */
export function formatBoundedValue(value, budget, label = "return") {
  const footer = "\n…["+label+" truncated]…";
  const parts = [];
  const seen = new Set();
  let remaining = Math.max(0,budget-footer.length), stopped = false;
  const push = text => {
    if (text.length > remaining) { stopped = true; return false; }
    remaining -= text.length; parts.push(text); return true;
  };
  function quoted(text) {
    const end = maxJsonStringPrefix(text,remaining);
    push(JSON.stringify(text.slice(0,end)));
    if (end < text.length) stopped = true;
  }
  function visitChild(item,key,array) {
    if (!array) { quoted(key); push(":"); }
    visit(array && item[key] === undefined ? null : item[key]);
  }
  function container(item) {
    if (seen.has(item)) { push('"[Circular]"'); return; }
    seen.add(item);
    const array = Array.isArray(item);
    push(array ? "[" : "{");
    let first = true;
    for (const key of displayKeys(item)) {
      if (stopped) break;
      if (!first) push(",");
      first = false;
      visitChild(item,key,array);
    }
    if (!stopped) push(array ? "]" : "}");
    seen.delete(item);
  }
  function visit(item) {
    if (stopped) return;
    if (isString(item)) quoted(item);
    else if (isObject(item) || Array.isArray(item)) container(item);
    else push(formatPrimitive(item));
  }
  visit(value);
  return truncateChars(parts.join("")+footer,budget,"return").text;
}
