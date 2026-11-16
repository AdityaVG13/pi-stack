/**
 * Boundary decoders for pi-papercuts (anti-slop).
 */

const toStr = Object.prototype.toString;

export const isString = (v) => toStr.call(v) === "[object String]";

export const isObject = (v) => toStr.call(v) === "[object Object]";
