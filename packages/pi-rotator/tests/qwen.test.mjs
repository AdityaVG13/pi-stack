import assert from "node:assert/strict";
import { test } from "node:test";
import { customAccountBase } from "../lib/custom.js";
import { aliasDef } from "../lib/clone.js";

test("Qwen and cloud Ollama aliases use host APIs with portable saved catalogs and independent keys", async () => {
  const providers = { qwen: { models: [{ id: "future-qwen", name: "Saved future", reasoning: true, input: ["text"], contextWindow: 300000, maxTokens: 6000, apiKey: "must-not-copy" }] } };
  const base = customAccountBase("qwen", providers);
  assert.equal(base.baseUrl, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
  const alias = aliasDef(base, "qwen-account-2", 2);
  const future = alias.getModels().find(m => m.id === "future-qwen");
  assert.equal(future.provider, "qwen-account-2");
  assert.equal(future.apiKey, undefined);
  assert.equal(future.contextWindow, 300000);
  const resolve = async (provider, key) => (await provider.auth.apiKey.resolve({ credential: { type: "api_key", key }, ctx: { env: async () => undefined }, signal: new AbortController().signal })).auth.apiKey;
  assert.equal(await resolve(alias, "fixture-slot2"), "fixture-slot2");
  assert.equal(await resolve(base, "fixture-base"), "fixture-base");
  assert.equal(await base.auth.apiKey.resolve({ ctx: { env: async name => name === "OPENAI_API_KEY" ? "wrong-family-key" : undefined }, signal: new AbortController().signal }), undefined, "unrelated environment keys must never configure this family");
  const payload = { messages: [{ role: "developer", content: "prefix" }, { role: "user", content: "task" }] };
  const corrected = base.preparePayload(payload);
  assert.equal(corrected.messages[0].role, "system");
  assert.equal(corrected.messages[0].content, "prefix");
  assert.equal(payload.messages[0].role, "developer", "do not mutate the transcript or another provider request");
  const ollama = customAccountBase("ollama", {});
  assert.equal(ollama.baseUrl, "https://ollama.com/v1");
  assert.ok(ollama.getModels().some(m => m.id === "glm-5.2:cloud"));
  assert.equal(customAccountBase("unrelated-package", {}), null);
  assert.equal(customAccountBase("ollama", { ollama: { baseUrl: "http://localhost:11434/v1" } }), null, "never redirect a separately configured local/provider package to the cloud");
});

test("a host without the template API reports unsupported instead of throwing", () => {
  assert.equal(customAccountBase("qwen", {}, { builtinProviders: () => [] }), null);
  assert.equal(customAccountBase("ollama", {}, null), null);
});

test("corrupt saved model shapes never break custom family construction", () => {
  const base = customAccountBase("qwen", { qwen: { models: 42 }, "qwen-account-2": null, "qwen-account-9": { models: [{ id: "  ", name: "ws-marker" }, null, 42, { id: "ok-x", name: "Ok" }] } });
  const models = base.getModels();
  const ids = models.map(m => m.id);
  assert.ok(ids.includes("qwen-max"), "stock catalog survives corrupt saved sections");
  assert.ok(ids.includes("ok-x"), "valid rows survive beside corrupt siblings");
  assert.ok(ids.every(id => id && id.trim()), "no blank ids publish");
  assert.ok(!models.some(m => m.name === "ws-marker"), "whitespace rows register nothing at all");
  assert.ok(customAccountBase("qwen", null).getModels().length > 0);
});

test("Ollama cloud uses the native chat-completions wire path for stock and saved aliases", async () => {
  const base = customAccountBase("ollama", { ollama: { models: [{ id: "saved-cloud-model", name: "saved" }] } });
  const alias = aliasDef(base, "ollama-account-2", 2);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), authorization: new Headers(options.headers).get("authorization") });

    return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  };

  try {
    for (const model of alias.getModels()) {
      const reply = await alias.streamSimple(model, { messages: [{ role: "user", content: "fixture question", timestamp: 0 }] }, { apiKey: "fixture-ollama-key" }).result();
      assert.notEqual(reply.stopReason, "error", reply.errorMessage);
      assert.equal(reply.content.find(part => part.type === "text")?.text, "fixture answer");
    }

    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.url === "https://ollama.com/v1/chat/completions"));
    assert.ok(requests.every(request => request.authorization === "Bearer fixture-ollama-key"));
    assert.deepEqual(requests.map(request => request.body.model).sort(), alias.getModels().map(model => model.id).sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
