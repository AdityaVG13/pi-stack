import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODEX_API,
  CODEX_BASE,
  CODEX_BASE_URL,
  codexModelDef,
  defaultCodexModels,
  loadCodexBridge,
  registerCodexSlot,
  toAuthInteraction,
} from "../lib/codex.js";

describe("codex", () => {
  it("pins the transport constants and model shape", () => {
    assert.equal(CODEX_BASE, "openai-codex");
    assert.equal(CODEX_BASE_URL, "https://chatgpt.com/backend-api");
    assert.equal(CODEX_API, "openai-codex-responses");
    assert.deepEqual(codexModelDef("gpt-5.5"), {
      id: "gpt-5.5",
      name: "gpt-5.5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 272000,
      maxTokens: 128000,
    });
  });

  it("pins the fallback flagship ids in order", () => {
    assert.deepEqual(
      defaultCodexModels().map((model) => model.id),
      [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-daybreak-blue-latest",
        "gpt-5.5",
      ],
    );
  });

  it("translates auth_url and device_code events to host callbacks", () => {
    const calls = [];

    const interaction = toAuthInteraction({
      signal: "sig",
      onAuth: (auth) => calls.push(["auth", auth]),
      onDeviceCode: (code) => calls.push(["device", code]),
      onProgress: (text) => calls.push(["progress", text]),
    });

    assert.equal(interaction.signal, "sig");
    interaction.notify({ type: "auth_url", url: "https://u", instructions: "open it" });
    interaction.notify({
      type: "device_code",
      userCode: "A1",
      verificationUri: "https://v",
      intervalSeconds: 5,
      expiresInSeconds: 60,
    });

    assert.deepEqual(calls, [
      ["auth", { url: "https://u", instructions: "open it" }],
      [
        "device",
        {
          userCode: "A1",
          verificationUri: "https://v",
          intervalSeconds: 5,
          expiresInSeconds: 60,
        },
      ],
    ]);
  });

  it("funnels unknown and nullish events to progress, never throws", () => {
    const calls = [];
    const interaction = toAuthInteraction({ onProgress: (text) => calls.push(text) });

    interaction.notify({ type: "polling" });
    interaction.notify(null);
    interaction.notify(undefined);

    assert.deepEqual(calls, ["[object Object]", "", ""]);

    const bare = toAuthInteraction(null);

    assert.equal(bare.signal, undefined);
    assert.doesNotThrow(() => bare.notify({ type: "auth_url", url: "u" }));
    assert.doesNotThrow(() =>
      toAuthInteraction({}).notify({ type: "device_code", userCode: "A1" }),
    );
  });

  it("leaves the base slot to the native registration", () => {
    let calls = 0;
    const pi = { registerProvider: () => calls++ };

    assert.equal(registerCodexSlot(pi, CODEX_BASE, [], "file:///nowhere/entry.mjs"), "base");
    assert.equal(calls, 0);
  });

  it("registers alias slots with the declared def", () => {
    const calls = [];
    const pi = { registerProvider: (...args) => calls.push(args) };
    const models = defaultCodexModels();

    assert.equal(
      registerCodexSlot(pi, "openai-codex-account-2", models, "file:///nowhere/entry.mjs"),
      "alias",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "openai-codex-account-2");
    assert.equal(calls[0][1].baseUrl, CODEX_BASE_URL);
    assert.equal(calls[0][1].api, CODEX_API);
    assert.equal(calls[0][1].models, models);
    assert.match(calls[0][1].name, /account-2/);
    assert.equal(calls[0][1].oauth.getApiKey({ access: "k" }), "k");
  });

  it("reports an actionable error when the bridge is unavailable", () => {
    const calls = [];
    const pi = { registerProvider: (...args) => calls.push(args) };

    registerCodexSlot(pi, "openai-codex-account-2", [], "file:///nowhere/entry.mjs");
    const oauth = calls[0][1].oauth;

    assert.throws(() => oauth.login({}), /pi-ai was not found/);
    assert.throws(() => oauth.refreshToken({}, null), /pi-ai was not found/);
  });

  it("loads the bridge through a fixture registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-codex-"));
    const providersDir = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers");

    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, "openai-codex.js"),
      "module.exports.openaiCodexProvider = () => ({ auth: { oauth: { login: () => 'L', refresh: () => 'R' } } });\n",
    );
    const bridge = loadCodexBridge(pathToFileURL(join(dir, "entry.mjs")).href);

    assert.equal(bridge.usesCallbackServer, true);
    assert.equal(bridge.login({}), "L");
    assert.equal(bridge.refresh({}, null), "R");
  });

  it("rejects bridge modules without a full oauth pair", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-codex-bad-"));
    const providersDir = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers");

    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, "openai-codex.js"),
      "module.exports.openaiCodexProvider = () => ({ auth: { oauth: { login: () => 'L' } } });\n",
    );

    assert.equal(loadCodexBridge(pathToFileURL(join(dir, "entry.mjs")).href), null);
    assert.equal(loadCodexBridge("file:///nowhere/entry.mjs"), null);
  });
});
