import { isString, isObject } from "./decode.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMOTION_LIFETIMES = new Set(["run", "session"]);

/**
 * Hard spine tool name(s). Never blockable; always pin+demote-guard in the engine.
 * Keep in sync with engine SPINE_NAMES (engine re-exports this set).
 */
export const SPINE_TOOL_NAMES = Object.freeze(["search_tools"]);
export const SPINE_NAMES = new Set(SPINE_TOOL_NAMES);

/** Closed set of keys admitted into runtime Config (trust-edge strip/refuse). */
export const KNOWN_CONFIG_KEYS = Object.freeze([
  "enabled",
  "deferByDefault",
  "deferSkills",
  "deduplicateContext",
  "promotionLifetime",
  "maxSearchResults",
  "maxSkillBytes",
  "compactSchemas",
  "replaceAlwaysActive",
  "replaceNeverDefer",
  "replaceBlockedTools",
  "alwaysActive",
  "neverDefer",
  "deferredNames",
  "deferredPrefixes",
  "blockedTools",
  "blockedPrefixes",
  "activeSkills",
  "toolPriority",
]);

const KNOWN_CONFIG_KEY_SET = new Set(KNOWN_CONFIG_KEYS);

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => isString(value) && value.length > 0))];
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultConfigPath() {
  return path.join(__dirname, "config.default.json");
}

/** Standard per-host config file locations (user-agnostic; no hard-coded usernames). */
export function standardConfigPaths(home = os.homedir()) {
  return {
    pi: path.join(home, ".pi", "agent", "deferred-tools.json"),
    omp: path.join(home, ".omp", "agent", "deferred-tools.json"),
  };
}

/**
 * Infer host from where THIS package was installed.
 * npm under ~/.pi/agent/npm/... → pi; under ~/.omp/... → omp.
 * Path-installs outside either home return "unknown".
 */
export function inferKindFromInstallPath(installDir = __dirname) {
  const normalized = String(installDir || "").replace(/\\/g, "/").toLowerCase();
  // Segment match only — avoid false hits on package names containing "pi".
  if (normalized.includes("/.omp/")) return "omp";
  if (normalized.includes("/.pi/")) return "pi";
  return "unknown";
}

/**
 * Weak signal from the running binary basename (path-install fallback).
 * Exact basenames only — no repo-name heuristics.
 */
export function detectAgentConfigKind(argv = process.argv, execPath = process.execPath) {
  const names = [];
  for (const entry of Array.isArray(argv) ? argv : []) {
    if (!isString(entry) || !entry) continue;
    names.push(path.basename(entry).replace(/\.(js|mjs|cjs|ts|exe)$/i, "").toLowerCase());
  }
  if (isString(execPath) && execPath) {
    names.push(path.basename(execPath).replace(/\.(js|mjs|cjs|ts|exe)$/i, "").toLowerCase());
  }
  try {
    if (typeof Bun !== "undefined" && Bun.main) {
      names.push(path.basename(String(Bun.main)).replace(/\.(js|mjs|cjs|ts|exe)$/i, "").toLowerCase());
    }
  } catch {
    /* ignore */
  }
  if (names.includes("omp") || names.includes("zmp")) return "omp";
  if (names.includes("pi")) return "pi";
  return "unknown";
}

function settingsMentionsDeferredEngine(settingsPath) {
  try {
    const text = fs.readFileSync(settingsPath, "utf8");
    return text.includes("pi-deferred-context-engine");
  } catch {
    return false;
  }
}

/**
 * Resolve deferred-tools.json for the host that loaded this package.
 *
 * Order (bog-standard, dual-install safe):
 * 1. PI_DEFERRED_TOOLS_CONFIG / OMP_DEFERRED_TOOLS_CONFIG
 * 2. PI_CONFIG_DIR / OMP_CONFIG_DIR (host-declared agent root)
 * 3. Install location of this package (~/.pi/... vs ~/.omp/...)
 * 4. Binary basename (pi | omp | zmp)
 * 5. Which host settings.json lists this package
 * 6. Whichever standard file exists (if only one)
 * 7. Default to ~/.pi/agent/deferred-tools.json (Pi package heritage)
 */
