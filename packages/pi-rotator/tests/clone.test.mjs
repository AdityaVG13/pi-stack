import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aliasDef,
  builtinBase,
  nativeBuiltinModule,
} from "../lib/clone.js";
import { providerBase, registerOwnedAlias } from "../lib/accounts.js";

function fakeBase() {
  return {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { oauth: { login: () => {}, refresh: () => {} } },
    getModels: () => [{ id: "gpt-5.5" }],
    stream: () => {},
  };
}

function fakeModule() {
  // Like the real registry: fresh instances on every call.
  return {
    builtinProviders: () => [
      fakeBase(),
      { ...fakeBase(), id: "anthropic", name: "Anthropic" },
    ],
  };
}

describe("clone", () => {
  it("aliasDef re-identifies without touching behavior", () => {
    const base = fakeBase();
    const alias = aliasDef(base, "openai-codex-account-2", 2);

    assert.equal(alias.id, "openai-codex-account-2");
    assert.equal(alias.name, "ChatGPT Plus/Pro (account 2)");
    assert.equal(alias.baseUrl, base.baseUrl);
    assert.equal(alias.auth, base.auth);
    assert.deepEqual(alias.getModels(), [{ id: "gpt-5.5", provider: alias.id }]);
    assert.equal(alias.stream, base.stream);
    // Copy, not mutation: the base def must survive aliasing intact.
    assert.notEqual(alias, base);
    assert.equal(base.id, "openai-codex");
    assert.equal(base.name, "ChatGPT Plus/Pro");
  });

  it("aliasDef retains native streamSimple without legacy config validation", () => {
    // Complete native registration selects the Provider overload, so dropping
    // streamSimple would discard the provider's modern transcript handling.
    const streamSimple = () => {};

    const base = { ...fakeBase(), streamSimple };
    const alias = aliasDef(base, "openai-codex-account-4", 4);

    assert.equal(alias.streamSimple, streamSimple);
    // The base keeps its method: copy semantics, no mutation.
    assert.equal(base.streamSimple, streamSimple);
  });

  it("hidden aliases list no catalog but keep transport, auth and refresh", () => {
    const base = { ...fakeBase(), getAllModels: () => [{ id: "gpt-5.5" }], refreshModels: () => "refresh" };
    const alias = aliasDef(base, "openai-codex-account-2", 2, true);

    assert.deepEqual(alias.getModels(), []);
    assert.deepEqual(alias.getAllModels(), []);
    assert.equal(alias.stream, base.stream);
    assert.equal(alias.auth, base.auth);
    assert.ok(alias.refreshModels instanceof Function);
    assert.equal(base.getModels().length, 1, "hiding never mutates the factory catalog");
  });

  it("builtinBase picks the family and misses unknown ids", () => {
    const mod = fakeModule();

    assert.equal(builtinBase(mod, "anthropic").id, "anthropic");
    assert.equal(builtinBase(mod, "cursor"), null);
    assert.equal(builtinBase(null, "anthropic"), null);
    assert.equal(builtinBase({}, "anthropic"), null);
  });

  it("builtinBase returns fresh instances per call", () => {
    const mod = fakeModule();

    assert.notEqual(builtinBase(mod, "anthropic"), builtinBase(mod, "anthropic"));
  });

  it("registerOwnedAlias passes a full Provider object to the host", () => {
    const calls = [];

    const pi = {
      registerProvider: function (...args) {
        calls.push(args);
      },
    };

    const state = { ownedAliases: new Set() };

    registerOwnedAlias(pi, state, "openai-codex", fakeBase(), "openai-codex-account-3", 3);
    assert.ok(state.ownedAliases.has("openai-codex-account-3"));
    assert.equal(state.nativeAliases.get("openai-codex-account-3").definition, calls[0][0]);
    assert.equal(calls.length, 1);
    // Single-argument call selects the registerProvider(provider) overload —
    // two arguments would take the (name, config) path and drop the clone.
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].id, "openai-codex-account-3");
    assert.deepEqual(calls[0][0].getModels(), [{ id: "gpt-5.5", provider: "openai-codex-account-3" }]);
    assert.doesNotThrow(() => calls[0][0].stream());
  });

  it("the host-bound pi-ai registry returns fresh defs per call", () => {
    const a = builtinBase(nativeBuiltinModule, "openai-codex");
    const b = builtinBase(nativeBuiltinModule, "openai-codex");

    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a, b);
    assert.notEqual(a.auth, b.auth);
  });
});


it("native aliases preserve runtime operations and rekey every model type", () => {
  const chat = { type: "chat", id: "same", provider: "anthropic" };
  const image = { type: "image", id: "same", provider: "anthropic" };
  const streamSimple = () => "native stream";
  const base = { ...fakeBase(), id: "anthropic", getModels: () => [chat], getAllModels: () => [chat, image], streamSimple };
  const calls = [];
  registerOwnedAlias({ registerProvider: (...args) => calls.push(args) }, { ownedAliases: new Set() }, "anthropic", base, "anthropic-account-2", 2);
  assert.equal(calls[0].length, 1, "select native Provider overload, never legacy config");
  const alias = calls[0][0];
  assert.equal(alias.streamSimple, streamSimple);
  assert.equal(alias.auth, base.auth, "delegate login/refresh/resolution, do not copy OAuth");
  assert.deepEqual(alias.getModels(), [{ ...chat, provider: alias.id }]);
  assert.deepEqual(alias.getAllModels(), [{ ...chat, provider: alias.id }, { ...image, provider: alias.id }]);
  assert.equal(chat.provider, "anthropic");
  assert.equal(image.provider, "anthropic");
});

