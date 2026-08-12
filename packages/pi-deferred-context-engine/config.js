import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMOTION_LIFETIMES = new Set(["run", "session"]);

/** Closed set of keys admitted into runtime Config (trust-edge strip/refuse). */
export const KNOWN_CONFIG_KEYS = Object.freeze([
  "enabled",
  "deferByDefault",
  "deferSkills",
  "deduplicateContext",
  "promotionLifetime",
  "maxSearchResults",
  "maxSkillBytes",
  "replaceAlwaysActive",
  "replaceNeverDefer",
  "alwaysActive",
  "neverDefer",
  "deferredNames",
  "deferredPrefixes",
  "activeSkills",
  "toolPriority",
]);

const KNOWN_CONFIG_KEY_SET = new Set(KNOWN_CONFIG_KEYS);

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultConfigPath() {
  return path.join(__dirname, "config.default.json");
}

export function userConfigPath() {
  return process.env.PI_DEFERRED_TOOLS_CONFIG || path.join(os.homedir(), ".pi", "agent", "deferred-tools.json");
}

function userOrDefault(defaults, user, key) {
  return user[key] ?? defaults[key];
}


/**
 * Smart constructor: promotionLifetime is only run|session.
 * @returns {{ ok: true, value: "run"|"session" } | { ok: false, error: string }}
 */
export function parsePromotionLifetime(value) {
  if (PROMOTION_LIFETIMES.has(value)) return { ok: true, value };
  return { ok: false, error: "promotionLifetime must be run|session" };
}

function promotionLifetime(defaults, user) {
  if (Object.prototype.hasOwnProperty.call(user, "promotionLifetime")) {
    const parsed = parsePromotionLifetime(user.promotionLifetime);
    if (parsed.ok) return parsed.value;
  }
  // Sole source after loadDefaults: config.default.json (no second JS literal "run").
  const fromDefaults = parsePromotionLifetime(defaults.promotionLifetime);
  if (!fromDefaults.ok) {
    throw new Error("defaults.promotionLifetime must be run|session (config.default.json)");
  }
  return fromDefaults.value;
}

function mergeStringSetting(defaults, user, key, replace = false) {
  const values = replace
    ? (user[key] || [])
    : [...(defaults[key] || []), ...(user[key] || [])];
  return uniqueStrings(values);
}

function parseStringListField(raw, key, strict) {
  if (raw === undefined) return { ok: true, present: false };
  if (!Array.isArray(raw)) {
    if (strict) return { ok: false, error: key + " must be an array of strings" };
    return { ok: true, present: false };
  }
  if (strict && raw.some((item) => typeof item !== "string")) {
    return { ok: false, error: key + " must contain only strings" };
  }
  return { ok: true, present: true, value: raw };
}

function parseBooleanField(raw, key, strict) {
  if (raw === undefined) return { ok: true, present: false };
  if (typeof raw !== "boolean") {
    if (strict) return { ok: false, error: key + " must be a boolean" };
    return { ok: true, present: false };
  }
  return { ok: true, present: true, value: raw };
}

function parsePositiveIntField(raw, key, strict) {
  if (raw === undefined) return { ok: true, present: false };
  if (!Number.isInteger(raw) || raw <= 0) {
    if (strict) return { ok: false, error: key + " must be a positive integer" };
    return { ok: true, present: false };
  }
  return { ok: true, present: true, value: raw };
}

/**
 * Parse raw JSON user config once at the trust edge into a closed partial.
 * Unknown keys: stripped (default) or refused when `strict: true`.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseUserConfig(raw, { strict = false } = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be a JSON object" };
  }

  const unknown = Object.keys(raw).filter((key) => !KNOWN_CONFIG_KEY_SET.has(key));
  if (unknown.length > 0 && strict) {
    return { ok: false, error: "unknown config key(s): " + unknown.join(", ") };
  }

  const value = {};

  for (const key of ["enabled", "deferByDefault", "deferSkills", "deduplicateContext", "replaceAlwaysActive", "replaceNeverDefer"]) {
    const field = parseBooleanField(raw[key], key, strict);
    if (!field.ok) return field;
    if (field.present) value[key] = field.value;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "promotionLifetime")) {
    const lifetime = parsePromotionLifetime(raw.promotionLifetime);
    if (!lifetime.ok) {
      if (strict) return lifetime;
      // non-strict: omit so merge falls back to defaults
    } else {
      value.promotionLifetime = lifetime.value;
    }
  }

  for (const key of ["maxSearchResults", "maxSkillBytes"]) {
    const field = parsePositiveIntField(raw[key], key, strict);
    if (!field.ok) return field;
    if (field.present) value[key] = field.value;
  }

  for (const key of ["alwaysActive", "neverDefer", "deferredNames", "deferredPrefixes", "activeSkills", "toolPriority"]) {
    const field = parseStringListField(raw[key], key, strict);
    if (!field.ok) return field;
    if (field.present) value[key] = field.value;
  }

  return { ok: true, value };
}

/**
 * Require a positive integer already present on package defaults (JSON sole source).
 * Throws rather than dual-encoding a second JS literal.
 */
function requiredDefaultPositiveInt(defaults, key) {
  const value = defaults[key];
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("defaults." + key + " must be a positive integer (config.default.json sole source)");
  }
  return value;
}

/**
 * DCE-O6: names in alwaysActive (pin) or neverDefer (demote-guard) cannot also sit in
 * deferredNames — protected role wins; strip from deferredNames and surface soft warnings.
 * @returns {{ deferredNames: string[], warnings: string[] }}
 */
