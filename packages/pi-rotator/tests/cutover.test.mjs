import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import lockfile from "proper-lockfile";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restoreShadowedAuth, legacyPlaceholderKey, mutateStoredAuth } from "../lib/credentials.js";
import { initializeStandalone, beginCutover } from "../lib/cutover.js";
import { findTransport } from "../lib/rivals.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rotator-cutover-"));
  const oauth = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000, accountId: "fixture-account" };
  const ids = ["anthropic-account-2", "openai-codex-account-2", "openai-codex-account-3", "cursor", "cursor-account-2"];
  const auth = { anthropic: oauth, "openai-codex": oauth, "kimi-coding": { type: "api_key", key: "fixture-kimi" }, unrelated: { type: "api_key", key: "fixture-unrelated" } };
  const sidecar = {};

  for (const id of ids) { auth[id] = { type: "api_key", key: legacyPlaceholderKey(id) }; sidecar[id] = { ...oauth, access: "fixture-" + id }; }

  const models = { providers: { unrelated: { api: "openai-completions", baseUrl: "https://example.invalid/v1", models: [] } } };

  for (const id of ["anthropic", ...ids]) {
    const cursor = id.startsWith("cursor");
    models.providers[id] = { api: cursor ? "openai-completions" : id.startsWith("anthropic") ? "anthropic-messages" : "openai-codex-responses", baseUrl: "http://127.0.0.1:9999/v1/" + id, apiKey: legacyPlaceholderKey(id) || "pi-multi-account-proxy", models: [{ id: cursor ? "cursor-fixture-future" : "rotator-fixture-future-chat", name: "preserved", input: ["text"], reasoning: true, contextWindow: 200000, maxTokens: 32000 }] };
  }

  for (const [name, value] of Object.entries({ "auth.json": auth, "pi-multi-account-proxy-oauth.json": sidecar, "models.json": models, "settings.json": { packages: [], defaultProvider: "openai-codex", defaultModel: "rotator-fixture-future-chat" } })) writeFileSync(join(dir, name), JSON.stringify(value));

  return { dir, oauth, ids, auth, sidecar, models };
}

const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("automatic standalone handoff restores exact logins and catalogs, retains unrelated configuration and is idempotent", () => {
  const f = fixture();
  const settings = readFileSync(join(f.dir, "settings.json"), "utf8");
  const result = initializeStandalone(f.dir);
  assert.equal(result.changed, true);
  const auth = read(f.dir, "auth.json");

  for (const id of f.ids) assert.deepEqual(auth[id], f.sidecar[id], id);
  assert.deepEqual(auth.unrelated, f.auth.unrelated);
  assert.deepEqual(auth["openai-codex"], f.oauth);
  assert.deepEqual(read(f.dir, "pi-multi-account-proxy-oauth.json"), {});
  const models = read(f.dir, "models.json").providers;
  assert.deepEqual(models.unrelated, f.models.providers.unrelated);
  assert.equal(models["openai-codex-account-2"], undefined);
  assert.ok(models["openai-codex"].models.some(m => m.id === "rotator-fixture-future-chat"));
  assert.ok(models.cursor.modelOverrides["cursor-fixture-future"]);
  assert.equal(models.cursor.baseUrl, undefined);
  assert.equal(readFileSync(join(f.dir, "settings.json"), "utf8"), settings);
  assert.equal(initializeStandalone(f.dir).changed, false);
});

test("a stale settings default neither blocks handoff nor gets rewritten", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "openai-codex", defaultModel: "model-removed-upstream" }));
  const result = initializeStandalone(f.dir);
  assert.equal(result.changed, true, "auth/catalog restoration proceeds");
  assert.equal(read(f.dir, "settings.json").defaultModel, "model-removed-upstream");
  assert.match(readFileSync(join(f.dir, "pi-rotator-debug.log"), "utf8"), /"kind":"stale_default"/);
});

test("fresh install creates no credentials or configuration and configured legacy owners prevent automatic writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rotator-fresh-"));
  assert.equal(initializeStandalone(dir).changed, false);
  const f = fixture();
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-multi-account@1.2.3" }] }));
  const before = readFileSync(join(f.dir, "auth.json"), "utf8");
  assert.equal(initializeStandalone(f.dir).changed, false);
  assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), before);
  assert.equal(findTransport([{ source: "npm:@jischeng/pi-multi-account@1.2.3" }]), true);
});

test("stale recovery records never overwrite a new login and unknown slots are not adopted", () => {
  const f = fixture();
  const fresh = { ...f.oauth, access: "fixture-new-login" };
  f.auth["cursor-account-2"] = fresh;
  f.sidecar.custom = f.oauth;
  const result = restoreShadowedAuth(f.auth, f.sidecar);
  assert.deepEqual(result.auth["cursor-account-2"], fresh);
  assert.deepEqual(result.sidecar.custom, f.oauth);
  assert.equal(result.sidecar["cursor-account-2"], undefined);
});