it("scoped catalog refresh restores base-shaped rows but publishes under the account alias", async () => {
  let models = [];

  const base = { ...fakeBase(), getModels: () => models, refreshModels: async ctx => {
    assert.equal(ctx.stored.models[0].provider, "openai-codex");

    await ctx.publish({ persist: { models: [{ id: "future-catalog", provider: "openai-codex" }], checkedAt: 123 }, update: () => { models = [{ id: "future-catalog", provider: "openai-codex" }]; } });
  } };

  const alias = aliasDef(base, "openai-codex-account-2", 2);
  let persisted;

  await alias.refreshModels({ stored: { models: [{ id: "saved-catalog", provider: alias.id }] }, publish: async change => {
    persisted = change.persist;
    change.update();

    return true;
  } });
  assert.equal(persisted.models[0].provider, alias.id);
  assert.deepEqual(alias.getModels(), [{ id: "future-catalog", provider: alias.id }]);
});

it("builtin OpenAI aliases retain ChatGPT wire rules, native priority and serving identity", async () => {
  const base = builtinBase(nativeBuiltinModule, "openai");
  const alias = aliasDef(base, "openai-account-2", 2);
  const model = alias.getModels()[0];
  const context = { messages: [{ role: "user", content: "fixture prompt", timestamp: 0 }] };
  let payload;
  let callbackModel;

  const response = await alias.streamSimple(model, context, {
    apiKey: "fixture-chatgpt-access", sessionId: "fixture-cache", cacheRetention: "long", temperature: 0.2,
    samplingParams: { service_tier: "priority" },
    onPayload: (request, actualModel) => {
      payload = request;
      callbackModel = actualModel;
      throw new Error("fixture stopped before network");
    },
  }).result();

  assert.equal(payload.max_output_tokens, undefined, "ChatGPT subscription rules must apply to numbered aliases");
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.prompt_cache_retention, undefined);
  assert.equal(payload.service_tier, "priority", "native sampling parameters own the tier");
  assert.equal(payload.prompt_cache_key, "fixture-cache");
  assert.equal(callbackModel.provider, alias.id);
  assert.equal(response.provider, alias.id, "persisted history must identify the serving login, not the wire family");
  assert.match(response.errorMessage, /fixture stopped before network/);
  assert.equal(model.provider, alias.id);
  assert.equal(context.messages[0].content, "fixture prompt");
});

it("builtin OpenAI wire replay is identical across aliases without mutating signed history", async () => {
  const base = builtinBase(nativeBuiltinModule, "openai");
  const alias = aliasDef(base, "openai-account-2", 2);
  const stock = base.getModels()[0];
  const model = alias.getModels().find(row => row.id === stock.id);
  const content = [{ type: "text", text: "signed prefix", textSignature: "msg_fixture" }, { type: "toolCall", id: "call_fixture|fc_fixture", name: "fixture", arguments: {} }];
  const assistant = { role: "assistant", api: stock.api, model: stock.id, provider: alias.id, content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 };
  const tool = { role: "toolResult", toolCallId: "call_fixture|fc_fixture", toolName: "fixture", content: [{ type: "text", text: "done" }], isError: false, timestamp: 1 };
  const context = { messages: [assistant, tool] };

  async function capture(provider, actualModel, actualContext) {
    let payload;

    const response = await provider.streamSimple(actualModel, actualContext, {
      apiKey: "sk-fixture", sessionId: "fixture-cache",
      onPayload: request => {
        payload = request;
        throw new Error("fixture stopped before network");
      },
    }).result();

    assert.match(response.errorMessage, /fixture stopped before network/);
    assert.ok(payload, "native payload must be observed, not two undefined values compared");

    return payload;
  }

  const expected = await capture(base, stock, { messages: [{ ...assistant, provider: base.id }, tool] });
  const actual = await capture(alias, model, context);
  assert.deepEqual(actual, expected, "native tool IDs and text signatures must not depend on the account alias");
  assert.equal(actual.input.find(row => row.type === "function_call").id, "fc_fixture");
  assert.equal(assistant.provider, alias.id);
  assert.equal(assistant.content, content);
  assert.equal(content[1].id, "call_fixture|fc_fixture");
});


for (const operation of ["getModels", "getAllModels"]) it(`saved ${operation} catalogs extend one native snapshot without losing new IDs`, () => {
  const current = { id: "current", provider: "fixture", api: "openai-completions", type: "chat" };
  const next = { ...current, id: "next" };
  let observed = false;

  const native = {
    id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid",
    getModels: () => {
      const models = observed ? [next] : [current];
      observed = true;

      return models;
    },
  };

  const builtins = { builtinProviders: () => [native] };
  const state = { savedModelProviders: { "fixture-account-2": { models: [{ id: "next", name: "Saved next" }] } } };
  const catalog = providerBase("fixture", {}, builtins, state)[operation]();

  assert.deepEqual(catalog.map(model => model.id), ["current", "next"]);
  assert.equal(catalog[1].name, "Saved next");
  assert.equal(catalog[1].provider, "fixture");
  assert.equal(catalog[1].baseUrl, native.baseUrl);
});
