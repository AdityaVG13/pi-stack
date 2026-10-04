import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { cachePathFor, loadCatalog, MODELS_DEV_TTL_MS } from "../lib/cache.js";
import { jsonResponse, tempDir } from "./helpers.mjs";

const NOW = 1_786_000_000_000;

function seed(path, fetchedAt, catalog = { seeded: true }) {
  fs.writeFileSync(path, JSON.stringify({ version: 1, fetchedAt, catalog }), "utf8");
}

function setup() {
  const dir = tempDir("modelsync-cache-");

  return { dir, cachePath: join(dir, "pi-model-sync-models-dev.json") };
}

async function runLoad(cachePath, fetchImpl, options = {}) {
  return loadCatalog({ fetchImpl, userAgent: "test-agent", cachePath, fs, now: () => NOW, ...options });
}

function countingFetch(body) {
  let calls = 0;

  const fetchImpl = async () => {
    calls += 1;

    return jsonResponse(body);
  };

  return { fetchImpl, called: () => calls };
}

describe("models.dev cache", () => {
  test("misses fetch fresh and persist the cache", async () => {
    const { cachePath } = setup();
    const fetch = countingFetch({ fresh: true });

    const loaded = await runLoad(cachePath, fetch.fetchImpl);

    assert.equal(loaded.status, "fresh");
    assert.deepEqual(loaded.catalog, { fresh: true });
    assert.match(loaded.note, /fetched fresh/);
    assert.equal(fetch.called(), 1);

    const stored = JSON.parse(fs.readFileSync(cachePath, "utf8"));

    assert.equal(stored.version, 1);
    assert.equal(stored.fetchedAt, NOW);
    assert.deepEqual(stored.catalog, { fresh: true });

    for (const fetchedAt of [NOW - MODELS_DEV_TTL_MS - 1, NOW + 1000]) {
      const retry = setup();
      seed(retry.cachePath, fetchedAt, { old: true });

      const refetched = await runLoad(retry.cachePath, async () => jsonResponse({ next: true }));

      assert.equal(refetched.status, "fresh");
      assert.deepEqual(refetched.catalog, { next: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(retry.cachePath, "utf8")).catalog, { next: true });
    }
  });

  test("hits answer without network; refresh forces refetch", async () => {
    const { cachePath } = setup();
    seed(cachePath, NOW);

    const loaded = await runLoad(cachePath, async () => {
      throw new Error("must not fetch");
    });

    assert.equal(loaded.status, "cache");
    assert.deepEqual(loaded.catalog, { seeded: true });
    assert.match(loaded.note, /cache hit/);

    const fetch = countingFetch({ next: true });
    const forced = await runLoad(cachePath, fetch.fetchImpl, { refresh: true });

    assert.equal(forced.status, "fresh");
    assert.deepEqual(forced.catalog, { next: true });
    assert.equal(fetch.called(), 1);
  });

  test("outage falls back to stale cache, offline only with nothing cached", async () => {
    const failing = async () => {
      throw new Error("down");
    };

    const stale = setup();
    seed(stale.cachePath, NOW - MODELS_DEV_TTL_MS - 1, { old: true });

    const fallback = await runLoad(stale.cachePath, failing);

    assert.equal(fallback.status, "stale");
    assert.deepEqual(fallback.catalog, { old: true });
    assert.match(fallback.note, /stale cache/);

    const empty = setup();

    const offline = await runLoad(empty.cachePath, failing);

    assert.equal(offline.status, "offline");
    assert.equal(offline.catalog, null);
    assert.match(offline.note, /live metadata only/);
  });

  test("invalid caches are a miss, not a crash", async () => {
    const { cachePath } = setup();
    fs.writeFileSync(cachePath, "[[oops", "utf8");

    const versioned = setup();
    fs.writeFileSync(versioned.cachePath, JSON.stringify({ version: 999, catalog: {} }), "utf8");

    const stamped = setup();
    fs.writeFileSync(stamped.cachePath, JSON.stringify({ version: 1, fetchedAt: "1785999999000", catalog: {} }), "utf8");

    for (const path of [cachePath, versioned.cachePath, stamped.cachePath]) {
      const fetch = countingFetch({ next: true });
      const loaded = await runLoad(path, fetch.fetchImpl);

      assert.equal(loaded.status, "fresh");
      assert.deepEqual(loaded.catalog, { next: true });
      assert.equal(fetch.called(), 1);
    }
  });

  test("dry runs read hits but never write", async () => {
    const miss = setup();

    const fetched = await runLoad(miss.cachePath, async () => jsonResponse({ next: true }), { dryRun: true });

    assert.equal(fetched.status, "fresh");
    assert.throws(() => fs.readFileSync(miss.cachePath, "utf8"));

    const hit = setup();
    seed(hit.cachePath, NOW);

    const read = await runLoad(
      hit.cachePath,
      async () => {
        throw new Error("must not fetch");
      },
      { dryRun: true },
    );

    assert.equal(read.status, "cache");
  });

  test("cache path sits next to models.json", () => {
    const modelsPath = join("some", "dir", "models.json");
    const cachePath = cachePathFor(modelsPath);

    assert.equal(dirname(cachePath), join("some", "dir"));
    assert.equal(basename(cachePath), "pi-model-sync-models-dev.json");
  });
});
