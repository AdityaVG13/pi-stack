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

    const empty = deps({ registry: hollow });
    fs.writeFileSync(empty.modelsPath, JSON.stringify(seed), "utf8");

    const none = await runSync(empty);

    assert.doesNotMatch(none.lines.join("\n"), /orphaned/);

    const stayed = JSON.parse(readFileSync(empty.modelsPath, "utf8"));

    assert.equal(stayed.providers.ghost.models.length, 1);
  });
});
