
const toStr = Object.prototype.toString;

export const isString = (v) => toStr.call(v) === "[object String]";
export const isObject = (v) => toStr.call(v) === "[object Object]";
export const isFunction = (v) => toStr.call(v) === "[object Function]" || v instanceof Function;
export const isNumber = (v) => toStr.call(v) === "[object Number]" && Number.isFinite(v);
export const isRecord = (v) => v !== null && isObject(v);

export function parseString(v, fallback = "") {
  return isString(v) ? v : fallback;
}

export function parseNonEmptyString(v) {
  return isString(v) && v.trim().length > 0 ? v.trim() : null;
}
