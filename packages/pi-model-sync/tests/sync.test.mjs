import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fs from "node:fs";
import { cachePathFor } from "../lib/cache.js";
import { runSync } from "../lib/sync.js";
import { stubFetch, tempDir } from "./helpers.mjs";

// Fake composed registry: one OpenAI-family provider with a key, one
// Anthropic provider without credentials, one extension-style custom id.
function fakeRegistry() {
  const models = [
    { id: "old", provider: "demo-openai", api: "openai-completions" },
    { id: "seed", provider: "demo-anthropic", api: "anthropic-messages" },
    { id: "x/custom", provider: "pi-fictional", api: "openai-completions" },
  ];

  let refreshed = 0;

  return {
    get refreshed() {
      return refreshed;
    },
    getAll: () => models,
    getProvider: (id) =>
      id === "demo-openai"
        ? { id, baseUrl: "https://o.test/v1" }
        : id === "demo-anthropic"
          ? { id, baseUrl: "https://a.test" }
          : { id, baseUrl: "https://x.test/v1" },
    getProviderAuth: async (id) =>
      id === "demo-anthropic" ? undefined : { auth: { apiKey: `${id}-key` } },
    refresh: async () => {
      refreshed += 1;
    },
  };
}

const SYNC_ROUTES = {
  "https://models.dev/api.json": { "demo-openai": { models: {} } },
  "https://o.test/v1/models": { data: [{ id: "fresh", context_window: 8000, max_tokens: 2000 }] },
};

function deps(overrides = {}) {
  const dir = tempDir();

  return {
    registry: fakeRegistry(),
    fetchImpl: stubFetch(SYNC_ROUTES).fetchImpl,
    fs,
    modelsPath: join(dir, "models.json"),
    userAgent: "test-agent",
    ...overrides,
  };
}

