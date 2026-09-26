import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { enrichModel, modelsDevNamespace } from "../lib/modelsdev.js";

const CATALOG = {
  anthropic: {
    models: {
      "claude-test": {
        name: "Claude Test",
        reasoning: true,
        modalities: { input: ["text", "image"] },
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
    },
  },
  openai: {
    models: {
      shared: { name: "Shared", reasoning: false, limit: { context: 1000, output: 100 } },
    },
  },
};

describe("models.dev mapping", () => {
  test("resolves entries by namespace, then global id", () => {
    assert.equal(modelsDevNamespace("anthropic"), "anthropic");
    assert.equal(modelsDevNamespace("together"), "togetherai");
    assert.equal(modelsDevNamespace("fireworks"), "fireworks-ai");
    assert.equal(modelsDevNamespace("some-extension-provider"), "some-extension-provider");

    const enriched = enrichModel(CATALOG, "anthropic", "shared", {});

    assert.equal(enriched.name, "Shared");
    assert.equal(enriched.contextWindow, 1000);
    assert.equal(enriched.reasoning, false);
  });

  test("builds enriched records from catalog and live metadata", () => {
    assert.deepEqual(enrichModel(CATALOG, "anthropic", "claude-test", {}), {
      name: "Claude Test",
      contextWindow: 200000,
      maxTokens: 64000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      input: ["text", "image"],
      reasoning: true,
    });

    const pixel = enrichModel(CATALOG, "vercel-ai-gateway", "stealth/pixel-canary", {
      name: "Pixel Canary",
      context_window: 262144,
      max_tokens: 131072,
      pricing: { input: "0", output: "0" },
      modalities: { input: ["text", "image"] },
      tags: ["reasoning", "vision"],
      reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "xhigh"] }],
      no_training: "none",
    });

    assert.deepEqual(pixel, {
      name: "Pixel Canary",
      contextWindow: 262144,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      input: ["text", "image"],
      reasoning: true,
      explicitEfforts: ["none", "low", "medium", "xhigh"],
      trainingRetained: true,
    });
  });

  test("reads vendor-shaped costs and display names", () => {
    const catalog = {
      anthropic: {
        models: {
          s: { name: "S", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
        },
      },
    };

    const enriched = enrichModel(catalog, "anthropic", "s", {});

    assert.deepEqual(enriched.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });

    const anthropic = enrichModel({}, "anthropic", "ax-9", { id: "ax-9", display_name: "Aurora X" });

    assert.equal(anthropic.name, "Aurora X");

    const google = enrichModel({}, "google", "gem-1", { name: "models/gem-1", displayName: "Gem One" });

    assert.equal(google.name, "Gem One");

    const bare = enrichModel({}, "google", "gem-1", { name: "models/gem-1" });

    assert.equal(bare.name, "Gem 1");
  });

  test("unknown models pass through with a derived name and nothing fabricated", () => {
    assert.deepEqual(enrichModel(CATALOG, "mystery", "vendor/thing-1", {}), {
      name: "Thing 1",
      reasoning: false,
    });
    assert.deepEqual(enrichModel(null, "mystery", "bare", null), {
      name: "Bare",
      reasoning: false,
    });
  });

  test("rejects junk instead of writing it", () => {
    const zero = enrichModel(CATALOG, "mystery", "vid", {
      context_window: 0,
      max_tokens: 0,
      modalities: { input: ["text"], output: ["text"] },
    });

    assert.equal(zero.contextWindow, undefined);
    assert.equal(zero.maxTokens, undefined);

    const video = enrichModel(CATALOG, "mystery", "vid", {
      context_window: 1000,
      modalities: { input: ["text"], output: ["video"] },
    });

    assert.equal(video, undefined);

    const unknownStays = enrichModel(CATALOG, "mystery", "vid", { context_window: 1000 });

    assert.equal(unknownStays.contextWindow, 1000);

    const enriched = enrichModel(CATALOG, "mystery", "odd", {
      context_window: "a lot",
      max_tokens: -5,
      pricing: { input: "free", output: null },
      modalities: { input: ["text", "video", "audio"] },
    });

    assert.equal(enriched.contextWindow, undefined);
    assert.equal(enriched.maxTokens, undefined);
    assert.equal(enriched.cost, undefined);
    assert.deepEqual(enriched.input, ["text"]);
  });
});
