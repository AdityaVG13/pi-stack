import { isString, isObject } from "./decode.js";

/**
 * Tiered schema disclosure preserves schema structure and JSON literal data.
 * Undo retains descriptors/order and the value we wrote; newer owner edits win.
 * Pruning frozen/nonconfigurable nodes rejects the whole transaction.
 */
const DROP_KEYS = new Set(["examples", "$comment"]);

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

const SCHEMA_CHILDREN = new Set([
  "allOf", "anyOf", "oneOf", "prefixItems", "items", "additionalItems",
  "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames",
  "contains", "not", "if", "then", "else", "contentSchema",
]);

function splitsSurrogate(text, end) {
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);

  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** The cap includes the suffix; well-formed input never acquires a lone surrogate. */
export function truncateProse(text, maxChars) {
  if (!isString(text)) return text;

  if (!Number.isInteger(maxChars) || maxChars < 0) throw new RangeError("maxChars must be a nonnegative integer");

  if (text.length <= maxChars) return text;

  if (maxChars < 2) return "…".slice(0, maxChars);
  const sentence = text.slice(0, maxChars).lastIndexOf(". ");

  if (sentence >= Math.floor(maxChars / 2)) return text.slice(0, sentence + 1);
  let end = maxChars - 2;

  if (splitsSurrogate(text, end)) end--;
  const slice = text.slice(0, end);
  const wordEnd = slice.lastIndexOf(" ");

  return (wordEnd > 0 ? slice.slice(0, wordEnd) : slice).trimEnd() + " …";
}

function isReversible(target, descriptors) {
  return Object.isExtensible(target) && Object.values(descriptors).every((d) => d.configurable && "value" in d && d.writable);
}

/** Shared subgraphs may also be literal data or belong to a full-schema tool.
 * Conservatively leave them intact; accessors are never invoked by this scan.
 */
export function sharedSchemaNodes(schemas) {
  const seen = new Set();
  const protectedNodes = new Set();

  const pending = schemas.filter(value => Array.isArray(value) || isObject(value))
    .map(value => ({ value, protect: false }));

  while (pending.length > 0) {
    const { value, protect } = pending.pop();

    const shared = protect || seen.has(value);

    if (shared && protectedNodes.has(value)) continue;
    seen.add(value);

    if (shared) protectedNodes.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const key of Reflect.ownKeys(descriptors)) {
      const child = descriptors[key].value;

      // Primitive annotations cannot alias schema nodes. Avoid stack frames for them.
      if (Array.isArray(child) || isObject(child)) {
        pending.push({ value: child, protect: shared });
      }
    }
  }

  return protectedNodes;
}

function editAnnotations(schema, maxChars, undo) {
  const descriptors = Object.getOwnPropertyDescriptors(schema);
  const order = Object.keys(schema);

  const edits = order.filter((key) => DROP_KEYS.has(key)
    || (key === "description" && isString(descriptors[key].value) && descriptors[key].value.length > maxChars));

  if (edits.length > 0 && !isReversible(schema, descriptors)) {
    throw new TypeError("schema annotations must have reversible plain-data properties");
  }

  for (const key of edits) {
    const dropped = DROP_KEYS.has(key);
    const writtenValue = dropped ? undefined : truncateProse(descriptors[key].value, maxChars);

    const changed = dropped ? Reflect.deleteProperty(schema, key)
      : Reflect.set(schema, key, writtenValue);

    if (!changed) throw new TypeError("schema annotation mutation was rejected");
    undo.push({ target: schema, key, descriptor: descriptors[key], dropped, order, writtenValue });
  }

  return { descriptors, order };
}

function pruneChildren(descriptors, order, maxChars, undo, seen, protectedNodes) {
  for (const key of order) {
    const value = descriptors[key].value;

    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      for (const child of Object.values(value)) pruneNode(child, maxChars, undo, seen, protectedNodes);
    } else if (SCHEMA_CHILDREN.has(key)) {
      pruneNode(value, maxChars, undo, seen, protectedNodes);
    }
  }
}

