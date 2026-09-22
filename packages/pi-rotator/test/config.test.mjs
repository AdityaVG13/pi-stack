import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_STRATEGY,
  DEFAULT_TTL_MS,
  normalizeConfig,
} from "../lib/config.js";

describe("config", () => {
  it("defaults to enabled balanced routing", () => {
    const expected = {
      enabled: true,
      strategy: DEFAULT_STRATEGY,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      ttlMs: DEFAULT_TTL_MS,
      ttlByFamily: {},
      debugLog: true,
      announceSwitches: false,
    };

    assert.deepEqual(normalizeConfig(null), expected);
    assert.deepEqual(normalizeConfig(undefined), expected);
    assert.deepEqual(normalizeConfig(42), expected);
    assert.deepEqual(normalizeConfig("nope"), expected);
    assert.equal(DEFAULT_STRATEGY, "balanced");
  });

  it("accepts every strategy and rejects anything else", () => {
    assert.equal(normalizeConfig({ strategy: "failover" }).strategy, "failover");
    assert.equal(normalizeConfig({ strategy: "round-robin" }).strategy, "round-robin");
    assert.equal(normalizeConfig({ strategy: "balanced" }).strategy, "balanced");
    assert.equal(normalizeConfig({ strategy: "random" }).strategy, DEFAULT_STRATEGY);
  });

  it("keeps sane windows and flags", () => {
    assert.equal(normalizeConfig({ cooldownMs: 60000 }).cooldownMs, 60000);
    assert.equal(normalizeConfig({ cooldownMs: -5 }).cooldownMs, DEFAULT_COOLDOWN_MS);
    assert.equal(normalizeConfig({ ttlMs: 60000 }).ttlMs, 60000);
    assert.equal(normalizeConfig({ ttlMs: 0 }).ttlMs, DEFAULT_TTL_MS);
    assert.equal(normalizeConfig({ enabled: false }).enabled, false);
    assert.equal(normalizeConfig({ debugLog: false }).debugLog, false);
  });

  it("normalizes per-family TTL overrides", () => {
    assert.deepEqual(
      normalizeConfig({ ttlByFamily: { "openai-codex": 600000 } }).ttlByFamily,
      { "openai-codex": 600000 },
    );
    assert.deepEqual(
      normalizeConfig({ ttlByFamily: { "openai-codex": -5, "": 1000 } }).ttlByFamily,
      {},
    );
    assert.deepEqual(normalizeConfig({ ttlByFamily: "nope" }).ttlByFamily, {});
  });

  it("rejects array TTL maps instead of indexing them as families", () => {
    // Arrays are objects: without the shape check, ["0"] becomes a family.
    assert.deepEqual(normalizeConfig({ ttlByFamily: [600000] }).ttlByFamily, {});
    assert.deepEqual(normalizeConfig({ ttlByFamily: [] }).ttlByFamily, {});
  });

  it("floors fractional windows and disables only on exact false", () => {
    assert.equal(normalizeConfig({ cooldownMs: 60000.9 }).cooldownMs, 60000);
    assert.equal(normalizeConfig({ enabled: 0 }).enabled, true);
    assert.equal(normalizeConfig({ enabled: "" }).enabled, true);
    assert.equal(normalizeConfig({ debugLog: 0 }).debugLog, true);
  });

  it("stays silent unless announcements are enabled with exact true", () => {
    // Inverse polarity to enabled/debugLog: ship behavior is silent, and
    // only an explicit true opts into per-rotation notices.
    assert.equal(normalizeConfig({}).announceSwitches, false);
    assert.equal(normalizeConfig({ announceSwitches: true }).announceSwitches, true);
    assert.equal(normalizeConfig({ announceSwitches: "yes" }).announceSwitches, false);
    assert.equal(normalizeConfig({ announceSwitches: 1 }).announceSwitches, false);
  });
});
