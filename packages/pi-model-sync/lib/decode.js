/**
 * pi-model-sync shared value helpers.
 *
 * House idiom (pi-supernova decode.js): Object.prototype.toString probes
 * instead of typeof, centralized here so every other module branches on
 * decoded contracts rather than representations. Record builders live here
 * too, so sparse-object shapes stay single-sourced.
 */

const toStr = Object.prototype.toString;

export function isString(value) {
  return toStr.call(value) === "[object String]";
}

export function isNonEmptyString(value) {
  return isString(value) && value !== "";
}

export function isObject(value) {
  return toStr.call(value) === "[object Object]";
}

export function isFunction(value) {
  return toStr.call(value) === "[object Function]" || value instanceof Function;
}

export function isNumber(value) {
  return toStr.call(value) === "[object Number]" && Number.isFinite(value);
}

// Build a record from entries, dropping undefined values. Both model-entry
// builders emit sparse records (unknown fields omitted, never null); key
// order follows the literal, so output order is unchanged.
export function defined(entries) {
  const kept = {};

  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      kept[key] = value;
    }
  }

  return kept;
}
