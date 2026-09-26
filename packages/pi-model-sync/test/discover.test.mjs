import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { discoveryFamily, listModels } from "../lib/discover.js";
import { stubFetch } from "./helpers.mjs";

const UA = "test-agent/1.0";

const KEY_A = "demo-key-a";

const KEY_OAUTH = "sk-ant-oat-demo";

function bearer(key) {
  return ["Bearer", key].join(" ");
}

describe("live discovery", () => {
  test("maps apis to families and normalizes list URLs", () => {
    assert.equal(discoveryFamily("openai-completions"), "openai");
    assert.equal(discoveryFamily("openai-responses"), "openai");
    assert.equal(discoveryFamily("anthropic-messages"), "anthropic");
    assert.equal(discoveryFamily("google-generative-ai"), "google");
    assert.equal(discoveryFamily("ollama"), "ollama");
    assert.equal(discoveryFamily("mistral-conversations"), "unknown");
    assert.equal(discoveryFamily(undefined), "unknown");
  });

  test("lists OpenAI catalogs with auth, versions, and bare-URL retry", async () => {
    const { fetchImpl, seen } = stubFetch({
      "https://x.test/v1/models": { data: [{ id: "a" }, { id: "b", name: "Bee" }, { nope: true }] },
    });

    const models = await listModels("https://x.test/v1/", { apiKey: KEY_A }, "openai", fetchImpl, UA);

    assert.deepEqual(models.map((m) => m.id), ["a", "b"]);
    assert.equal(models[1].meta.name, "Bee");
    assert.equal(seen[0].headers.Authorization, bearer(KEY_A));
    assert.equal(seen[0].headers["User-Agent"], UA);

    const versioned = stubFetch({ "https://o.test/v1/models": { data: [{ id: "a" }] } });
    await listModels("https://o.test/v1/", { apiKey: KEY_A }, "openai", versioned.fetchImpl, UA);
    assert.equal(versioned.seen[0].url, "https://o.test/v1/models");

    const bare = stubFetch({ "https://gw.test/v1/models": { data: [{ id: "b" }] } });
    await listModels("https://gw.test", { apiKey: KEY_A }, "openai", bare.fetchImpl, UA);
    assert.equal(bare.seen[0].url, "https://gw.test/v1/models");

    const pinned = stubFetch({ "https://z.test/api/paas/v4/models": { data: [{ id: "a" }] } });
    await listModels("https://z.test/api/paas/v4", { apiKey: KEY_A }, "openai", pinned.fetchImpl, UA);
    assert.equal(pinned.seen[0].url, "https://z.test/api/paas/v4/models");

    const fallback = stubFetch({ "https://c.test/models": { data: [{ id: "b" }] } });
    const retried = await listModels("https://c.test", { apiKey: KEY_A }, "openai", fallback.fetchImpl, UA);
    assert.deepEqual(retried.map((m) => m.id), ["b"]);
    assert.deepEqual(fallback.seen.map((s) => s.url), ["https://c.test/v1/models", "https://c.test/models"]);

    const denied = stubFetch({ "https://d.test/v1/models": 401 });
    await assert.rejects(listModels("https://d.test", { apiKey: KEY_A }, "openai", denied.fetchImpl, UA), /HTTP 401/);
    assert.equal(denied.seen.length, 1);
  });

  test("covers the Anthropic path: auth shaping, routers, and cursors", async () => {
    const routes = { "https://a.test/v1/models?limit=1000": { data: [{ id: "c" }] } };
    const keyed = stubFetch(routes);
    await listModels("https://a.test", { apiKey: "sk-ant-key" }, "anthropic", keyed.fetchImpl, UA);
    assert.equal(keyed.seen[0].headers["x-api-key"], "sk-ant-key");
    assert.equal(keyed.seen[0].headers["anthropic-version"], "2023-06-01");

    const authed = stubFetch(routes);
    await listModels("https://a.test", { apiKey: KEY_OAUTH }, "anthropic", authed.fetchImpl, UA);
    assert.equal(authed.seen[0].headers.Authorization, bearer(KEY_OAUTH));
    assert.equal(authed.seen[0].headers["x-api-key"], undefined);

    const router = stubFetch({ "https://r.test/v1/models?limit=1000": { data: [{ id: "a" }] } });
    await listModels("https://r.test", { apiKey: "router-key" }, "anthropic", router.fetchImpl, UA);
    assert.equal(router.seen[0].headers["x-api-key"], "router-key");
    assert.equal(router.seen[0].headers.Authorization, bearer("router-key"));
    assert.equal(router.seen[0].headers["User-Agent"], UA);

    const paged = stubFetch({
      "https://a.test/v1/models?limit=1000": { data: [{ id: "c1" }], has_more: true },
      "https://a.test/v1/models?limit=1000&after_id=c1": { data: [{ id: "c2" }], has_more: false },
    });

    const models = await listModels("https://a.test", { apiKey: "sk-ant-key" }, "anthropic", paged.fetchImpl, UA);

    assert.deepEqual(models.map((m) => m.id), ["c1", "c2"]);
    assert.deepEqual(paged.seen.map((s) => s.url), [
      "https://a.test/v1/models?limit=1000",
      "https://a.test/v1/models?limit=1000&after_id=c1",
    ]);

    let calls = 0;

    const looping = async () => {
      calls += 1;

      return new Response(JSON.stringify({ data: [{ id: "x" }], has_more: true }), { status: 200 });
    };

    const capped = await listModels("https://a.test", { apiKey: "sk-ant-key" }, "anthropic", looping, UA);

    assert.equal(calls, 100);
    assert.equal(capped.length, 100);
  });

  test("lists Google models across pages with the key header", async () => {
    const { fetchImpl, seen } = stubFetch({
      "https://g.test/v1beta/models?pageSize=1000": { models: [{ name: "models/gem-1", displayName: "Gem" }] },
    });

    const models = await listModels("https://g.test/v1beta", { apiKey: KEY_A }, "google", fetchImpl, UA);

    assert.deepEqual(models.map((m) => m.id), ["gem-1"]);
    assert.equal(seen[0].headers["x-goog-api-key"], KEY_A);
    assert.equal(seen[0].headers["User-Agent"], UA);

    const paged = stubFetch({
      "https://g.test/v1beta/models?pageSize=1000": { models: [{ name: "models/g1" }], nextPageToken: "t1" },
      "https://g.test/v1beta/models?pageSize=1000&pageToken=t1": { models: [{ name: "models/g2" }] },
    });

    const walked = await listModels("https://g.test/v1beta", { apiKey: KEY_A }, "google", paged.fetchImpl, UA);

    assert.deepEqual(walked.map((m) => m.id), ["g1", "g2"]);
    assert.equal(paged.seen.length, 2);
  });

  test("lists Ollama tags by name, sending the key when configured", async () => {
    const open = stubFetch({
      "http://localhost:11434/api/tags": { models: [{ name: "llama3.2:latest" }, { nope: true }] },
    });

    const models = await listModels("http://localhost:11434", {}, "ollama", open.fetchImpl, UA);

    assert.deepEqual(models.map((m) => m.id), ["llama3.2:latest"]);
    assert.equal(open.seen[0].headers["User-Agent"], UA);
    assert.equal(open.seen[0].headers.Authorization, undefined);

    const keyed = stubFetch({
      "http://x.test/api/tags": { models: [{ name: "r1:latest" }] },
    });

    const remote = await listModels("http://x.test", { apiKey: "ollama-key" }, "ollama", keyed.fetchImpl, UA);

    assert.deepEqual(remote.map((m) => m.id), ["r1:latest"]);
    assert.equal(keyed.seen[0].headers.Authorization, bearer("ollama-key"));
  });

  test("unknown families fall through shapes and report skips without bodies", async () => {
    const { fetchImpl } = stubFetch({});
    await assert.rejects(listModels("https://x.test/v1", { apiKey: KEY_A }, "unknown", fetchImpl, UA), /HTTP 404/);
    await assert.rejects(listModels("https://x.test/v1", {}, "toString", fetchImpl, UA), /unsupported API family/);

    const bad = stubFetch({ "https://x.test/v1/models": { data: "nope" } });
    await assert.rejects(listModels("https://x.test/v1", {}, "openai", bad.fetchImpl, UA), /unexpected list shape/);
    await assert.rejects(listModels("", {}, "openai", bad.fetchImpl, UA), /no base URL/);

    const html = stubFetch({ "https://h.test/v1/models": { raw: "<html>nope</html>" } });
    await assert.rejects(listModels("https://h.test", {}, "openai", html.fetchImpl, UA), /invalid JSON/);
  });
});