function pruneNode(schema, maxChars, undo, seen, protectedNodes) {
  if (!schema || (!Array.isArray(schema) && !isObject(schema)) || seen.has(schema) || protectedNodes.has(schema)) return;
  seen.add(schema);

  if (Array.isArray(schema)) {
    for (const item of schema) pruneNode(item, maxChars, undo, seen, protectedNodes);

    return;
  }

  const { descriptors, order } = editAnnotations(schema, maxChars, undo);

  pruneChildren(descriptors, order, maxChars, undo, seen, protectedNodes);
}

/** Return an opaque undo log. Failed pruning rolls back only this invocation. */
export function pruneSchemaInPlace(schema, { maxChars = 160, protectedNodes = sharedSchemaNodes([schema]) } = {}, undo = [], seen = new Set()) {
  const start = undo.length;

  try {
    pruneNode(schema, maxChars, undo, seen, protectedNodes);

    return undo;
  } catch (error) {
    restorePrunedSchema(undo.splice(start));
    throw error;
  }
}

export function restorePrunedSchema(undo) {
  const orders = new Map();

  for (let i = undo.length - 1; i >= 0; i--) {
    const { target, key, descriptor, dropped, order, writtenValue } = undo[i];
    const current = Object.getOwnPropertyDescriptor(target, key);

    const owned = dropped
      ? !current && Object.isExtensible(target)
      : current && current.value === writtenValue && current.writable === descriptor.writable &&
        current.configurable === descriptor.configurable && current.enumerable === descriptor.enumerable;

    if (!owned) continue;
    Object.defineProperty(target, key, descriptor);

    if (dropped) orders.set(target, order);
  }

  for (const [target, order] of orders) {
    const descriptors = Object.getOwnPropertyDescriptors(target);

    // A later owner lock may forbid reordering even when individual values restore.
    if (!isReversible(target, descriptors)) continue;

    const current = Object.keys(target);

    // Restoring a trailing annotation already restores serialized key order.
    if (current.length === order.length && current.every((key, index) => key === order[index])) continue;
    const original = new Set(order);
    const keys = [...order.filter((key) => Object.hasOwn(descriptors, key)), ...current.filter((key) => !original.has(key))];

    for (const key of current) Reflect.deleteProperty(target, key);

    for (const key of keys) Object.defineProperty(target, key, descriptors[key]);
  }
}

/** Rebase full schemas before each policy pass; no name-local undo owns an aliased object. */
export function createSchemaCompactor(getTools, spine) {
  const compacted = new Map();

  function compactTool(tool, options, protectedNodes) {
    const undo = [];

    try {
      const before = Buffer.byteLength(JSON.stringify(tool.parameters));

      pruneSchemaInPlace(tool.parameters, { maxChars: options.maxParamDescriptionChars, protectedNodes }, undo);

      if (undo.length) compacted.set(tool.name, { undo, savedBytes: before - Buffer.byteLength(JSON.stringify(tool.parameters)) });
    } catch {
      restorePrunedSchema(undo);
      compacted.delete(tool.name);
    }
  }

  function compactible(tool, keepFull, promoted) {
    return !keepFull.has(tool.name) && !promoted.has(tool.name) && tool.parameters && isObject(tool.parameters);
  }

  function restore() {
    for (const entry of [...compacted.values()].reverse()) restorePrunedSchema(entry.undo);
    compacted.clear();
  }

  function apply(config, promoted) {
    const options = config.compactSchemas || {};
    const enabled = Boolean(config.enabled) && options.enabled === true;
    const keepFull = new Set([...spine, ...(options.keepFull || [])]);
    const tools = getTools();
    restore();

    if (!enabled) return;
    const protectedNodes = sharedSchemaNodes(tools.map(tool => tool.parameters));

    for (const tool of tools) {
      if (!compactible(tool, keepFull, promoted)) continue;
      compactTool(tool, options, protectedNodes);
    }
  }

  function stats() {
    let savedBytes = 0;

    for (const entry of compacted.values()) savedBytes += entry.savedBytes;

    return { compactedTools: compacted.size, savedBytes };
  }

  return { apply, restore, stats };
}