describe("sync orchestration", () => {
  test("adds discovered models, skips the logged-out, isolates failures", async () => {
    const context = deps();
    const result = await runSync(context);

    assert.equal(result.ok, true);
    assert.deepEqual(result.totals, { added: 1, updated: 0, removed: 0, synced: 1, skipped: 2 });
    const written = JSON.parse(readFileSync(context.modelsPath, "utf8"));

    assert.equal(written.providers["demo-openai"].models[0].id, "fresh");
    assert.equal(written.providers["demo-openai"].models[0]._managedBy, "pi-model-sync");
    assert.equal(written.providers["demo-anthropic"], undefined);
    assert.equal(context.registry.refreshed, 1);
    assert.match(result.lines.join("\n"), /demo-anthropic: skipped \(not logged in\)/);
    assert.match(result.lines.join("\n"), /pi-fictional: skipped \(list failed \(HTTP 404\)\)/);
  });

  test("dry runs report without writing anything and filters narrow the run", async () => {
    const context = deps({ dryRun: true, filter: "demo-openai" });
    const result = await runSync(context);

    assert.equal(result.ok, true);
    assert.throws(() => readFileSync(context.modelsPath, "utf8"));
    assert.throws(() => readFileSync(cachePathFor(context.modelsPath), "utf8"));
    assert.match(result.lines.join("\n"), /dry run: models\.json untouched/);
    assert.match(result.lines.join("\n"), /demo-openai: \+1/);
    assert.doesNotMatch(result.lines.join("\n"), /demo-anthropic/);

    const unknown = await runSync(deps({ filter: "nope" }));

    assert.equal(unknown.ok, false);
    assert.match(unknown.lines.join("\n"), /unknown provider "nope"/);
  });

  test("training flags list a handful and summarize a crowd", async () => {
    const flagged = (count) => {
      const data = [];

      for (let i = 0; i < count; i += 1) {
        data.push({ id: `m${i}`, no_training: "none" });
      }

      return async (url) => {
        if (String(url) === "https://models.dev/api.json") {
          return new Response("{}", { status: 200 });
        }

        return new Response(JSON.stringify({ data }), { status: 200 });
      };
    };

    const solo = await runSync(deps({ fetchImpl: flagged(1), filter: "demo-openai" }));

    assert.match(solo.lines.join("\n"), /demo-openai\/m0: prompts may be retained/);

    const crowd = await runSync(deps({ fetchImpl: flagged(6), filter: "demo-openai" }));

    assert.match(crowd.lines.join("\n"), /6 models report no zero-retention/);
    assert.doesNotMatch(crowd.lines.join("\n"), /demo-openai\/m0/);
  });

  test("empty live lists never prune and old registries fail friendly", async () => {
    const seeded = deps({ filter: "demo-openai" });
    fs.writeFileSync(
      seeded.modelsPath,
      JSON.stringify({ providers: { "demo-openai": { models: [{ id: "old", _managedBy: "pi-model-sync" }] } } }),
      "utf8",
    );
    seeded.fetchImpl = async (url) => {
      if (String(url) === "https://models.dev/api.json") {
        return new Response("{}", { status: 200 });
      }

      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const kept = await runSync(seeded);

    assert.equal(kept.ok, true);
    assert.match(kept.lines.join("\n"), /\(0 live; kept existing\)/);
    assert.deepEqual(kept.totals, { added: 0, updated: 0, removed: 0, synced: 1, skipped: 0 });

    const ancient = deps({ filter: "demo-openai" });
    delete ancient.registry.getProvider;
    delete ancient.registry.getProviderAuth;

    const friendly = await runSync(ancient);

    assert.equal(friendly.ok, false);
    assert.match(friendly.lines.join("\n"), /update Pi and retry/);
  });

  test("corrupt config and failed writes abort cleanly, missing refresh falls back", async () => {
    const corruptDir = tempDir();
    const corruptPath = join(corruptDir, "models.json");
    fs.writeFileSync(corruptPath, "[1]", "utf8");

    const corrupt = await runSync(deps({ modelsPath: corruptPath, filter: "demo-openai" }));

    assert.equal(corrupt.ok, false);
    assert.match(corrupt.lines.join("\n"), /aborted/);

    const missingDir = tempDir();

    const unwritable = await runSync(
      deps({ modelsPath: join(missingDir, "no-such-dir", "models.json"), filter: "demo-openai" }),
    );

    assert.equal(unwritable.ok, false);
    assert.match(unwritable.lines.join("\n"), /failed to write/);

    const noRefresh = deps({ filter: "demo-openai" });
    delete noRefresh.registry.refresh;

    const fallback = await runSync(noRefresh);

    assert.equal(fallback.ok, true);
    assert.match(fallback.lines.join("\n"), /restart Pi to pick up/);
  });

  test("models.dev catalog is cached across runs, refreshed on demand, live-only on outage", async () => {
    const context = deps({ filter: "demo-openai" });
    const first = await runSync(context);

    assert.match(first.lines.join("\n"), /models\.dev: fetched fresh/);

    let catalogCalls = 0;
    const counting = context.fetchImpl;
    context.fetchImpl = async (url, options) => {
      if (String(url) === "https://models.dev/api.json") {
        catalogCalls += 1;
      }

      return counting(url, options);
    };

    const second = await runSync(context);

    assert.equal(second.ok, true);
    assert.equal(catalogCalls, 0);
    assert.match(second.lines.join("\n"), /models\.dev: cache hit/);

    const forced = await runSync({ ...context, fetchImpl: counting, refresh: true });

    assert.match(forced.lines.join("\n"), /models\.dev: fetched fresh/);

    const failing = async (url) =>
      String(url) === "https://models.dev/api.json"
        ? new Response("down", { status: 500 })
        : stubFetch(SYNC_ROUTES).fetchImpl(url);

    const degraded = await runSync(deps({ fetchImpl: failing, filter: "demo-openai" }));

    assert.equal(degraded.ok, true);
    assert.match(degraded.lines.join("\n"), /models\.dev unreachable/);
    assert.match(degraded.lines.join("\n"), /\+1/);
  });

  test("orphan sweep reaps providers that left and stands down otherwise", async () => {
    const context = deps();
    fs.writeFileSync(
      context.modelsPath,
      JSON.stringify({ providers: { ghost: { models: [{ id: "old", _managedBy: "pi-model-sync" }] } } }),
      "utf8",
    );

    const result = await runSync(context);

    assert.equal(result.ok, true);
    assert.match(result.lines.join("\n"), /ghost: -1 \(orphaned; provider not in registry\)/);
    assert.equal(result.totals.removed, 1);

    const written = JSON.parse(readFileSync(context.modelsPath, "utf8"));

    assert.equal(written.providers.ghost, undefined);
    assert.equal(written.providers["demo-openai"].models[0].id, "fresh");

    const seed = { providers: { ghost: { models: [{ id: "old", _managedBy: "pi-model-sync" }] } } };

    const filtered = deps({ filter: "demo-openai" });
    fs.writeFileSync(filtered.modelsPath, JSON.stringify(seed), "utf8");

    const one = await runSync(filtered);

    assert.doesNotMatch(one.lines.join("\n"), /orphaned/);

    const kept = JSON.parse(readFileSync(filtered.modelsPath, "utf8"));

    assert.equal(kept.providers.ghost.models.length, 1);

    const hollow = fakeRegistry();
    hollow.getAll = () => [];
    hollow.getRegisteredProviderIds = () => ["registered-without-models"];

    const empty = deps({ registry: hollow });
    fs.writeFileSync(empty.modelsPath, JSON.stringify(seed), "utf8");

    const none = await runSync(empty);

    assert.doesNotMatch(none.lines.join("\n"), /orphaned/);

    const stayed = JSON.parse(readFileSync(empty.modelsPath, "utf8"));

    assert.equal(stayed.providers.ghost.models.length, 1);
  });
});


test("persists configured transport defaults without persisting resolved credentials", async () => {
  const context = deps({ filter: "demo-openai" });
  const seed = context.registry.getAll();
  context.registry.getAll = () => [...seed, { id: "existing", provider: "demo-openai", api: "openai-responses", baseUrl: "https://special.test/v1" }];
  context.registry.getProviderAuth = async () => ({ auth: {
    apiKey: "resolved-secret-fixture", baseUrl: "https://resolved.test/v1",
    headers: { "x-private-key": "resolved-secret-fixture" },
  } });
  context.fetchImpl = stubFetch({
    "https://models.dev/api.json": {},
    "https://resolved.test/v1/models": { data: [{ id: "fresh" }, { id: "existing" }] },
  }).fetchImpl;
  const result = await runSync(context);
  assert.equal(result.ok, true);
  const text = readFileSync(context.modelsPath, "utf8");
  const model = JSON.parse(text).providers["demo-openai"].models[0];
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://o.test/v1");
  const written = JSON.parse(text).providers["demo-openai"].models;
  assert.equal(written.find(item => item.id === "existing"), undefined);
  assert.doesNotMatch(text, /resolved-secret-fixture|resolved\.test|x-private-key/);
});

test("does not overlay registry seeds into models.json", async () => {
  const context = deps({ filter: "demo-openai" });
  context.fetchImpl = stubFetch({
    "https://models.dev/api.json": {},
    "https://o.test/v1/models": { data: [{ id: "old" }, { id: "fresh" }] },
  }).fetchImpl;
  const result = await runSync(context);
  assert.equal(result.ok, true);
  const written = JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["demo-openai"].models;
  assert.deepEqual(written.map(model => model.id), ["fresh"]);
  assert.equal(written[0]._managedBy, "pi-model-sync");
});

test("reload errors do not claim a saved catalog is live", async (t) => {
  for (const mode of ["reported", "thrown", "hidden"]) {
    await t.test(mode, async () => {
      const context = deps({ filter: "demo-openai" });
      context.registry.refresh = async () => {
        if (mode === "thrown") throw new Error("private-reload-detail");
      };

      context.registry.getError = () => mode === "reported" ? "private-reload-detail" : undefined;
      context.registry.find = () => mode === "hidden" ? undefined : { id: "fresh" };
      const result = await runSync(context);
      assert.equal(result.ok, false);
      assert.doesNotMatch(result.lines.join("\n"), /catalog live now|private-reload-detail/);
      assert.equal(JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["demo-openai"].models[0].id, "fresh");
    });
  }
});

test("an unchanged retry reactivates a catalog saved before a failed reload", async () => {
  const context = deps({ filter: "demo-openai" });
  let reloadFails = true;
  let visible = false;
  context.registry.refresh = async () => {
    if (reloadFails) throw new Error("reload unavailable");

    visible = true;
  };

  context.registry.find = () => visible ? { id: "fresh" } : undefined;

  const first = await runSync(context);
  assert.equal(first.ok, false);
  const saved = readFileSync(context.modelsPath, "utf8");
  assert.equal(JSON.parse(saved).providers["demo-openai"].models[0].id, "fresh");

  const stillFailing = await runSync(context);
  assert.equal(stillFailing.ok, false);
  assert.equal(visible, false);

  reloadFails = false;
  const retried = await runSync(context);
  assert.equal(retried.ok, true);
  assert.equal(visible, true);
  assert.deepEqual(retried.totals, { added: 0, updated: 0, removed: 0, synced: 1, skipped: 0 });
  assert.equal(readFileSync(context.modelsPath, "utf8"), saved);
  assert.match(retried.lines.join("\n"), /catalog live now/);
});

test("incomplete catalogs cannot prune existing managed models", async (t) => {
  for (const mode of ["anthropic-cap", "google-cap", "broken-cursor", "openai-partial"]) {
    await t.test(mode, async () => {
      const context = deps({ filter: "demo-openai" });
      const api = mode === "google-cap" ? "google-generative-ai" : mode === "openai-partial" ? "openai-completions" : "anthropic-messages";
      context.registry.getAll = () => [{ provider: "demo-openai", id: "seed", api }];
      const original = JSON.stringify({ providers: { "demo-openai": { models: [{ id: "existing", _managedBy: "pi-model-sync" }, { id: "hand" }] } } });
      fs.writeFileSync(context.modelsPath, original);
      let page = 0;
      context.fetchImpl = async (url) => {
        if (String(url) === "https://models.dev/api.json") return new Response("{}");
        page += 1;

        const body = mode === "google-cap"
          ? { models: [{ name: `models/page-${page}` }], nextPageToken: `page-${page}` }
          : { data: mode === "broken-cursor" ? [{ id: "first" }, {}] : [{ id: `page-${page}` }], has_more: true };

        return new Response(JSON.stringify(body));
      };

      const result = await runSync(context);
      assert.equal(result.totals.skipped, 1);
      assert.equal(result.totals.removed, 0);
      assert.equal(readFileSync(context.modelsPath, "utf8"), original);
      assert.equal(context.registry.refreshed, 0);
    });
  }
});

test("a later Anthropic page 404 cannot restart discovery at the bare endpoint and prune", async () => {
  const context = deps({ filter: "demo-openai" });
  context.registry.getAll = () => [{ id: "seed", provider: "demo-openai", api: "anthropic-messages" }];
  context.registry.getProvider = () => ({ baseUrl: "https://a.test" });

  const original = JSON.stringify({ providers: {
    "demo-openai": { models: [{ id: "existing", _managedBy: "pi-model-sync" }] },
  } });

  fs.writeFileSync(context.modelsPath, original);
  context.fetchImpl = stubFetch({
    "https://models.dev/api.json": {},
    "https://a.test/v1/models?limit=1000": { data: [{ id: "first" }], has_more: true },
    "https://a.test/v1/models?limit=1000&after_id=first": 404,
    "https://a.test/models?limit=1000": { data: [{ id: "first" }] },
  }).fetchImpl;

  const result = await runSync(context);
  assert.equal(result.totals.skipped, 1);
  assert.equal(result.totals.removed, 0);
  assert.equal(readFileSync(context.modelsPath, "utf8"), original);
  assert.equal(context.registry.refreshed, 0);
});

test("unknown API probing cannot replace an incomplete catalog with another family's subset", async () => {
  const context = deps({ filter: "demo-openai" });
  context.registry.getAll = () => [{ id: "seed", provider: "demo-openai", api: "custom-chat" }];

  const original = JSON.stringify({ providers: {
    "demo-openai": { models: [{ id: "existing", _managedBy: "pi-model-sync" }] },
  } });

  fs.writeFileSync(context.modelsPath, original);
  context.fetchImpl = stubFetch({
    "https://models.dev/api.json": {},
    "https://o.test/v1/models": { data: [{ id: "first" }], has_more: true },
    "https://o.test/v1/models?limit=1000": { data: [{ id: "first" }], has_more: true },
    "https://o.test/v1/models?limit=1000&after_id=first": 404,
    "https://o.test/v1/api/tags": { models: [{ name: "first" }] },
  }).fetchImpl;

  const result = await runSync(context);
  assert.equal(result.totals.skipped, 1);
  assert.equal(result.totals.synced, 0);
  assert.equal(result.totals.removed, 0);
  assert.equal(readFileSync(context.modelsPath, "utf8"), original);
  assert.equal(context.registry.refreshed, 0);
});

test("preserves file edits and providers registered while discovery is pending", async () => {
  const context = deps();
  const list = context.registry.getAll();
  context.registry.getAll = () => [...list];
  const provider = context.registry.getProvider;
  context.registry.getProvider = id => id === "late-provider" ? { id, baseUrl: "https://late.test/v1" } : provider(id);
  const fetchImpl = context.fetchImpl;
  context.fetchImpl = async (url, init) => {
    if (String(url) === "https://o.test/v1/models") {
      list.push({ id: "late", provider: "late-provider", api: "openai-completions" });
      fs.writeFileSync(context.modelsPath, JSON.stringify({ providers: {
        "demo-openai": { headers: { "X-User": "keep" }, models: [{ id: "manual", contextWindow: 1234 }] },
        "late-provider": { models: [{ id: "late", _managedBy: "pi-model-sync" }] },
      } }));
    }

    return fetchImpl(url, init);
  };

  const result = await runSync(context);
  assert.equal(result.ok, true);
  const written = JSON.parse(readFileSync(context.modelsPath, "utf8"));
  assert.deepEqual(written.providers["demo-openai"].headers, { "X-User": "keep" });
  assert.equal(written.providers["demo-openai"].models.find(m => m.id === "manual").contextWindow, 1234);
  assert.equal(written.providers["late-provider"].models[0].id, "late");
});

test("credential-bearing auth and transport exceptions stay out of reports", async (t) => {
  for (const mode of ["auth", "transport"]) {
    await t.test(mode, async () => {
      const context = deps({ filter: "demo-openai" });
      const fail = () => { throw new Error("request included private-credential-fixture"); };

      if (mode === "auth") context.registry.getProviderAuth = fail;
      else context.fetchImpl = async url => String(url) === "https://models.dev/api.json" ? new Response("{}") : fail();
      const result = await runSync(context);
      assert.equal(result.totals.skipped, 1);
      assert.doesNotMatch(result.lines.join("\n"), /private-credential-fixture/);
    });
  }
});


test("legacy model lists stay owned by their extension and are explicitly skipped", async () => {
  const context = deps({ filter: "demo-openai" });
  context.registry.getRegisteredProviderConfig = () => ({ models: [{ id: "seed" }] });
  context.registry.getProviderAuth = () => { throw new Error("must not resolve credentials for an unsupported list"); };

  const original = JSON.stringify({ providers: { "demo-openai": { models: [{ id: "old", _managedBy: "pi-model-sync" }] } } });
  fs.writeFileSync(context.modelsPath, original);
  const result = await runSync(context);
  assert.equal(result.totals.synced, 0);
  assert.equal(result.totals.skipped, 1);
  assert.match(result.lines.join("\n"), /extension owns.*model list/);
  assert.equal(readFileSync(context.modelsPath, "utf8"), original);
});

test("mixed-API providers are skipped instead of guessing a single api for new models", async () => {
  const context = deps({ filter: "demo-openai" });
  const listed = [];
  context.registry.getAll = () => [
    { id: "old", provider: "demo-openai", api: "openai-completions", baseUrl: "https://o.test/v1" },
    { id: "claude", provider: "demo-openai", api: "anthropic-messages", baseUrl: "https://o.test/v1" },
  ];
  const fetchImpl = context.fetchImpl;
  context.fetchImpl = async (url, init) => {
    if (String(url) !== "https://models.dev/api.json") listed.push(String(url));

    return fetchImpl(url, init);
  };

  const original = JSON.stringify({ providers: { "demo-openai": { models: [{ id: "old", _managedBy: "pi-model-sync" }] } } });
  fs.writeFileSync(context.modelsPath, original);
  const result = await runSync(context);
  assert.equal(result.totals.synced, 0);
  assert.equal(result.totals.skipped, 1);
  assert.equal(result.totals.added, 0);
  assert.match(result.lines.join("\n"), /mixed APIs/);
  assert.deepEqual(listed, []);
  assert.equal(readFileSync(context.modelsPath, "utf8"), original);
});

test("pruning the last managed chat models drops empty provider husks", async () => {
  const context = deps({ filter: "demo-openai" });
  fs.writeFileSync(
    context.modelsPath,
    JSON.stringify({ providers: { "demo-openai": { models: [{ id: "old", _managedBy: "pi-model-sync" }] } } }),
  );
  context.fetchImpl = async (url) => {
    if (String(url) === "https://models.dev/api.json") return new Response("{}");

    return new Response(JSON.stringify({ data: [{ id: "vid", modalities: { output: ["video"] } }] }));
  };

  const result = await runSync(context);

  assert.equal(result.ok, true);
  assert.equal(result.totals.removed, 1);
  assert.equal(JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["demo-openai"], undefined);
});

test("Google embedding-only models never become selectable chat models without enrichment", async () => {
  const context = deps({ filter: "demo-openai" });
  context.registry.getAll = () => [
    { id: "seed", provider: "demo-openai", api: "google-generative-ai", baseUrl: "https://g.test/v1beta" },
  ];
  context.registry.getProvider = () => ({ baseUrl: "https://g.test/v1beta" });
  context.fetchImpl = stubFetch({
    "https://models.dev/api.json": 503,
    "https://g.test/v1beta/models?pageSize=1000": { models: [
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent", "batchEmbedContents"] },
      { name: "models/gemini-chat", supportedGenerationMethods: ["generateContent", "countTokens"] },
      { name: "models/unknown-chat" },
    ] },
  }).fetchImpl;
  fs.writeFileSync(context.modelsPath, JSON.stringify({ providers: {
    "demo-openai": { models: [{ id: "text-embedding-004", _managedBy: "pi-model-sync" }] },
  } }));

  const result = await runSync(context);
  assert.equal(result.ok, true);
  const models = JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["demo-openai"].models;
  assert.deepEqual(models.map(model => model.id), ["gemini-chat", "unknown-chat"]);
  assert.equal(result.totals.added, 2);
  assert.equal(result.totals.removed, 1);
});

test("Google live token limits override enrichment and survive live-only sync", async () => {
  for (const offline of [false, true]) {
    const context = deps({ filter: "demo-openai" });
    context.registry.getAll = () => [
      { id: "seed", provider: "demo-openai", api: "google-generative-ai", baseUrl: "https://g.test/v1beta" },
    ];
    context.registry.getProvider = () => ({ baseUrl: "https://g.test/v1beta" });
    context.fetchImpl = stubFetch({
      "https://models.dev/api.json": offline ? 503 : {
        "demo-openai": { models: { "gemini-chat": { limit: { context: 32768, output: 2048 } } } },
      },
      "https://g.test/v1beta/models?pageSize=1000": { models: [{
        name: "models/gemini-chat",
        supportedGenerationMethods: ["generateContent"],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      }] },
    }).fetchImpl;

    const result = await runSync(context);
    assert.equal(result.ok, true);
    const model = JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["demo-openai"].models[0];
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 65536);
  }
});