export function userConfigPath() {
  const fromEnv =
    process.env.PI_DEFERRED_TOOLS_CONFIG ||
    process.env.OMP_DEFERRED_TOOLS_CONFIG;
  if (fromEnv) return fromEnv;

  for (const key of ["PI_CONFIG_DIR", "OMP_CONFIG_DIR"]) {
    const root = process.env[key];
    if (!root || !isString(root)) continue;
    const underAgent = path.join(root, "agent", "deferred-tools.json");
    if (fs.existsSync(underAgent)) return underAgent;
    const direct = path.join(root, "deferred-tools.json");
    if (fs.existsSync(direct)) return direct;
  }

  const { pi: piPath, omp: ompPath } = standardConfigPaths();
  const fromInstall = inferKindFromInstallPath(__dirname);
  const kind = fromInstall !== "unknown" ? fromInstall : detectAgentConfigKind();

  if (kind === "pi") return piPath;
  if (kind === "omp") return ompPath;

  const home = os.homedir();
  const piSettings = path.join(home, ".pi", "agent", "settings.json");
  const ompSettings = path.join(home, ".omp", "agent", "settings.json");
  // OMP may keep settings elsewhere; also check plugins package.json mention via settings.
  const piListsUs = settingsMentionsDeferredEngine(piSettings);
  const ompListsUs = settingsMentionsDeferredEngine(ompSettings);
  if (piListsUs && !ompListsUs) return piPath;
  if (ompListsUs && !piListsUs) return ompPath;

  const piExists = fs.existsSync(piPath);
  const ompExists = fs.existsSync(ompPath);
  if (piExists && !ompExists) return piPath;
  if (ompExists && !piExists) return ompPath;

  // Both or neither: Pi default (this is a pi-package; OMP users set OMP_CONFIG_DIR or install under .omp).
  return piPath;
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
  if (strict && raw.some((item) => !isString(item))) {
    return { ok: false, error: key + " must contain only strings" };
  }
  return { ok: true, present: true, value: raw };
}

function parseBooleanField(raw, key, strict) {
  if (raw === undefined) return { ok: true, present: false };
  if (raw !== true && raw !== false) {
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
/**
 * compactSchemas trust edge: { enabled?, maxParamDescriptionChars?, keepFull? }.
 * Invalid shapes are rejected in strict mode and omitted otherwise.
 */
function parseCompactSchemas(raw, strict) {
  if (raw === null || !isObject(raw) || Array.isArray(raw)) {
    return strict
      ? { ok: false, error: "compactSchemas must be a JSON object" }
      : { ok: true, present: false };
  }
  const value = {};
  if (Object.prototype.hasOwnProperty.call(raw, "enabled")) {
    if (raw.enabled !== true && raw.enabled !== false) {
      if (strict) return { ok: false, error: "compactSchemas.enabled must be a boolean" };
    } else value.enabled = raw.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "maxParamDescriptionChars")) {
    if (!Number.isInteger(raw.maxParamDescriptionChars) || raw.maxParamDescriptionChars <= 0) {
      if (strict) return { ok: false, error: "compactSchemas.maxParamDescriptionChars must be a positive integer" };
    } else value.maxParamDescriptionChars = raw.maxParamDescriptionChars;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "keepFull")) {
    if (!Array.isArray(raw.keepFull) || raw.keepFull.some((n) => !isString(n) || n.length === 0)) {
      if (strict) return { ok: false, error: "compactSchemas.keepFull must be an array of non-empty strings" };
    } else value.keepFull = [...raw.keepFull];
  }
  return { ok: true, present: true, value };
}

