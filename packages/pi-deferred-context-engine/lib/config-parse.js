import { isString, isObject } from "./decode.js";

export const KNOWN_CONFIG_KEYS = Object.freeze([
  "enabled", "deferByDefault", "deferSkills", "deduplicateContext", "promotionLifetime",
  "maxSearchResults", "maxSkillBytes", "compactSchemas", "replaceAlwaysActive", "replaceNeverDefer",
  "replaceBlockedTools", "alwaysActive", "neverDefer", "deferredNames", "deferredPrefixes", "blockedTools",
  "blockedPrefixes", "activeSkills", "toolPriority",
]);

const knownKeys = new Set(KNOWN_CONFIG_KEYS);

const booleanKeys = ["enabled", "deferByDefault", "deferSkills", "deduplicateContext", "replaceAlwaysActive", "replaceNeverDefer", "replaceBlockedTools"];

const integerKeys = ["maxSearchResults", "maxSkillBytes"];

const listKeys = ["alwaysActive", "neverDefer", "deferredNames", "deferredPrefixes", "blockedTools", "blockedPrefixes", "activeSkills", "toolPriority"];

const isBoolean = value => value === true || value === false;

const isPositive = value => Number.isInteger(value) && value > 0;

const isJsonObject = value => value !== null && isObject(value) && !Array.isArray(value);

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function parsePromotionLifetime(value) {
  return value === "run" || value === "session"
    ? { ok: true, value } : { ok: false, error: "promotionLifetime must be run|session" };
}

function listError(value, strict) {
  if (!Array.isArray(value)) return " must be an array of strings";

  if (strict && value.some(item => !isString(item))) return " must contain only strings";

  return null;
}

function readFields(raw, value, keys, errorFor, strict) {
  for (const key of keys) {
    if (raw[key] === undefined) continue;
    const error = errorFor(raw[key], strict);

    if (error && strict) return { ok: false, error: key + error };

    if (!error) value[key] = raw[key];
  }

  return null;
}

const compactFields = {
  enabled: { valid: isBoolean, error: " must be a boolean" },
  maxParamDescriptionChars: { valid: isPositive, error: " must be a positive integer" },
  keepFull: { valid: value => Array.isArray(value) && value.every(item => isString(item) && item.length > 0),
    error: " must be an array of non-empty strings", copy: value => [...value] },
};

function parseCompactSchemas(raw, strict) {
  if (!isJsonObject(raw)) return strict
    ? { ok: false, error: "compactSchemas must be a JSON object" } : { ok: true, present: false };
  const unknown = Object.keys(raw).filter(key => !has(compactFields, key));

  if (strict && unknown.length > 0) return { ok: false, error: "unknown compactSchemas key(s): " + unknown.join(", ") };
  const value = {};

  for (const [key, rule] of Object.entries(compactFields)) {
    if (!has(raw, key)) continue;

    if (!rule.valid(raw[key])) {
      if (strict) return { ok: false, error: "compactSchemas." + key + rule.error };
    } else value[key] = rule.copy ? rule.copy(raw[key]) : raw[key];
  }

  return { ok: true, present: true, value };
}

function readSpecial(raw, value, key, parse, strict) {
  if (!has(raw, key)) return null;
  const parsed = parse(raw[key], strict);

  if (!parsed.ok) return strict ? parsed : null;

  if (parsed.present !== false) value[key] = parsed.value;

  return null;
}

/** Closed partial at the trust edge; field order and first strict error are stable. */
export function parseUserConfig(raw, { strict = false } = {}) {
  if (!isJsonObject(raw)) return { ok: false, error: "config must be a JSON object" };
  const unknown = Object.keys(raw).filter(key => !knownKeys.has(key));

  if (unknown.length > 0 && strict) return { ok: false, error: "unknown config key(s): " + unknown.join(", ") };
  const value = {};

  const phases = [
    () => readFields(raw, value, booleanKeys, v => isBoolean(v) ? null : " must be a boolean", strict),
    () => readSpecial(raw, value, "promotionLifetime", parsePromotionLifetime, strict),
    () => readFields(raw, value, integerKeys, v => isPositive(v) ? null : " must be a positive integer", strict),
    () => readFields(raw, value, listKeys, listError, strict),
    () => readSpecial(raw, value, "compactSchemas", parseCompactSchemas, strict),
  ];

  for (const phase of phases) {
    const error = phase();

    if (error) return error;
  }

  return { ok: true, value };
}
