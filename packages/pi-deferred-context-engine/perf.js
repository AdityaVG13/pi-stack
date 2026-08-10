/**
 * Optional profiling hooks (no external monorepo dependency).
 * Single module — catalog.js and context.js must not re-encode PI_DEFERRED_PERF.
 *
 * When PI_DEFERRED_PERF is truthy (1|true|yes|on), span wraps work for timing.
 * Default span is a no-op passthrough (keeps call sites cheap).
 */

/** @returns {boolean} */
export function isPerfEnabled() {
  const v = process.env.PI_DEFERRED_PERF;
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * @param {string} _name
 * @param {() => T} fn
 * @param {object} [_meta]
 * @returns {T}
 * @template T
 */
export function span(_name, fn, _meta) {
  return fn();
}
