/**
 * Compaction knobs. CLIFF_* env vars and an optional JSON file; the Pi
 * extension also reads cliffcompaction.json from the host config dir.
 *
 * Names match the reference implementation (arxiv:2609.26779 / GitHub
 * nguyenvuthientrang/cliffcompaction). Paper Algorithm 1 uses thought
 * truncation of 300 and keep-recent K turn-pairs; the open-source defaults
 * keep assistant text unlimited and keep_recent=3 assistant-step turns.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  asObject,
  isBoolean,
  isNumber,
  type JsonObject,
  type JsonValue,
} from "./decode.ts";

export type Config = {
  enabled: boolean;
  thresholdTokens: number;
  keepRecent: number;
  thoughtMaxChars: number;
  cmdMaxChars: number;
  resultMaxChars: number;
  humanMaxChars: number;
  keepThinking: boolean;
  thinkingMaxChars: number;
  shadow: boolean;
  strict: boolean;
  storeMaxEntries: number;
  storeMaxBytes: number;
};

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  thresholdTokens: 200_000,
  keepRecent: 3,
  thoughtMaxChars: 0,
  cmdMaxChars: 150,
  resultMaxChars: 500,
  humanMaxChars: 20_000,
  keepThinking: true,
  thinkingMaxChars: 0,
  shadow: false,
  strict: false,
  storeMaxEntries: 4096,
  storeMaxBytes: 64 * 1024 * 1024,
};

export type ConfigPatch = Partial<Config>;

function envRaw(name: string): string | undefined {
  const value = process.env[name];

  if (value === undefined) {
    return undefined;
  }

  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = envRaw(name);

  if (raw === undefined) {
    return fallback;
  }

  const n = Number.parseInt(raw, 10);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envRaw(name);

  if (raw === undefined) {
    return fallback;
  }

  const v = raw.trim().toLowerCase();

  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function makeConfig(patch: ConfigPatch = {}): Config {
  return {
    enabled: patch.enabled ?? DEFAULT_CONFIG.enabled,
    thresholdTokens: patch.thresholdTokens ?? DEFAULT_CONFIG.thresholdTokens,
    keepRecent: patch.keepRecent ?? DEFAULT_CONFIG.keepRecent,
    thoughtMaxChars: patch.thoughtMaxChars ?? DEFAULT_CONFIG.thoughtMaxChars,
    cmdMaxChars: patch.cmdMaxChars ?? DEFAULT_CONFIG.cmdMaxChars,
    resultMaxChars: patch.resultMaxChars ?? DEFAULT_CONFIG.resultMaxChars,
    humanMaxChars: patch.humanMaxChars ?? DEFAULT_CONFIG.humanMaxChars,
    keepThinking: patch.keepThinking ?? DEFAULT_CONFIG.keepThinking,
    thinkingMaxChars: patch.thinkingMaxChars ?? DEFAULT_CONFIG.thinkingMaxChars,
    shadow: patch.shadow ?? DEFAULT_CONFIG.shadow,
    strict: patch.strict ?? DEFAULT_CONFIG.strict,
    storeMaxEntries: patch.storeMaxEntries ?? DEFAULT_CONFIG.storeMaxEntries,
    storeMaxBytes: patch.storeMaxBytes ?? DEFAULT_CONFIG.storeMaxBytes,
  };
}

export function replaceConfig(cfg: Config, patch: ConfigPatch): Config {
  return makeConfig({ ...cfg, ...patch });
}

function intField(obj: JsonObject, snake: string, camel: string, fallback: number): number {
  const raw = obj[snake] ?? obj[camel];

  if (isNumber(raw) && Number.isInteger(raw)) {
    return raw;
  }

  return fallback;
}

function boolField(obj: JsonObject, snake: string, camel: string, fallback: boolean): boolean {
  const raw = obj[snake] ?? obj[camel];

  if (isBoolean(raw)) {
    return raw;
  }

  return fallback;
}

/** Parse a JSON config object. Unknown keys ignored. */
export function parseConfig(raw: JsonValue, base: Config = DEFAULT_CONFIG): Config {
  const obj = asObject(raw);

  if (obj === null) {
    return base;
  }

  return makeConfig({
    enabled: boolField(obj, "enabled", "enabled", base.enabled),
    thresholdTokens: intField(obj, "threshold_tokens", "thresholdTokens", base.thresholdTokens),
    keepRecent: intField(obj, "keep_recent", "keepRecent", base.keepRecent),
    thoughtMaxChars: intField(obj, "thought_max_chars", "thoughtMaxChars", base.thoughtMaxChars),
    cmdMaxChars: intField(obj, "cmd_max_chars", "cmdMaxChars", base.cmdMaxChars),
    resultMaxChars: intField(obj, "result_max_chars", "resultMaxChars", base.resultMaxChars),
    humanMaxChars: intField(obj, "human_max_chars", "humanMaxChars", base.humanMaxChars),
    keepThinking: boolField(obj, "keep_thinking", "keepThinking", base.keepThinking),
    thinkingMaxChars: intField(obj, "thinking_max_chars", "thinkingMaxChars", base.thinkingMaxChars),
    shadow: boolField(obj, "shadow", "shadow", base.shadow),
    strict: boolField(obj, "strict", "strict", base.strict),
    storeMaxEntries: intField(obj, "store_max_entries", "storeMaxEntries", base.storeMaxEntries),
    storeMaxBytes: intField(obj, "store_max_bytes", "storeMaxBytes", base.storeMaxBytes),
  });
}

