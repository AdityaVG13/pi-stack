/**
 * Boundary-parse unit tests (pass04): parse once at trust edge; reject illegal wire shapes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KNOWN_CONFIG_KEYS,
  loadConfig,
  mergeConfig,
  parsePromotionLifetime,
  parseUserConfig,
} from "../config.js";
import {
  parseDeferredCommand,
  parseSearchToolsParams,
  parseToolNames,
} from "../index.js";

test("parseUserConfig rejects non-objects", () => {
  assert.equal(parseUserConfig(null).ok, false);
  assert.equal(parseUserConfig([]).ok, false);
  assert.equal(parseUserConfig("x").ok, false);
  assert.match(parseUserConfig(42).error, /JSON object/);
});

test("parseUserConfig strips unknown keys (non-strict) and refuses them (strict)", () => {
  const raw = { enabled: false, garbageField: true, another: 1 };
  const soft = parseUserConfig(raw, { strict: false });
  assert.equal(soft.ok, true);
  assert.equal(soft.value.enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(soft.value, "garbageField"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(soft.value, "another"), false);

  const hard = parseUserConfig(raw, { strict: true });
  assert.equal(hard.ok, false);
  assert.match(hard.error, /unknown config key/);
  assert.match(hard.error, /garbageField/);
});

test("parseUserConfig + mergeConfig never reintroduce open user keys", () => {
  const defaults = loadConfig(path.join(os.tmpdir(), `pi-deferred-missing-bp-${Date.now()}.json`));
  const parsed = parseUserConfig({
    enabled: true,
    alwaysActive: ["x"],
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    neverDefer: ["x"],
    __proto__: null,
    extraRuntime: "nope",
  });
  assert.equal(parsed.ok, true);
  const merged = mergeConfig(defaults, parsed.value);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "extraRuntime"), false);
  for (const key of Object.keys(merged)) {
    assert.ok(KNOWN_CONFIG_KEYS.includes(key), "unexpected runtime key: " + key);
  }
  assert.deepEqual(merged.alwaysActive, ["x"]);
});

test("parsePromotionLifetime is run|session only", () => {
  assert.deepEqual(parsePromotionLifetime("run"), { ok: true, value: "run" });
  assert.deepEqual(parsePromotionLifetime("session"), { ok: true, value: "session" });
  assert.equal(parsePromotionLifetime("forever").ok, false);
  assert.equal(parsePromotionLifetime("").ok, false);
  assert.equal(parsePromotionLifetime(null).ok, false);
});

test("strict loadConfig rejects unknown keys and bad promotionLifetime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-bp-"));
  try {
    const unknownPath = path.join(directory, "unknown.json");
    fs.writeFileSync(unknownPath, JSON.stringify({ enabled: true, notAKey: 1 }), "utf8");
    assert.throws(() => loadConfig(unknownPath, { strict: true }), /unknown config key|Invalid deferred-tools config/);

    const lifePath = path.join(directory, "life.json");
    fs.writeFileSync(lifePath, JSON.stringify({ promotionLifetime: "forever" }), "utf8");
    assert.throws(() => loadConfig(lifePath, { strict: true }), /promotionLifetime|Invalid deferred-tools config/);

    // non-strict falls back / strips
    assert.equal(loadConfig(unknownPath).enabled, true);
    assert.equal(loadConfig(lifePath).promotionLifetime, "run");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("parseToolNames requires non-empty string array", () => {
  assert.equal(parseToolNames(undefined).ok, false);
  assert.equal(parseToolNames([]).ok, false);
  assert.equal(parseToolNames(["", "read"]).ok, false);
  assert.equal(parseToolNames([1, "read"]).ok, false);
  assert.equal(parseToolNames("read").ok, false);
  const ok = parseToolNames(["read", "bash"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, ["read", "bash"]);
});

test("parseSearchToolsParams closes kind/limit; empty query stays valid", () => {
  const empty = parseSearchToolsParams({ query: "" }, { maxSearchResults: 3 });
  assert.equal(empty.ok, true);
  assert.equal(empty.value.query, "");
  assert.equal(empty.value.kind, "all");
  assert.equal(empty.value.limit, 3);

  const stop = parseSearchToolsParams({ query: "the a", kind: "tool", limit: 2 }, { maxSearchResults: 5 });
  assert.equal(stop.ok, true);
  assert.equal(stop.value.kind, "tool");
  assert.equal(stop.value.limit, 2);

  assert.equal(parseSearchToolsParams({ query: "x", kind: "widget" }).ok, false);
  assert.equal(parseSearchToolsParams({ query: "x", limit: 0 }).ok, false);
  assert.equal(parseSearchToolsParams({ query: "x", limit: 1.5 }).ok, false);
  assert.equal(parseSearchToolsParams({ query: 9 }).ok, false);
  assert.equal(parseSearchToolsParams(null).ok, false);

  // clamp to maxSearchResults
  const clamped = parseSearchToolsParams({ query: "x", limit: 99 }, { maxSearchResults: 4 });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.value.limit, 4);
});

test("parseDeferredCommand is closed status|audit|apply|reload|config|blocked|unblock", () => {
  assert.deepEqual(parseDeferredCommand(""), { ok: true, value: "status" });
  assert.deepEqual(parseDeferredCommand(undefined), { ok: true, value: "status" });
  assert.deepEqual(parseDeferredCommand(null), { ok: true, value: "status" });
  assert.deepEqual(parseDeferredCommand("  AUDIT  "), { ok: true, value: "audit" });
  assert.deepEqual(parseDeferredCommand("reload"), { ok: true, value: "reload" });
  assert.deepEqual(parseDeferredCommand("config"), { ok: true, value: "config" });
  assert.deepEqual(parseDeferredCommand("apply"), { ok: true, value: "apply" });
  assert.deepEqual(parseDeferredCommand("blocked"), { ok: true, value: "blocked" });
  assert.deepEqual(parseDeferredCommand("unblock"), {
    ok: true,
    value: "unblock",
    names: [],
    persist: false,
  });
  assert.deepEqual(parseDeferredCommand("unblock grep glob --persist"), {
    ok: true,
    value: "unblock",
    names: ["grep", "glob"],
    persist: true,
  });
  const bad = parseDeferredCommand("nuke");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /usage: \/deferred/);
  assert.equal(parseDeferredCommand("status extra").ok, false);
  assert.equal(parseDeferredCommand("apply now").ok, false);
  assert.equal(parseDeferredCommand("blocked extra").ok, false);
  assert.equal(parseDeferredCommand("drop").ok, false);
  assert.equal(parseDeferredCommand("unblock grep --force").ok, false);
  // Refuse non-string garbage (no String(["status"]) → "status" dual)
  assert.equal(parseDeferredCommand(42).ok, false);
  assert.equal(parseDeferredCommand({}).ok, false);
  assert.equal(parseDeferredCommand(["status"]).ok, false);
  assert.equal(parseDeferredCommand(true).ok, false);
});


test("joint: non-strict loadConfig falls back on non-object JSON; strict refuses", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-bp-arr-"));
  try {
    const arrPath = path.join(directory, "arr.json");
    fs.writeFileSync(arrPath, JSON.stringify([{ enabled: false }]), "utf8");
    // non-strict: array is non-object → parse fail → defaults
    const soft = loadConfig(arrPath);
    assert.equal(soft.enabled, true);
    assert.throws(
      () => loadConfig(arrPath, { strict: true }),
      /Invalid deferred-tools config|JSON object/,
    );
    const numPath = path.join(directory, "num.json");
    fs.writeFileSync(numPath, "42", "utf8");
    assert.equal(loadConfig(numPath).enabled, true);
    assert.throws(() => loadConfig(numPath, { strict: true }), /Invalid deferred-tools config|JSON object/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
