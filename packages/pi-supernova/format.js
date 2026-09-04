import { isString, isObject } from "./decode.js";

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

function formatFlatList(value) {
  if (value.length === 0) return "[]";
  let out = "[";
  for (let i = 0; i < value.length; i++) out += (i ? "," : "") + formatFlat(value[i] === undefined ? null : value[i]);
  return out + "]";
}

function formatFlat(value) {
  if ((!isObject(value) && !Array.isArray(value))) return formatPrimitive(value);
  if (Array.isArray(value)) return formatFlatList(value);
  let out = "";
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    out += (out ? "," : "{") + formatKey(key) + ":" + formatFlat(value[key]);
  }
  return out ? out + "}" : "{}";
}

/**
 * Compact JS-literal rendering for the model: containers that fit in FORMAT_WIDTH
 * stay on one line with no separator whitespace, identifier keys are unquoted,
 * indent is one space. Whitespace is what costs tokens: this measures ~43% fewer
 * than JSON.stringify(value, null, 2) on typical shaped returns (gpt-tokenizer).
 */
export function formatValue(value, indent = "", width = FORMAT_WIDTH) {
  const flat = formatFlat(value);
  if ((!isObject(value) && !Array.isArray(value)) || flat.length + indent.length <= width) return flat;
  const pad = indent + " ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map((item) => pad + formatValue(item === undefined ? null : item, pad, width)).join(",\n") + "\n" + indent + "]";
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (keys.length === 0) return "{}";
  return "{\n" + keys.map((key) => pad + formatKey(key) + ":" + formatValue(value[key], pad, width)).join(",\n") + "\n" + indent + "}";
}
