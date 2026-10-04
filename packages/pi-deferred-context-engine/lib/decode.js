/**
 * Boundary decoders for pi-deferred-context-engine (anti-slop).
 */

const toStr = Object.prototype.toString;

export const isString = (v) => toStr.call(v) === "[object String]";

export const isObject = (v) => toStr.call(v) === "[object Object]";

export const isFunction = (v) => toStr.call(v) === "[object Function]" || v instanceof Function;

export function uniqueNames(names) {
  return [...new Set(names.filter(name => isString(name) && name.length > 0))];
}

/** Preserve synchronous hosts; only thenable transitions become asynchronous. */
export function settleTransition(value, finish) {
  return value != null && isFunction(value.then) ? value.then(finish) : finish(value);
}
