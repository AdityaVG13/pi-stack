const toStr = Object.prototype.toString;

export const isString = (v) => toStr.call(v) === "[object String]";

export const isObject = (v) => toStr.call(v) === "[object Object]";

export const isFunction = (v) => toStr.call(v) === "[object Function]" || v instanceof Function;

export const isNumber = (v) => toStr.call(v) === "[object Number]" && Number.isFinite(v);

/** Path-shaped if it has a slash, is relative, or has a file extension. Identifiers are not paths. */
export function looksLikePath(target) {
  return (
    isString(target) &&
    (target.includes("/") ||
      target.includes("\\") ||
      target.startsWith(".") ||
      (!/\s/.test(target) && /\.[A-Za-z0-9]+$/.test(target)))
  );
}

/** Transform children without copying unchanged result trees. Never mutate the input. */
export function mapChangedChildren(value, visit, context) {
  const array = Array.isArray(value);

  if (!array && !isObject(value)) return value;
  let out = value;

  for (const key of childKeys(value)) {
    const before = value[key];
    const after = visit(before, context, key);

    if (Object.is(before, after)) continue;
    if (out === value) out = array ? value.slice() : { ...value };
    // Define rather than assign: "__proto__" must remain an ordinary data key.
    Object.defineProperty(out, key, { value: after, enumerable: true, writable: true, configurable: true });
  }

  return out;
}

const MODEL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Reject unsupported attachments before they can poison the next model request. */
export function assertModelImageMime(mimeType) {
  if (!MODEL_IMAGE_MIMES.has(mimeType)) {
    throw new Error("unsupported image attachment type " + mimeType + "; model images require PNG, JPEG, GIF, or WebP. Convert the image to PNG before reading/returning it; no image attached");
  }
}

/** Node's base64 decoder is permissive; model attachments must not be. */
export function decodeImageData(data) {
  const bytes = Buffer.from(data,"base64");
  if (!data || bytes.toString("base64") !== String(data)) {
    throw new Error("invalid image base64; use canonical padded base64 without a data-URL prefix or extra characters; no image attached");
  }
  return bytes;
}

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

  for (const k of childKeys(value)) out[k] = toPlain(value[k], seen, depth + 1);

  return out;
}

function withSeen(value, seen, fn) {
  seen.add(value);

  try { return fn(); }
  finally { seen.delete(value); }
}

function functionLabel(value) {
  return "[Function" + (value.name ? " " + value.name : "") + "]";
}

function plainByTag(value, tag) {
  if (["[object String]", "[object Number]", "[object Boolean]"].includes(tag)) return { hit: true, out: value.valueOf() };

  if (tag === "[object BigInt]") return { hit: true, out: value.toString() + "n" };

  if (tag === "[object Symbol]") return { hit: true, out: value.toString() };

  return { hit: false };
}

function plainAtom(value) {
  if (value === null || value === undefined) return { hit: true, out: value };
  const tagged = plainByTag(value, toStr.call(value));

  if (tagged.hit) return tagged;

  if (isFunction(value)) return { hit: true, out: functionLabel(value) };

  return { hit: false };
}

function plainDate(value) {
  return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
}

function plainHosted(value) {
  if (value instanceof Date) return { hit: true, out: plainDate(value) };

  if (value instanceof RegExp) return { hit: true, out: value.toString() };

  if (value instanceof Promise) return { hit: true, out: "[Promise]" };

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return { hit: true, out: plainFromBinary(value) };

  return { hit: false };
}

function plainError(value, seen, depth) {
  const out = { name: value.name, message: value.message };

  if (value.cause !== undefined) out.cause = withSeen(value, seen, () => toPlain(value.cause, seen, depth + 1));

  return out;
}

/** Convert any guest value to structured-clone-safe, JSON-shaped data. */
export function toPlain(value, seen = new Set(), depth = 0) {
  const atom = plainAtom(value);

  if (atom.hit) return atom.out;

  if (depth > MAX_DEPTH) return "[Depth]";

  if (seen.has(value)) return "[Circular]";

  if (value instanceof Error) return plainError(value, seen, depth);
  const hosted = plainHosted(value);

  if (hosted.hit) return hosted.out;

  if (isFunction(value.toJSON)) return withSeen(value, seen, () => toPlain(value.toJSON(), seen, depth + 1));

  return withSeen(value, seen, () => plainFromCollection(value, seen, depth));
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Arrays visit present indexes (including inherited ones), not extra properties.
function* childKeys(value) {
  if (!Array.isArray(value)) { yield* Object.keys(value); return; }
  for (const key of value.keys()) if (key in value) yield key;
}
