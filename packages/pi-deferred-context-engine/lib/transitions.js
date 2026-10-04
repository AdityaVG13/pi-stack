import { isFunction } from "./decode.js";

/** Host write confirmation and serial queue, independent of DCE pin/block policy. */
export function createToolTransitions(pi, normalizeActiveNames) {
  const activeNames = () => pi.getActiveTools();
  let lastSetError = null;
  let transitionTail = null;

  // Sync hosts keep synchronous results. Only pending async transitions queue;
  // each operation reads host state after its predecessor has settled.
  function serializeTransition(operation) {
    const result = transitionTail ? transitionTail.then(operation, operation) : operation();

    if (result == null || !isFunction(result.then)) return result;
    const pending = Promise.resolve(result);
    transitionTail = pending;

    return pending.finally(() => {
      if (transitionTail === pending) transitionTail = null;
    });
  }

  /**
   * Apply active set. Hosts may expose sync or Promise-returning setActiveTools
   * (OMP is async). Callers should `await Promise.resolve(...)` the result.
   */
  function setActiveIfChanged(next) {
    lastSetError = null;
    const normalized = normalizeActiveNames(next);
    const current = activeNames();

    const observe = () => {
      const actual = activeNames();

      if (!lastSetError && (actual.length !== normalized.length || actual.some((name, index) => name !== normalized[index]))) {
        lastSetError = "Host did not apply the requested active-tool state";
      }

      return actual;
    };

    // Sequence compare, not set compare: priority ordering is part of the
    // contract, so an order-only difference still re-applies the active set.
    const identical =
      current.length === normalized.length &&
      current.every((name, index) => name === normalized[index]);

    if (!identical) {
      try {
        const maybe = pi.setActiveTools(normalized);

        if (maybe != null && isFunction(maybe.then)) {
          return Promise.resolve(maybe).then(
            observe,
            (error) => {
              lastSetError = error instanceof Error ? error.message : String(error);

              return observe();
            },
          );
        }
      } catch (error) {
        lastSetError = error instanceof Error ? error.message : String(error);
      }
    } else {
      // Identical content, no host round-trip: current already equals
      // normalized, so re-querying the host only re-reads the same set.
      return current;
    }

    return observe();
  }

  return { write: setActiveIfChanged, serialize: serializeTransition, get error() { return lastSetError; }, set error(value) { lastSetError = value; } };
}
