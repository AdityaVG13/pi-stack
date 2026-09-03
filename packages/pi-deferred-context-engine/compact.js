import { isString, isObject } from "./decode.js";
/**
 * Tiered schema disclosure: active tools keep full structural schemas
 * (types, enums, required) while long prose inside parameter schemas is
 * pruned in place. Promotion restores the original text exactly, so the
 * model gets full fidelity for tools it explicitly reached for.
 *
 * The prune is an in-place mutation with an undo log — the host serializes
 * the same schema object references on every request, so no re-registration
 * is needed and restore is exact by construction (parse, don't validate:
 * the undo log IS the proof of reversibility).
 */

/** Keys that are pure documentation payload and safe to drop entirely. */
const DROP_KEYS = Object.freeze(["examples", "$comment"]);

/** Truncate prose at a sentence (preferred) or word boundary. */
export function truncateProse(text, maxChars) {
  if (!isString(text) || text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const sentenceEnd = slice.lastIndexOf(". ");
  if (sentenceEnd >= Math.floor(maxChars / 2)) {
    return slice.slice(0, sentenceEnd + 1);
  }
  const wordEnd = slice.lastIndexOf(" ");
  return (wordEnd > 0 ? slice.slice(0, wordEnd) : slice).trimEnd() + " …";
}

/**
 * Prune one JSON-schema tree in place. Returns an undo log; an empty log
 * means nothing was worth pruning. Cycle-safe via `seen`.
 */
export function pruneSchemaInPlace(schema, { maxChars = 160 } = {}, undo = [], seen = new Set()) {
  if (!schema || !isObject(schema) || seen.has(schema)) return undo;
  seen.add(schema);
  if (Array.isArray(schema)) {
    for (const item of schema) pruneSchemaInPlace(item, { maxChars }, undo, seen);
    return undo;
  }
  for (const key of Object.keys(schema)) {
    const value = schema[key];
    if (DROP_KEYS.includes(key)) {
      undo.push({ target: schema, key, value, dropped: true });
      delete schema[key];
      continue;
    }
    if (key === "description" && isString(value) && value.length > maxChars) {
      undo.push({ target: schema, key, value });
      schema[key] = truncateProse(value, maxChars);
      continue;
    }
    if (value && isObject(value)) pruneSchemaInPlace(value, { maxChars }, undo, seen);
  }
  return undo;
}

/** Restore in reverse order so re-added dropped keys land exactly. */
export function restorePrunedSchema(undo) {
  for (let i = undo.length - 1; i >= 0; i -= 1) {
    const { target, key, value } = undo[i];
    target[key] = value;
  }
}