test("sidecar-only recovery credentials are kept until a matching login exists", () => {
  const oauth = { type: "oauth", access: "fixture-sidecar-only", refresh: "fixture-refresh", expires: 1 };
  const result = restoreShadowedAuth({ anthropic: oauth }, { "anthropic-account-2": oauth });
  assert.equal(result.auth["anthropic-account-2"], undefined, "missing logins are not invented from leftover sidecar records");
  assert.deepEqual(result.sidecar["anthropic-account-2"], oauth, "the only remaining recovery copy must not be deleted");
});

test("handoff fails closed on malformed files or ambiguous managed protocols without destroying recovery credentials", () => {
  const f = fixture();
  const auth = readFileSync(join(f.dir, "auth.json"), "utf8");
  f.models.providers.cursor.api = "unrelated-api";
  writeFileSync(join(f.dir, "models.json"), JSON.stringify(f.models));
  assert.throws(() => initializeStandalone(f.dir), /ambiguous/);
  assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), auth);
  writeFileSync(join(f.dir, "models.json"), "{");
  assert.throws(() => initializeStandalone(f.dir), /JSON|storage/);
  assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), auth);
});

test("in-app cutover disables only the old owner, reloads before restoring credentials, and preserves defaults", async () => {
  const f = fixture();
  const settings = { packages: ["npm:unrelated", { source: "npm:pi-multi-account@1.23.2", extensions: ["index.ts"] }, "npm:pi-rotator"], defaultProvider: "openai-codex", defaultModel: "rotator-fixture-future-chat", defaultThinkingLevel: "high" };
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify(settings));
  let reloaded = false;
  await beginCutover(f.dir, { isIdle: () => true, reload: async () => {
    assert.deepEqual(read(f.dir, "settings.json").packages, ["npm:unrelated", "npm:pi-rotator"]);
    assert.deepEqual(read(f.dir, "auth.json"), f.auth, "no credential conversion while the old owner still runs");
    initializeStandalone(f.dir);
    reloaded = true;
  } });

  assert.equal(reloaded, true);
  assert.equal(read(f.dir, "settings.json").defaultThinkingLevel, "high");

  for (const id of f.ids) assert.deepEqual(read(f.dir, "auth.json")[id], f.sidecar[id]);
});

test("busy sessions cannot cut over and a failed reload restores package ownership without overwriting other settings", async () => {
  const f = fixture();
  const settings = { packages: ["npm:pi-multi-account"], unrelated: "before" };
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify(settings));
  await assert.rejects(beginCutover(f.dir, { isIdle: () => false, reload: async () => {} }), /idle/);
  assert.deepEqual(read(f.dir, "settings.json"), settings);
  await assert.rejects(beginCutover(f.dir, { isIdle: () => true, reload: async () => {
    const latest = read(f.dir, "settings.json");
    latest.unrelated = "after";
    writeFileSync(join(f.dir, "settings.json"), JSON.stringify(latest));
    throw new Error("fixture reload failure");
  } }), /reload|Reload/);
  assert.deepEqual(read(f.dir, "settings.json"), { ...settings, unrelated: "after" });
  assert.deepEqual(read(f.dir, "auth.json"), f.auth);
});

test("a separately configured loopback provider is never mistaken for a legacy publication", () => {
  const f = fixture();
  const custom = { api: "anthropic-messages", baseUrl: "http://localhost:7777/v1", apiKey: "$CUSTOM_KEY", models: [{ id: "custom", name: "Custom" }] };
  f.models.providers.anthropic = custom;
  writeFileSync(join(f.dir, "models.json"), JSON.stringify(f.models));
  initializeStandalone(f.dir);
  assert.equal(read(f.dir, "models.json").providers.anthropic.baseUrl, custom.baseUrl);
  assert.equal(read(f.dir, "models.json").providers.anthropic.apiKey, "$CUSTOM_KEY");
});

test("staged restart keeps old-owner credentials and catalogs intact until startup and remains replayable", async () => {
  const f = fixture();
  const settings = { packages: ["npm:unrelated", { source: "npm:pi-multi-account@1.23.2", extensions: ["index.ts"] }, "npm:pi-rotator"], defaultProvider: "openai-codex", defaultModel: "rotator-fixture-future-chat", defaultThinkingLevel: "high" };
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify(settings));

  const snapshots = Object.fromEntries(["auth.json", "models.json", "pi-multi-account-proxy-oauth.json"].map(name => [name, readFileSync(join(f.dir, name), "utf8")]));

  assert.equal(await beginCutover(f.dir, { isIdle: () => true }, { restart: true }), true, "staging must not require or await a reload implementation");
  assert.deepEqual(read(f.dir, "settings.json"), { ...settings, packages: ["npm:unrelated", "npm:pi-rotator"] });

  for (const [name, contents] of Object.entries(snapshots)) assert.equal(readFileSync(join(f.dir, name), "utf8"), contents, "old owner retains " + name);

  assert.equal(await beginCutover(f.dir, { isIdle: () => true }, { restart: true }), false);
  assert.equal(initializeStandalone(f.dir).changed, true);

  for (const id of f.ids) assert.deepEqual(read(f.dir, "auth.json")[id], f.sidecar[id]);

  assert.deepEqual(read(f.dir, "pi-multi-account-proxy-oauth.json"), {});
  assert.equal(initializeStandalone(f.dir).changed, false);
});