test("Vercel per-token pricing is persisted in Pi's per-million units", async () => {
  for (const offline of [false, true]) {
    const context = deps({ filter: "vercel-ai-gateway" });
    context.registry.getAll = () => [{
      id: "seed", provider: "vercel-ai-gateway", api: "anthropic-messages",
      baseUrl: "https://gateway.test",
    }];
    context.registry.getProvider = () => ({ baseUrl: "https://gateway.test" });
    const pricing = { input: "0.000003", output: "0.000015", input_cache_read: "0.0000003" };

    if (offline) pricing.input_cache_write = "0.00000375";

    context.fetchImpl = stubFetch({
      "https://models.dev/api.json": offline ? 503 : {
        "vercel-ai-gateway": { models: { "vendor/fresh": {
          cost: { input: 9, output: 90, cache_read: 1, cache_write: 4 },
        } } },
      },
      "https://gateway.test/v1/models?limit=1000": { data: [{
        id: "vendor/fresh",
        pricing,
      }] },
    }).fetchImpl;

    const result = await runSync(context);
    assert.equal(result.ok, true);
    const model = JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["vercel-ai-gateway"].models[0];
    assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: offline ? 3.75 : 4 });
  }
});

test("registered providers without visible models are not mistaken for orphans", async () => {
  const context = deps();
  context.registry.getRegisteredProviderIds = () => ["fixed-list"];
  const model = { id: "not-visible", _managedBy: "pi-model-sync" };
  fs.writeFileSync(context.modelsPath, JSON.stringify({ providers: { "fixed-list": { models: [model] } } }));
  const result = await runSync(context);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(context.modelsPath, "utf8")).providers["fixed-list"].models, [model]);
});