export function configFromEnv(base: Config = DEFAULT_CONFIG): Config {
  return makeConfig({
    enabled: envBool("CLIFF_ENABLED", base.enabled),
    thresholdTokens: envInt("CLIFF_THRESHOLD_TOKENS", base.thresholdTokens),
    keepRecent: envInt("CLIFF_KEEP_RECENT", base.keepRecent),
    thoughtMaxChars: envInt("CLIFF_THOUGHT_MAX_CHARS", base.thoughtMaxChars),
    cmdMaxChars: envInt("CLIFF_CMD_MAX_CHARS", base.cmdMaxChars),
    resultMaxChars: envInt("CLIFF_RESULT_MAX_CHARS", base.resultMaxChars),
    humanMaxChars: envInt("CLIFF_HUMAN_MAX_CHARS", base.humanMaxChars),
    keepThinking: envBool("CLIFF_KEEP_THINKING", base.keepThinking),
    thinkingMaxChars: envInt("CLIFF_THINKING_MAX_CHARS", base.thinkingMaxChars),
    shadow: envBool("CLIFF_SHADOW", base.shadow),
    strict: envBool("CLIFF_STRICT", base.strict),
    storeMaxEntries: envInt("CLIFF_STORE_MAX_ENTRIES", base.storeMaxEntries),
    storeMaxBytes: envInt("CLIFF_STORE_MAX_BYTES", base.storeMaxBytes),
  });
}

export function defaultConfigPath(): string {
  const explicit = envRaw("PI_CLIFF_CONFIG") ?? envRaw("OMP_CLIFF_CONFIG");

  if (explicit) {
    return explicit;
  }

  const home = homedir();
  const piDir = envRaw("PI_CONFIG_DIR") ?? join(home, ".pi", "agent");
  const ompDir = envRaw("OMP_CONFIG_DIR") ?? join(home, ".omp", "agent");
  const piPath = join(piDir, "cliffcompaction.json");
  const ompPath = join(ompDir, "cliffcompaction.json");

  if (existsSync(piPath)) {
    return piPath;
  }

  if (existsSync(ompPath)) {
    return ompPath;
  }

  return piPath;
}

export function loadConfigFile(path: string): Config | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const text = readFileSync(path, "utf8");
    const parsed: JsonValue = JSON.parse(text);

    return parseConfig(parsed);
  } catch {
    return null;
  }
}

/** File (if present) then CLIFF_* env overrides. */
export function loadConfig(): Config {
  const fromFile = loadConfigFile(defaultConfigPath());
  const base = fromFile ?? DEFAULT_CONFIG;

  return configFromEnv(base);
}

