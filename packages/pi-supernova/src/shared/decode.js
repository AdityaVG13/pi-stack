const toStr = Object.prototype.toString;

export const isString = (v) => toStr.call(v) === "[object String]";
export const isObject = (v) => toStr.call(v) === "[object Object]";
export const isFunction = (v) => toStr.call(v) === "[object Function]" || v instanceof Function;
export const isNumber = (v) => toStr.call(v) === "[object Number]" && Number.isFinite(v);

const MAX_DEPTH = 64;
const MAX_TYPED_ARRAY = 4096;

function plainFromBinary(value) {
  const bytes = value.byteLength;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  else if (value instanceof DataView) value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value.length > MAX_TYPED_ARRAY) return "[" + value.constructor.name + " " + bytes + " bytes]";
  return value instanceof BigInt64Array || value instanceof BigUint64Array
    ? Array.from(value, x => x.toString() + "n")
    : Array.from(value);
}

function plainFromMap(value, seen, depth) {
  const allStringKeys = [...value.keys()].every(isString);
  if (!allStringKeys) return [...value].map(([k, v]) => [toPlain(k, seen, depth + 1), toPlain(v, seen, depth + 1)]);
  const out = Object.create(null);
  for (const [k, v] of value) out[k] = toPlain(v, seen, depth + 1);
  return out;
}

function plainFromCollection(value, seen, depth) {
  if (Array.isArray(value)) return value.map((x) => toPlain(x, seen, depth + 1));
  if (value instanceof Set) return [...value].map((x) => toPlain(x, seen, depth + 1));
  if (value instanceof Map) return plainFromMap(value, seen, depth);
  const out = Object.create(null);
  for (const k of Object.keys(value)) out[k] = toPlain(value[k], seen, depth + 1);
  return out;
}

/** Convert any guest value to structured-clone-safe, JSON-shaped data. */
export function toPlain(value, seen = new Set(), depth = 0) {
  if (value === null || value === undefined) return value;
  const tag = toStr.call(value);
  if (tag === "[object String]" || tag === "[object Number]" || tag === "[object Boolean]") return value.valueOf();
  if (tag === "[object BigInt]") return value.toString() + "n";
  if (isFunction(value)) return "[Function" + (value.name ? " " + value.name : "") + "]";
  if (tag === "[object Symbol]") return value.toString();
  if (depth > MAX_DEPTH) return "[Depth]";
  if (seen.has(value)) return "[Circular]";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    if (value.cause !== undefined) out.cause = toPlain(value.cause, seen, depth + 1);
    return out;
  }
  if (value instanceof Promise) return "[Promise]";
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return plainFromBinary(value);
  if (isFunction(value.toJSON)) return toPlain(value.toJSON(), seen, depth + 1);
  seen.add(value);
  try {
    return plainFromCollection(value, seen, depth);
  } finally {
    seen.delete(value);
  }
}

// ---- RPC to the host thread ----