test("staged restart still rejects busy sessions and invalid recovery without disabling the owner", async () => {
  const f = fixture();
  const settings = { packages: ["npm:pi-multi-account", "npm:other"] };
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify(settings));
  await assert.rejects(beginCutover(f.dir, { isIdle: () => false }, { restart: true }), /idle/);
  assert.deepEqual(read(f.dir, "settings.json"), settings);
  writeFileSync(join(f.dir, "pi-multi-account-proxy-oauth.json"), JSON.stringify({}));
  await assert.rejects(beginCutover(f.dir, { isIdle: () => true }, { restart: true }), /recovery/);
  assert.deepEqual(read(f.dir, "settings.json"), settings);
  assert.deepEqual(read(f.dir, "auth.json"), f.auth);
});

test("handoff and locked credential updates preserve reserved JSON provider names", () => {
  const f = fixture();
  const unusual = Object.fromEntries(["constructor", "__proto__", "toString"].map(id => [id, { type: "api_key", key: "fixture-" + id }]));
  const auth = { ...f.auth, ...unusual };
  writeFileSync(join(f.dir, "auth.json"), JSON.stringify(auth));
  assert.equal(initializeStandalone(f.dir).changed, true);
  const restored = read(f.dir, "auth.json");

  for (const id of f.ids) assert.deepEqual(restored[id], f.sidecar[id]);

  for (const [id, credential] of Object.entries(unusual)) assert.deepEqual(restored[id], credential);

  assert.equal(initializeStandalone(f.dir).changed, false);
  mutateStoredAuth(join(f.dir, "auth.json"), current => ({ ...current, unrelated: { type: "api_key", key: "fixture-relogin" } }));
  assert.deepEqual(read(f.dir, "auth.json"), { ...restored, unrelated: { type: "api_key", key: "fixture-relogin" } });
});

test("lock ownership blocks competing credential writers and releases partial handoffs and failed transforms", () => {
  const f = fixture();
  const path = join(f.dir, "auth.json");
  const before = Object.fromEntries(["auth.json", "models.json", "pi-multi-account-proxy-oauth.json"].map(name => [name, readFileSync(join(f.dir, name), "utf8")]));
  const release = lockfile.lockSync(path, { realpath: false });

  try {
    assert.throws(() => initializeStandalone(f.dir), { code: "ELOCKED" });
    assert.throws(() => mutateStoredAuth(path, () => ({ overwritten: true })), { code: "ELOCKED" });
    assert.equal(existsSync(join(f.dir, "models.json.lock")), false, "a failed second lock releases the first");

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { mutateStoredAuth } from ${JSON.stringify(new URL("../lib/credentials.js", import.meta.url).href)};
      import assert from 'node:assert/strict';
      assert.throws(() => mutateStoredAuth(${JSON.stringify(path)}, () => ({ overwritten: true })), { code: 'ELOCKED' });
    `], { encoding: "utf8", timeout: 3000 });

    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.equal(existsSync(path + ".lock"), true, "a failed competing process must not release the owner's lock");

    for (const [name, text] of Object.entries(before)) assert.equal(readFileSync(join(f.dir, name), "utf8"), text);
  } finally {
    release();
  }

  assert.throws(() => mutateStoredAuth(path, () => { throw new Error("fixture transform failure"); }), /fixture transform failure/);
  assert.equal(existsSync(path + ".lock"), false);
  assert.equal(initializeStandalone(f.dir).changed, true, "handoff can acquire both locks after the failures");
});

test("handoff preserves unrecognized prototype-named loopback providers while restoring native accounts", () => {
  const f = fixture();
  const unknown = ["constructor", "__proto__", "toString", "hasOwnProperty"].map(base => [base + "-account-2", { api: "openai-completions", baseUrl: "http://127.0.0.1:9998/v1", apiKey: "pi-multi-account-proxy", models: [{ id: "fixture-foreign-model" }] }]);
  f.models.providers = Object.fromEntries([...Object.entries(f.models.providers), ...unknown]);
  writeFileSync(join(f.dir, "models.json"), JSON.stringify(f.models));
  assert.doesNotThrow(() => initializeStandalone(f.dir), "unknown providers do not block handoff");
  const providers = read(f.dir, "models.json").providers;

  for (const [id, source] of unknown) assert.deepEqual(providers[id], source, "unknown providers are outside managed transport ownership");

  const auth = read(f.dir, "auth.json");

  for (const id of f.ids) assert.deepEqual(auth[id], f.sidecar[id], "unrecognized provider names must not block native credential restoration");
});