test("rotator-hidden slot aliases sweep their tagged static leftovers", async () => {
  const context = deps();
  context.registry.getAll = () => [{ id: "seed", provider: "demo-openai", api: "openai-completions" }];
  context.registry.getRegisteredProviderIds = () => ["demo-openai", "demo-openai-account-2", "demo-openai-account-3"];
  const tagged = { id: "stale-slot-model", _managedBy: "pi-model-sync" };
  const owned = { id: "user-slot-model" };
  fs.writeFileSync(context.modelsPath, JSON.stringify({ providers: {
    "demo-openai-account-2": { models: [tagged, owned] },
    "demo-openai-account-3": { baseUrl: "https://custom.invalid/v1", models: [tagged] },
  } }));
  const result = await runSync(context);
  assert.equal(result.ok, true);
  const providers = JSON.parse(readFileSync(context.modelsPath, "utf8")).providers;
  assert.deepEqual(providers["demo-openai-account-2"].models, [owned], "tagged leftovers sweep; user entries stay");
  assert.deepEqual(providers["demo-openai-account-3"].models, [], "custom sections keep their shape with no models");
  assert.match(result.lines.join("\n"), /demo-openai-account-2: -1 \(orphaned; provider not in registry\)/);
});

test("semantic pagination failures cannot authorize pruning through another API probe", async (t) => {
  for (const mode of ["shape", "cursor", "cap"]) {
    await t.test(mode, async () => {
      const context = deps({ filter: "demo-openai" });
      context.registry.getAll = () => [{ id: "seed", provider: "demo-openai", api: "custom-chat" }];

      const original = JSON.stringify({ providers: {
        "demo-openai": { models: [{ id: "existing", _managedBy: "pi-model-sync" }] },
      } });

      fs.writeFileSync(context.modelsPath, original);
      context.fetchImpl = async (url) => {
        if (String(url) === "https://models.dev/api.json") return new Response("{}");

        if (String(url).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "first" }] }));
        }

        const later = String(url).includes("after_id=");

        const body = later && mode === "shape" ? { data: "invalid" }
          : later && mode === "cursor" ? { data: [{ id: "next" }, {}], has_more: true }
            : { data: [{ id: "first" }], has_more: true };

        return new Response(JSON.stringify(body));
      };

      const result = await runSync(context);
      assert.equal(result.totals.removed, 0);
      assert.equal(result.totals.skipped, 1);
      assert.equal(result.totals.synced, 0);
      assert.equal(readFileSync(context.modelsPath, "utf8"), original);
      assert.equal(context.registry.refreshed, 0);
    });
  }
});

