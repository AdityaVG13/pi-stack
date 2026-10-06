import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareMigration } from "../lib/cutover.js";
import { legacyPlaceholderKey } from "../lib/credentials.js";

// A stock model would legitimately require no saved override after retirement.
const model = { id: "rotator-fixture-future-chat", name: "saved default", contextWindow: 272000, maxTokens: 128000, input: ["text", "image"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function fixture() {
  return {
    settings: { defaultProvider: "openai-codex", defaultModel: model.id, packages: ["packages/pi-agent-cache", "npm:pi-multi-account", "local-rotator", "npm:custom"] },
    auth: { "openai-codex": { type: "oauth", access: "fixture-base" }, "openai-codex-account-2": { type: "api_key", key: "fixture-marker" }, cursor: { type: "api_key", key: "fixture-cursor" }, custom: { type: "api_key", key: "fixture-custom" } },
    sidecar: { "openai-codex-account-2": { type: "oauth", access: "fixture-original" }, cursor: { type: "oauth", access: "fixture-cursor-original" } },
    models: { customTop: true, providers: {
      "openai-codex": { models: [] },
      "openai-codex-account-2": { api: "openai-codex-responses", baseUrl: "http://127.0.0.1:1234/v1", apiKey: legacyPlaceholderKey("openai-codex-account-2"), headers: { authorization: "retired" }, models: [{ ...model, apiKey: "retired-row", baseUrl: "http://localhost:1234", headers: { authorization: "retired-row" } }, { ...model, id: "gpt-6-sol", name: "stock overwrite forbidden" }] },
      cursor: { api: "openai-completions", baseUrl: "http://127.0.0.1:4321/v1", apiKey: "cursor-proxy", models: [{ ...model, id: "composer-2-fast" }] },
      "cursor-account-3": { api: "openai-completions", baseUrl: "http://127.0.0.1:4321/v1", apiKey: "cursor-proxy", models: [{ ...model, id: "composer-2-fast" }] },
      custom: { api: "openai-completions", baseUrl: "http://127.0.0.1:5000/v1", apiKey: "keep-custom", models: [] },
      "kimi-coding-account-2": { api: "anthropic-messages", baseUrl: "https://api.kimi.com/coding", models: [] },
    } },
  };
}

const restore = (auth, sidecar) => ({ auth: { ...auth, ...sidecar }, sidecar: {} });

test("migration retires only managed routes, preserves current model/native auth and unrelated configuration", () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = prepareMigration(input, restore);
  assert.ok(result);
  assert.deepEqual(result.settings.packages, ["packages/pi-agent-cache", "local-rotator", "npm:custom"]);
  assert.equal(result.settings.defaultModel, model.id);
  assert.equal(result.settings.defaultProvider, "openai-codex");
  assert.deepEqual(result.auth["openai-codex-account-2"], input.sidecar["openai-codex-account-2"]);
  assert.deepEqual(result.auth.custom, input.auth.custom);
  assert.deepEqual(result.sidecar, {});
  assert.equal(result.models.providers["openai-codex-account-2"], undefined);
  assert.deepEqual(result.models.providers["openai-codex"].models, [model]);
  const { id: _id, ...values } = model;
  assert.deepEqual(result.models.providers.cursor, { modelOverrides: { "composer-2-fast": values } });
  assert.equal(result.models.providers["cursor-account-3"], undefined, "unauthenticated obsolete provider cannot retain an unregistered API definition");
  assert.deepEqual(result.models.providers.custom, input.models.providers.custom);
  assert.deepEqual(result.models.providers["kimi-coding-account-2"], input.models.providers["kimi-coding-account-2"]);
  assert.equal(result.models.customTop, true);
  assert.deepEqual(input, before, "planning is read-only");
});

test("migration rejects ambiguous managed transports before writing", () => {
  const wrongAPI = fixture();
  wrongAPI.models.providers["openai-codex-account-2"].api = "custom-protocol";
  assert.throws(() => prepareMigration(wrongAPI, restore), /transport/);
});

test("misshapen provider sections and blank model ids never break migration planning", () => {
  const input = {
    settings: { packages: [] },
    auth: {},
    sidecar: {},
    models: { providers: { cursor: null, "openai-codex": 42, qwen: "x", ollama: null, "anthropic-account-2": [1],
      "openai-codex-account-2": { api: "openai-codex-responses", baseUrl: "http://127.0.0.1:1234/v1", apiKey: legacyPlaceholderKey("openai-codex-account-2"), models: [{ id: "  " }, null, { id: "ok-y", name: "Ok" }] } } },
  };

  const result = prepareMigration(input, restore);

  assert.deepEqual(result.models.providers.cursor, null);
  assert.deepEqual(result.models.providers.qwen, "x");
  assert.deepEqual(result.models.providers.ollama, null);
  assert.deepEqual(result.models.providers["anthropic-account-2"], [1]);
  assert.deepEqual(result.models.providers["openai-codex"], { models: [{ id: "ok-y", name: "Ok" }] }, "misshapen base sections normalize so the legacy catalog still merges");
  assert.equal(result.models.providers["openai-codex-account-2"], undefined, "managed routes still retire");
});

test("unparseable legacy urls are left alone instead of breaking migration planning", () => {
  const input = {
    settings: { packages: [] },
    auth: {},
    sidecar: {},
    models: { providers: { "openai-codex-account-2": { api: "openai-codex-responses", baseUrl: "http://[invalid", apiKey: legacyPlaceholderKey("openai-codex-account-2"), models: [] } } },
  };

  const result = prepareMigration(input, restore);

  assert.deepEqual(result.models.providers["openai-codex-account-2"].baseUrl, "http://[invalid", "an unverifiable route is preserved, not retired or fatal");
});

test("stale settings defaults pass through migration verbatim instead of blocking it", () => {
  // The migration never rewrites defaults and Pi falls back gracefully, so a
  // stale default must not fail the plan (it used to kill every startup).
  const input = fixture();
  input.settings.defaultModel = "missing-current-model";
  const result = prepareMigration(input, restore);
  assert.equal(result.settings.defaultModel, "missing-current-model");
  assert.equal(result.settings.defaultProvider, "openai-codex");
});

test("base-route retirement cannot discard newer sibling catalog entries", () => {
  const input = fixture();
  const extra = { ...model, id: "claude-future-test", name: "sibling-only metadata" };
  input.models.providers["anthropic-account-2"] = { api: "anthropic-messages", baseUrl: "http://localhost:1111/v1", apiKey: "pi-multi-account-proxy", models: [extra] };
  input.models.providers.anthropic = { api: "anthropic-messages", baseUrl: "http://localhost:1111/v1", apiKey: "pi-multi-account-proxy", models: [] };
  const result = prepareMigration(input, restore);
  assert.deepEqual(result.models.providers.anthropic?.models, [extra]);
  assert.equal(result.models.providers.anthropic.baseUrl, undefined);
});

test("stock-only base routes leave no invalid empty native override", () => {
  const input = fixture();
  input.models.providers.anthropic = { api: "anthropic-messages", baseUrl: "http://localhost:1111/v1", apiKey: "pi-multi-account-proxy", models: [] };
  assert.equal(prepareMigration(input, restore).models.providers.anthropic, undefined);
});
