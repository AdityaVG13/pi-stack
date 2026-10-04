import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, defaultConfigPath, DEFAULT_CONFIG, loadConfig, makeConfig, parseConfig, replaceConfig } from "../lib/config.ts";
import { detect } from "../lib/dialects/index.ts";

describe("config", () => {
  it("parses snake_case and camelCase keys", () => {
    const a = parseConfig({ keep_recent: 1, thought_max_chars: 300 });
    const b = parseConfig({ keepRecent: 1, thoughtMaxChars: 300 });

    assert.equal(a.keepRecent, 1);
    assert.equal(a.thoughtMaxChars, 300);
    assert.equal(b.keepRecent, 1);
    assert.equal(b.thoughtMaxChars, 300);
    assert.equal(a.resultMaxChars, DEFAULT_CONFIG.resultMaxChars);
  });

  it("ignores unknown keys and non-objects", () => {
    assert.equal(parseConfig(null).keepRecent, DEFAULT_CONFIG.keepRecent);
    assert.equal(parseConfig({ keepRecent: "nope" }).keepRecent, DEFAULT_CONFIG.keepRecent);
    assert.equal(makeConfig({ keepRecent: 2 }).keepRecent, 2);
  });

  it("replaceConfig only overrides named fields", () => {
    const next = replaceConfig(DEFAULT_CONFIG, { keepRecent: 1, keepThinking: false });

    assert.equal(next.keepRecent, 1);
    assert.equal(next.keepThinking, false);
    assert.equal(next.resultMaxChars, DEFAULT_CONFIG.resultMaxChars);
  });

  it("honors explicit host config directories without cross-host fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "cliff-config-"));
    const home = join(root, "home");
    const piDefault = join(home, ".pi", "agent");
    const ompDefault = join(home, ".omp", "agent");
    const piOverride = join(root, "pi-override");
    const ompOverride = join(root, "omp-override");

    const saved = new Map(["HOME", "PI_CLIFF_CONFIG", "OMP_CLIFF_CONFIG", "PI_CONFIG_DIR", "OMP_CONFIG_DIR", "CLIFF_KEEP_RECENT"]
      .map(key => [key, process.env[key]]));

    for (const [dir, keepRecent] of [[piDefault, 1], [ompDefault, 9], [piOverride, 5], [ompOverride, 7]]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cliffcompaction.json"), JSON.stringify({ keepRecent }));
    }

    try {
      for (const key of saved.keys()) delete process.env[key];
      process.env.HOME = home;
      assert.equal(homedir(), home);
      assert.equal(defaultConfigPath(), join(piDefault, "cliffcompaction.json"));
      assert.equal(loadConfig().keepRecent, 1);

      for (const [key, dir, keepRecent] of [
        ["OMP_CONFIG_DIR", ompOverride, 7],
        ["OMP_CONFIG_DIR", join(root, "missing-omp"), DEFAULT_CONFIG.keepRecent],
        ["PI_CONFIG_DIR", piOverride, 5],
        ["PI_CONFIG_DIR", join(root, "missing-pi"), DEFAULT_CONFIG.keepRecent],
      ]) {
        delete process.env.PI_CONFIG_DIR;
        delete process.env.OMP_CONFIG_DIR;
        process.env[key] = dir;
        assert.equal(defaultConfigPath(), join(dir, "cliffcompaction.json"), key);
        assert.equal(loadConfig().keepRecent, keepRecent, key);
      }

      process.env.OMP_CLIFF_CONFIG = join(ompDefault, "cliffcompaction.json");
      assert.equal(loadConfig().keepRecent, 9);
      process.env.PI_CLIFF_CONFIG = join(piDefault, "cliffcompaction.json");
      assert.equal(loadConfig().keepRecent, 1);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects partial and negative integers instead of parseInt leftovers", () => {
    const prevKeep = process.env.CLIFF_KEEP_RECENT;
    const prevThreshold = process.env.CLIFF_THRESHOLD_TOKENS;

    try {
      process.env.CLIFF_KEEP_RECENT = "1abc";
      assert.equal(configFromEnv().keepRecent, DEFAULT_CONFIG.keepRecent);

      process.env.CLIFF_KEEP_RECENT = "-5";
      assert.equal(configFromEnv().keepRecent, DEFAULT_CONFIG.keepRecent);

      process.env.CLIFF_KEEP_RECENT = "0x10";
      assert.equal(configFromEnv().keepRecent, DEFAULT_CONFIG.keepRecent);

      process.env.CLIFF_KEEP_RECENT = "2";
      assert.equal(configFromEnv().keepRecent, 2);

      delete process.env.CLIFF_KEEP_RECENT;
      process.env.CLIFF_THRESHOLD_TOKENS = "100oops";
      assert.equal(configFromEnv().thresholdTokens, DEFAULT_CONFIG.thresholdTokens);
    } finally {
      if (prevKeep === undefined) {
        delete process.env.CLIFF_KEEP_RECENT;
      } else {
        process.env.CLIFF_KEEP_RECENT = prevKeep;
      }

      if (prevThreshold === undefined) {
        delete process.env.CLIFF_THRESHOLD_TOKENS;
      } else {
        process.env.CLIFF_THRESHOLD_TOKENS = prevThreshold;
      }
    }

    assert.equal(parseConfig({ keepRecent: -1 }).keepRecent, DEFAULT_CONFIG.keepRecent);
    assert.equal(parseConfig({ thresholdTokens: -1 }).thresholdTokens, DEFAULT_CONFIG.thresholdTokens);
  });
});

describe("detect", () => {
  it("maps Anthropic, Chat Completions, and Responses paths", () => {
    assert.equal(detect("/v1/messages").name, "anthropic");
    assert.equal(detect("/v1/chat/completions").name, "openai");
    assert.equal(detect("/v1/responses").name, "openai-responses");
    assert.equal(detect("/v1/messages/count_tokens"), null);
    assert.equal(detect("/v1/responses/compact"), null);
  });
});
