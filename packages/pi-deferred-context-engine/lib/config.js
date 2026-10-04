import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isString, uniqueNames as uniqueStrings } from "./decode.js";
import { parseUserConfig, parsePromotionLifetime } from "./config-parse.js";
import { readConfigText, userConfigPath } from "./config-paths.js";

export { KNOWN_CONFIG_KEYS, parseUserConfig, parsePromotionLifetime } from "./config-parse.js";

export { standardConfigPaths, inferKindFromInstallPath, detectAgentConfigKind, userConfigPath } from "./config-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hard spine tool name(s). Never blockable; always pin+demote-guard in the engine.
 * Keep in sync with engine SPINE_NAMES (engine re-exports this set).
 */
export const SPINE_TOOL_NAMES = Object.freeze(["search_tools"]);

export const SPINE_NAMES = new Set(SPINE_TOOL_NAMES);

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultConfigPath() {
  return path.join(__dirname, "config.default.json");
}

function userOrDefault(defaults, user, key) {
  return user[key] ?? defaults[key];
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

function stripNames(names, denied, warning, warnings) {
  const kept = [];

  for (const name of names || []) {
    if (denied.has(name)) warnings.push(warning(name));
    else kept.push(name);
  }

  return kept;
}

/** Protected role wins over explicit deferral; warnings keep input order. */
export function stripDeferredProtectedConflicts(alwaysActive, neverDefer, deferredNames) {
  const protectedNames = new Set([...(alwaysActive || []), ...(neverDefer || [])]);
  const warnings = [];

  const kept = stripNames(deferredNames, protectedNames,
    name => "deferredNames contains protected tool '" + name + "' (alwaysActive pin and/or neverDefer guard) -- stripped from deferredNames", warnings);

  return { deferredNames: kept, warnings };
}

/** Spine cannot be blocked. Exact blocks win over pin/guard/defer; prefixes remain runtime policy. */
export function stripBlockedConflicts(blockedTools, alwaysActive, neverDefer, deferredNames) {
  const warnings = [];

  const blockedKept = stripNames(blockedTools, SPINE_NAMES,
    name => "blockedTools contains spine tool '" + name + "' -- cannot be blocked; stripped from blockedTools", warnings);

  const blocked = new Set(blockedKept);

  const strip = (names, label) => stripNames(names, blocked,
    name => "blockedTools wins over " + label + " for '" + name + "' -- stripped from " + label, warnings);

  return { blockedTools: blockedKept, alwaysActive: strip(alwaysActive, "alwaysActive"),
    neverDefer: strip(neverDefer, "neverDefer"), deferredNames: strip(deferredNames, "deferredNames"), warnings };
}

/**
 * Merge defaults + closed user partial into a closed runtime Config.
 * Does not re-spread open `...user` (unknown keys cannot re-enter).
 * Package numeric/bool defaults come from config.default.json (via loadDefaults);
 * no second JS literal fallbacks for maxSearchResults / maxSkillBytes / promotionLifetime.
 *
 * List semantics (kept distinct -- not duals):
 * - alwaysActive: pin into active set on synchronize (replaceAlwaysActive controls merge)
 * - neverDefer: demote-guard + never auto-defer (replaceNeverDefer controls merge)
 * - blockedTools: hard deny -- inactive, not searchable, promote refused (replaceBlockedTools)
 * Defaults may list the same stock tools in both pin lists; that is composition of both roles, not dual representation.
 *
 * DCE-O6: deferredNames ∩ (alwaysActive ∪ neverDefer) is stripped from deferredNames
 * (protected role wins). Block then wins over pin/guard/defer name lists.
 */
export function mergeConfig(defaults, user = {}) {
  const replaceAlwaysActive = user.replaceAlwaysActive === true;
  const replaceNeverDefer = user.replaceNeverDefer === true;
  const replaceBlockedTools = user.replaceBlockedTools === true;

  const alwaysActive = mergeStringSetting(defaults, user, "alwaysActive", replaceAlwaysActive);
  const neverDefer = mergeStringSetting(defaults, user, "neverDefer", replaceNeverDefer);
  const deferConflict = stripDeferredProtectedConflicts(alwaysActive, neverDefer, mergeStringSetting(defaults, user, "deferredNames"));

  const blockedMerged = mergeStringSetting(defaults, user, "blockedTools", replaceBlockedTools);
  const blockConflict = stripBlockedConflicts(blockedMerged, alwaysActive, neverDefer, deferConflict.deferredNames);

  return {
    enabled: userOrDefault(defaults, user, "enabled"),
    deferByDefault: userOrDefault(defaults, user, "deferByDefault"),
    // Booleans: package defaults must supply keys (config.default.json); no dual JS true literals.
    deferSkills: userOrDefault(defaults, user, "deferSkills"),
    deduplicateContext: userOrDefault(defaults, user, "deduplicateContext"),
    replaceAlwaysActive,
    replaceNeverDefer,
    replaceBlockedTools,
    promotionLifetime: promotionLifetime(defaults, user),
    maxSearchResults: positiveInteger(user.maxSearchResults, requiredDefaultPositiveInt(defaults, "maxSearchResults")),
    maxSkillBytes: positiveInteger(user.maxSkillBytes, requiredDefaultPositiveInt(defaults, "maxSkillBytes")),
    alwaysActive: blockConflict.alwaysActive,
    neverDefer: blockConflict.neverDefer,
    deferredNames: blockConflict.deferredNames,
    deferredPrefixes: mergeStringSetting(defaults, user, "deferredPrefixes"),
    blockedTools: blockConflict.blockedTools,
    blockedPrefixes: mergeStringSetting(defaults, user, "blockedPrefixes"),
    activeSkills: mergeStringSetting(defaults, user, "activeSkills"),
    compactSchemas: { ...defaults.compactSchemas, ...user.compactSchemas },
    // Configured routing priority: user list replaces defaults wholesale when
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

  try {
    if (!fs.lstatSync(configPath, { throwIfNoEntry: false })) return defaults;
    const raw = JSON.parse(readConfigText(configPath));
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
 * alwaysActive is NOT consulted here -- pin force is synchronize's job (distinct DCE-D1 semantics).
 * Blocked tools are handled separately via isBlocked (not deferred).
 */
function policyName(name) { return isString(name) && name.length > 0 && !SPINE_NAMES.has(name); }

export function shouldDefer(name, config) {
  if (!config.enabled || !policyName(name)) return false;

  if ((config.neverDefer || []).includes(name)) return false;

  if ((config.deferredNames || []).includes(name)) return true;

  if ((config.deferredPrefixes || []).some((prefix) => name.startsWith(prefix))) return true;

  return Boolean(config.deferByDefault);
}

/**
 * Hard-deny policy. Stronger than defer: not searchable, promote refused.
 * Spine is never blocked (defense in depth even if listed in config).
 * Session exceptions (human /deferred unblock) are passed via sessionUnblocked.
 * When DCE is disabled, block is inactive (same restore semantics as defer-off).
 *
 * @param {string} name
 * @param {object} config
 * @param {{ sessionUnblocked?: Set<string>|string[] }} [opts]
 */
function sessionAllows(name, names) {
  if (!names) return false;

  return (names instanceof Set ? names : new Set(names)).has(name);
}

export function isBlocked(name, config, opts = {}) {
  if (!config || !config.enabled || !policyName(name)) return false;

  if (sessionAllows(name, opts.sessionUnblocked)) return false;

  return (config.blockedTools || []).includes(name) ||
    (config.blockedPrefixes || []).some(prefix => isString(prefix) && prefix.length > 0 && name.startsWith(prefix));
}

/** True when any block list/prefix is configured (triggers CAUTION UX). */
export function hasBlockedConfig(config) {
  return (config.blockedTools || []).length > 0 || (config.blockedPrefixes || []).length > 0;
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
      "replaceAlwaysActive:true with empty alwaysActive -- only search_tools is forced active on synchronize; pin critical stock tools",
    );
  }

  if (config.replaceNeverDefer === true && (config.neverDefer || []).length === 0) {
    warnings.push(
      "replaceNeverDefer:true with empty neverDefer -- only search_tools is demote-guarded",
    );
  }

  return warnings;
}

/**
 * CAUTION copy when block lists are non-empty. Promote/search cannot recover blocked tools.
 * @returns {string[]}
 */
export function blockedToolsCautionWarnings(config) {
  if (config.enabled === false || !hasBlockedConfig(config)) return [];
  const names = (config.blockedTools || []).slice().sort();
  const prefixes = (config.blockedPrefixes || []).slice().sort();
  const parts = [];

  if (names.length > 0) parts.push("tools=[" + names.join(", ") + "]");

  if (prefixes.length > 0) parts.push("prefixes=[" + prefixes.join(", ") + "]");

  return [
    "CAUTION: blocked " +
      parts.join(" ") +
      " -- not searchable, promote refused. Escape: /deferred unblock <name> (session) or /deferred unblock <name> --persist. List copy-paste names: /deferred blocked",
  ];
}

export { removeBlockedTools, addAlwaysActive } from "./config-store.js";
