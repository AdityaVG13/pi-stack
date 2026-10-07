import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicStorage } from "./credentials.js";

export const DEFAULT_STRATEGY = "balanced";

export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

const STRATEGIES = ["failover", "round-robin", "balanced"];

export function configPath(agentDir) {
  return join(agentDir, "config", "pi-rotator", "config.json");
}

function saneMs(value, fallback) {
  if (value && Number.isFinite(value) && value >= 1) return Math.floor(value);

  return fallback;
}

export function normalizeConfig(raw) {
  const strategy = raw && STRATEGIES.includes(raw.strategy) ? raw.strategy : DEFAULT_STRATEGY;
  const cooldownMs = saneMs(raw && raw.cooldownMs, DEFAULT_COOLDOWN_MS);
  const ttlMs = saneMs(raw && raw.ttlMs, DEFAULT_TTL_MS);
  const flags = configFlags(raw);
  const ttlByFamily = familyTtls(raw);

  return { enabled: flags.enabled, strategy, cooldownMs, ttlMs, ttlByFamily,
    debugLog: flags.debugLog, announceSwitches: flags.announceSwitches };
}

function configFlags(raw) {
  return {
    enabled: !raw || raw.enabled !== false,
    debugLog: !raw || raw.debugLog !== false,
    announceSwitches: Boolean(raw) && raw.announceSwitches === true,
  };
}

function familyTtls(raw) {
  const rawMap = raw?.ttlByFamily;

  // JSON keys are family IDs, not prototype metadata; array indices are not IDs.
  if (!rawMap || Object.getPrototypeOf(rawMap) !== Object.prototype) return {};

  return Object.fromEntries(Object.entries(rawMap)
    .filter(([base, ms]) => base && Number.isFinite(ms) && ms >= 1)
    .map(([base, ms]) => [base, Math.floor(ms)]));
}

export function loadConfig(agentDir) {
  const path = configPath(agentDir);

  if (!existsSync(path)) return normalizeConfig(null);

  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeConfig(null);
  }
}

export function saveConfig(agentDir, config) {
  mkdirSync(join(agentDir, "config", "pi-rotator"), { recursive: true });
  atomicStorage(configPath(agentDir), normalizeConfig(config));
}