test("later-page transport failures cannot authorize pruning through another API probe", async (t) => {
  for (const mode of ["fetch", "body"]) {
    await t.test(mode, async () => {
      const context = deps({ filter: "demo-openai" });
      context.registry.getAll = () => [{
        id: "old", provider: "demo-openai", api: "custom-conversations", baseUrl: "https://o.test/v1",
      }];

      const original = JSON.stringify({ providers: {
        "demo-openai": { models: [{ id: "old", _managedBy: "pi-model-sync" }] },
      } });

      fs.writeFileSync(context.modelsPath, original);

      const routes = stubFetch({
        "https://models.dev/api.json": {},
        "https://o.test/v1/models": { data: [{ id: "fresh" }], has_more: true },
        "https://o.test/v1/models?limit=1000": { data: [{ id: "fresh" }], has_more: true },
        "https://o.test/v1/api/tags": { models: [{ name: "fresh" }] },
      });

      context.fetchImpl = async (url, init) => {
        if (String(url).includes("after_id=")) {
          const fail = () => { throw new Error("connection reset with private-credential-fixture"); };

          if (mode === "fetch") return fail();

          return { ok: true, text: async () => fail() };
        }

        return routes.fetchImpl(url, init);
      };

      const result = await runSync(context);
      assert.equal(result.totals.removed, 0);
      assert.equal(result.totals.skipped, 1);
      assert.equal(result.totals.synced, 0);
      assert.equal(readFileSync(context.modelsPath, "utf8"), original);
      assert.doesNotMatch(result.lines.join("\n"), /private-credential-fixture/);
    });
  }
});