export function stripDeferredProtectedConflicts(alwaysActive, neverDefer, deferredNames) {
  const protectedSet = new Set([...(alwaysActive || []), ...(neverDefer || [])]);
  const warnings = [];
  const kept = [];
  for (const name of deferredNames || []) {
    if (protectedSet.has(name)) {
      warnings.push(
        "deferredNames contains protected tool '" + name + "' (alwaysActive pin and/or neverDefer guard) — stripped from deferredNames",
      );
    } else {
      kept.push(name);
    }
  }
  return { deferredNames: kept, warnings };
}

/**
 * Merge defaults + closed user partial into a closed runtime Config.
 * Does not re-spread open `...user` (unknown keys cannot re-enter).
 * Package numeric/bool defaults come from config.default.json (via loadDefaults);
 * no second JS literal fallbacks for maxSearchResults / maxSkillBytes / promotionLifetime.
 *
 * List semantics (kept distinct — not duals):
 * - alwaysActive: pin into active set on synchronize (replaceAlwaysActive controls merge)
 * - neverDefer: demote-guard + never auto-defer (replaceNeverDefer controls merge)
 * Defaults may list the same stock tools in both; that is composition of both roles, not dual representation.
 *
 * DCE-O6: deferredNames ∩ (alwaysActive ∪ neverDefer) is stripped from deferredNames
 * (protected role wins). Inspect strips via stripDeferredProtectedConflicts().warnings.
 */
export function mergeConfig(defaults, user = {}) {
  const replaceAlwaysActive = user.replaceAlwaysActive === true;
  const replaceNeverDefer = user.replaceNeverDefer === true;

  const alwaysActive = mergeStringSetting(defaults, user, "alwaysActive", replaceAlwaysActive);
  const neverDefer = mergeStringSetting(defaults, user, "neverDefer", replaceNeverDefer);
  const deferredMerged = mergeStringSetting(defaults, user, "deferredNames");
  const conflict = stripDeferredProtectedConflicts(alwaysActive, neverDefer, deferredMerged);

  return {
    enabled: userOrDefault(defaults, user, "enabled"),
    deferByDefault: userOrDefault(defaults, user, "deferByDefault"),
    // Booleans: package defaults must supply keys (config.default.json); no dual JS true literals.
    deferSkills: userOrDefault(defaults, user, "deferSkills"),
    deduplicateContext: userOrDefault(defaults, user, "deduplicateContext"),
    replaceAlwaysActive,
    replaceNeverDefer,
    promotionLifetime: promotionLifetime(defaults, user),
    maxSearchResults: positiveInteger(user.maxSearchResults, requiredDefaultPositiveInt(defaults, "maxSearchResults")),
    maxSkillBytes: positiveInteger(user.maxSkillBytes, requiredDefaultPositiveInt(defaults, "maxSkillBytes")),
    alwaysActive,
    neverDefer,
    deferredNames: conflict.deferredNames,
    deferredPrefixes: mergeStringSetting(defaults, user, "deferredPrefixes"),
    activeSkills: mergeStringSetting(defaults, user, "activeSkills"),
    // Ordered soft routing signal: user list replaces defaults wholesale when
    // present (merging two orders is ambiguous). Empty = registration order.
    toolPriority: uniqueStrings(user.toolPriority ?? defaults.toolPriority ?? []),
  };
}

function loadDefaults() {
  const raw = JSON.parse(fs.readFileSync(defaultConfigPath(), "utf8"));
  return mergeConfig(raw, {});
}

/** Cached package defaults from config.default.json (sole default source). */
let _packageDefaults;
export function packageDefaults() {
  if (!_packageDefaults) _packageDefaults = loadDefaults();
  return _packageDefaults;
}

export function loadConfig(configPath = userConfigPath(), { strict = false } = {}) {
  const defaults = loadDefaults();
  if (!fs.existsSync(configPath)) return defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const parsed = parseUserConfig(raw, { strict });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return mergeConfig(defaults, parsed.value);
  } catch (error) {
    if (strict) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error("Invalid deferred-tools config at " + configPath + ": " + message);
    }
    return defaults;
  }
}

/**
 * Auto-defer policy only. neverDefer blocks auto-deferral.
 * alwaysActive is NOT consulted here — pin force is synchronize's job (distinct DCE-D1 semantics).
 */
export function shouldDefer(name, config) {
  if (!config.enabled) return false;
  if (typeof name !== "string" || name.length === 0) return false; // guard: hosts may return nameless tools
  if ((config.neverDefer || []).includes(name)) return false;
  if ((config.deferredNames || []).includes(name)) return true;
  if ((config.deferredPrefixes || []).some((prefix) => name.startsWith(prefix))) return true;
  return Boolean(config.deferByDefault);
}

/**
 * Soft warnings for replace* with empty lists (strict reload surfaces these; does not refuse).
 * Empty replaceAlwaysActive soft-locks pins to search_tools only.
 * @returns {string[]}
 */
export function emptyPinReplaceWarnings(config) {
  const warnings = [];
  if (config.replaceAlwaysActive === true && (config.alwaysActive || []).length === 0) {
    warnings.push(
      "replaceAlwaysActive:true with empty alwaysActive — only search_tools is forced active on synchronize; pin critical stock tools",
    );
  }
  if (config.replaceNeverDefer === true && (config.neverDefer || []).length === 0) {
    warnings.push(
      "replaceNeverDefer:true with empty neverDefer — only search_tools is demote-guarded",
    );
  }
  return warnings;
}
