import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_STRATEGY = "balanced";

export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

const STRATEGIES = ["failover", "round-robin", "balanced"];

export function configPath(agentDir) {
  return join(agentDir, "config", "pi-rotator", "config.json");
}

function saneMs(value, fallback) {
  if (value && Number.isFinite(value) && value > 0) return Math.floor(value);

  return fallback;
}

export function normalizeConfig(raw) {
  const strategy = raw && STRATEGIES.includes(raw.strategy) ? raw.strategy : DEFAULT_STRATEGY;
  const cooldownMs = saneMs(raw && raw.cooldownMs, DEFAULT_COOLDOWN_MS);
  const ttlMs = saneMs(raw && raw.ttlMs, DEFAULT_TTL_MS);
  const enabled = !raw || raw.enabled !== false;
  const debugLog = !raw || raw.debugLog !== false;
  const announceSwitches = Boolean(raw) && raw.announceSwitches === true;
  const ttlByFamily = {};
  // Plain objects only: arrays are objects too, and their indices must
  // never become family names.
  const rawMap = raw && raw.ttlByFamily?.constructor === Object ? raw.ttlByFamily : null;

  if (rawMap) {
    // Object.entries keys are always strings; only emptiness is checked.
    for (const [base, ms] of Object.entries(rawMap)) {
      if (base && Number.isFinite(ms) && ms > 0) {
        ttlByFamily[base] = Math.floor(ms);
      }
    }
  }

  return { enabled, strategy, cooldownMs, ttlMs, ttlByFamily, debugLog, announceSwitches };
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
  writeFileSync(configPath(agentDir), JSON.stringify(normalizeConfig(config), null, 2) + "\n");
}