export function parseUserConfig(raw, { strict = false } = {}) {
  if (raw === null || !isObject(raw) || Array.isArray(raw)) {
    return { ok: false, error: "config must be a JSON object" };
  }

  const unknown = Object.keys(raw).filter((key) => !KNOWN_CONFIG_KEY_SET.has(key));
  if (unknown.length > 0 && strict) {
    return { ok: false, error: "unknown config key(s): " + unknown.join(", ") };
  }

  const value = {};

  for (const key of [
    "enabled",
    "deferByDefault",
    "deferSkills",
    "deduplicateContext",
    "replaceAlwaysActive",
    "replaceNeverDefer",
    "replaceBlockedTools",
  ]) {
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

  for (const key of [
    "alwaysActive",
    "neverDefer",
    "deferredNames",
    "deferredPrefixes",
    "blockedTools",
    "blockedPrefixes",
    "activeSkills",
    "toolPriority",
  ]) {
    const field = parseStringListField(raw[key], key, strict);
    if (!field.ok) return field;
    if (field.present) value[key] = field.value;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "compactSchemas")) {
    const parsed = parseCompactSchemas(raw.compactSchemas, strict);
    if (!parsed.ok) return parsed;
    if (parsed.present) value.compactSchemas = parsed.value;
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
 * Block axis conflicts: spine cannot be blocked; block wins over pin/guard/defer name lists.
 * Prefix overlaps are evaluated at runtime via isBlocked (not expanded here).
 * @returns {{
 *   blockedTools: string[],
 *   alwaysActive: string[],
 *   neverDefer: string[],
 *   deferredNames: string[],
 *   warnings: string[],
 * }}
 */
export function stripBlockedConflicts(blockedTools, alwaysActive, neverDefer, deferredNames) {
  const warnings = [];
  const blockedKept = [];
  for (const name of blockedTools || []) {
    if (SPINE_NAMES.has(name)) {
      warnings.push("blockedTools contains spine tool '" + name + "' — cannot be blocked; stripped from blockedTools");
    } else {
      blockedKept.push(name);
    }
  }
  const blockedSet = new Set(blockedKept);

  function stripFrom(list, label) {
    const kept = [];
    for (const name of list || []) {
      if (blockedSet.has(name)) {
        warnings.push(
          "blockedTools wins over " + label + " for '" + name + "' — stripped from " + label,
        );
      } else {
        kept.push(name);
      }
    }
    return kept;
  }

  return {
    blockedTools: blockedKept,
    alwaysActive: stripFrom(alwaysActive, "alwaysActive"),
    neverDefer: stripFrom(neverDefer, "neverDefer"),
    deferredNames: stripFrom(deferredNames, "deferredNames"),
    warnings,
  };
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
 * - blockedTools: hard deny — inactive, not searchable, promote refused (replaceBlockedTools)
 * Defaults may list the same stock tools in both pin lists; that is composition of both roles, not dual representation.
 *
 * DCE-O6: deferredNames ∩ (alwaysActive ∪ neverDefer) is stripped from deferredNames
 * (protected role wins). Block then wins over pin/guard/defer name lists.
 */
export function mergeConfig(defaults, user = {}) {
  const replaceAlwaysActive = user.replaceAlwaysActive === true;
  const replaceNeverDefer = user.replaceNeverDefer === true;
  const replaceBlockedTools = user.replaceBlockedTools === true;

  let alwaysActive = mergeStringSetting(defaults, user, "alwaysActive", replaceAlwaysActive);
  let neverDefer = mergeStringSetting(defaults, user, "neverDefer", replaceNeverDefer);
  let deferredMerged = mergeStringSetting(defaults, user, "deferredNames");
  const deferConflict = stripDeferredProtectedConflicts(alwaysActive, neverDefer, deferredMerged);
  deferredMerged = deferConflict.deferredNames;

  const blockedMerged = mergeStringSetting(defaults, user, "blockedTools", replaceBlockedTools);
  const blockConflict = stripBlockedConflicts(blockedMerged, alwaysActive, neverDefer, deferredMerged);

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
 * Blocked tools are handled separately via isBlocked (not deferred).
 */
export function shouldDefer(name, config) {
  if (!config.enabled) return false;
  if (!isString(name) || name.length === 0) return false; // guard: hosts may return nameless tools
  if (SPINE_NAMES.has(name)) return false; // code spine — never deferred (not a user pin)
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
export function isBlocked(name, config, opts = {}) {
  if (!config || !config.enabled) return false;
  if (!isString(name) || name.length === 0) return false;
  if (SPINE_NAMES.has(name)) return false;
  const sessionUnblocked = opts.sessionUnblocked;
  if (sessionUnblocked) {
    const set = sessionUnblocked instanceof Set ? sessionUnblocked : new Set(sessionUnblocked);
    if (set.has(name)) return false;
  }
  if ((config.blockedTools || []).includes(name)) return true;
  if ((config.blockedPrefixes || []).some((prefix) => isString(prefix) && prefix.length > 0 && name.startsWith(prefix))) {
    return true;
  }
  return false;
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

/**
 * CAUTION copy when block lists are non-empty. Promote/search cannot recover blocked tools.
 * @returns {string[]}
 */
export function blockedToolsCautionWarnings(config) {
  if (!hasBlockedConfig(config)) return [];
  const names = (config.blockedTools || []).slice().sort();
  const prefixes = (config.blockedPrefixes || []).slice().sort();
  const parts = [];
  if (names.length > 0) parts.push("tools=[" + names.join(", ") + "]");
  if (prefixes.length > 0) parts.push("prefixes=[" + prefixes.join(", ") + "]");
  return [
    "CAUTION: blocked " +
      parts.join(" ") +
      " — not searchable, promote refused. Escape: /deferred unblock <name> (session) or /deferred unblock <name> --persist. List copy-paste names: /deferred blocked",
  ];
}

/**
 * Remove names from user config blockedTools (persist break-glass). Creates file if missing.
 * Does not edit blockedPrefixes (prefixes stay operator-owned; unblock exact names via session).
 * @param {string[]} names
 * @param {string} [configPath]
 * @returns {{ removed: string[], missing: string[] }}
 */
export function removeBlockedTools(names, configPath = userConfigPath()) {
  const clean = [...new Set(names)].filter((name) => isString(name) && name.length > 0);
  if (clean.length === 0) return { removed: [], missing: [] };
  let raw = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!isObject(raw) || raw === null || Array.isArray(raw)) {
      throw new Error("user config at " + configPath + " is not an object");
    }
  }
  const existing = Array.isArray(raw.blockedTools) ? raw.blockedTools : [];
  const existingSet = new Set(existing);
  const removed = clean.filter((name) => existingSet.has(name));
  const missing = clean.filter((name) => !existingSet.has(name));
  if (removed.length === 0) return { removed: [], missing };
  const removeSet = new Set(removed);
  raw.blockedTools = existing.filter((name) => !removeSet.has(name));
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = configPath + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  fs.renameSync(temp, configPath);
  return { removed, missing };
}

/**
 * Persist promoted tools into the user config's alwaysActive (and neverDefer
 * mirror when present). Creates the config file if missing. Returns the names
 * actually added (already-pinned names are skipped).
 * @param {string[]} names
 * @param {string} [configPath]
 * @returns {string[]}
 */
export function addAlwaysActive(names, configPath = userConfigPath()) {
  const clean = [...new Set(names)].filter((name) => isString(name) && name.length > 0);
  if (clean.length === 0) return [];
  let raw = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!isObject(raw) || raw === null || Array.isArray(raw)) {
      throw new Error("user config at " + configPath + " is not an object");
    }
  }
  const existing = Array.isArray(raw.alwaysActive) ? raw.alwaysActive : [];
  const added = clean.filter((name) => !existing.includes(name));
  if (added.length === 0) return [];
  raw.alwaysActive = [...existing, ...added];
  // Configs that maintain an explicit neverDefer list expect pins mirrored there.
  if (Array.isArray(raw.neverDefer)) {
    raw.neverDefer = [...new Set([...raw.neverDefer, ...added])];
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = configPath + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  fs.renameSync(temp, configPath);
  return added;
}
