import {isString,isObject} from './decode.js';

export function textResult(text, details) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details: details || {},
  };
}

export function resultDiff(response) {
  let details = response?.details;

  if (isString(details)) {
    try {
      details = JSON.parse(details);
    } catch {
      return undefined;
    }
  }

  return isObject(details) ? details.diff : undefined;
}

// Only native adapters can attach this host-local marker. It never crosses RPC;
// the bridge sends a typed-value flag instead of asking the guest to guess JSON.
export const READ_VALUE = Symbol("native read value");

export const READ_BYTES = Symbol("native read bytes");

export const READ_PREVIEW = Symbol("native read preview");

// Host-only disk-read provenance, not user data or a claim about displayed text.
export const READ_FILES = Symbol("native disk reads");

export const MAX_READ_VALUE_BYTES = 64 * 1024 * 1024;

function containerBytes(value, pending, seen, remaining) {
  if (seen.has(value)) return 8;
  seen.add(value);
  let bytes = 32;

  if (bytes > remaining) return bytes;
  const array = Array.isArray(value);
  const keys = array ? null : Object.keys(value);

  for (let i = 0; i < (array ? value.length : keys.length); i++) {
    const key = array ? i : keys[i];
    bytes += array ? 8 : 24 + 2 * key.length;

    if (bytes > remaining) break;
    // Charge scalar strings at their owning edge; only containers need
    // a deferred visit for alias tracking and child traversal.
    const item = value[key];

    if (isString(item)) bytes += 2 * item.length;
    else if (isObject(item) || Array.isArray(item)) pending.push(item);
  }

  return bytes;
}

/** Conservative storage estimate, bounded while walking and aware of aliases. */
export function readValueBytes(value, limit = Infinity, seen = new WeakSet()) {
  const pending = [value];
  let bytes = 0;

  while (pending.length) {
    const item = pending.pop();

    if (isString(item)) bytes += 2*item.length;
    else if (isObject(item) || Array.isArray(item)) bytes += containerBytes(item,pending,seen,limit-bytes);
    else bytes += 8;

    if (bytes > limit) throw new Error("read value exceeds " + limit + " bytes of remaining storage budget; select fewer fields or smaller slices");
  }

  return bytes;
}

export function readResult(value, details = {}, preview = isString(value) ? value : "", bytes = readValueBytes(value), render) {
  let content;

  // Native consumers retain their text-content API. The bridge/trace use the
  // typed value/preview, so ordinary RPCs never serialize this second copy.
  return {get content() {
    const text = () => render ? render() : isString(value) && !details.json ? value : JSON.stringify(value);

    return content ??= [{type:"text",text:text()}];
  }, details, [READ_VALUE]:value, [READ_BYTES]:bytes, [READ_PREVIEW]:preview};
}

export function asReadResult(raw) {
  if (Object.hasOwn(raw, READ_VALUE)) return raw;
  const image = raw.content?.find(part => part.type === "image");
  const value = image ?? raw.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";

  return { ...raw, [READ_VALUE]: value, [READ_BYTES]: readValueBytes(value) };
}
