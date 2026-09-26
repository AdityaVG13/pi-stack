/**
 * pi-model-sync models.dev cache.
 *
 * The 5MB catalog is fetched at most once per TTL; repeat runs read disk.
 * Cache reads never fail a run: corrupt or missing caches are misses, and
 * a failed fetch falls back to any cached copy (fresh or stale) before
 * giving up to live-only mode. Persistence is best-effort by design.
 */

import { dirname, join } from "node:path";
import { isFunction, isNumber, isObject } from "./decode.js";
import { fetchModelsDevCatalog } from "./modelsdev.js";

export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;

export const MODELS_DEV_CACHE_FILE = "pi-model-sync-models-dev.json";

export function cachePathFor(modelsPath) {
  return join(dirname(modelsPath), MODELS_DEV_CACHE_FILE);
}

function readCache(cachePath, fs) {
  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return undefined;
  }

  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.catalog) || !isNumber(parsed.fetchedAt)) {
    return undefined;
  }

  return parsed;
}

function ageLabel(ageMs) {
  const minutes = Math.floor(ageMs / 60000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m old`;
  }

  return `${Math.floor(minutes / 60)}h old`;
}

function isFresh(fetchedAt, clock) {
  const age = clock() - fetchedAt;

  return age >= 0 && age < MODELS_DEV_TTL_MS;
}

// Resolve the catalog: fresh cache hit, network fetch, stale fallback, or
// offline. Returns {catalog|null, status, note}. status is one of "fresh",
// "cache", "stale", "offline". now defaults to Date.now (injectable).
export async function loadCatalog({ fetchImpl, userAgent, cachePath, fs, refresh, dryRun, now }) {
  const clock = isFunction(now) ? now : Date.now;
  const cached = readCache(cachePath, fs);

  if (refresh !== true && cached !== undefined && isFresh(cached.fetchedAt, clock)) {
    return {
      catalog: cached.catalog,
      status: "cache",
      note: `models.dev: cache hit (${ageLabel(clock() - cached.fetchedAt)})`,
    };
  }

  try {
    const catalog = await fetchModelsDevCatalog(fetchImpl, userAgent);

    if (dryRun !== true) {
      try {
        fs.writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: clock(), catalog }), "utf8");
      } catch {
        // Best-effort: a broken cache must never fail the sync.
      }
    }

    return { catalog, status: "fresh", note: "models.dev: fetched fresh" };
  } catch {
    if (cached !== undefined) {
      return {
        catalog: cached.catalog,
        status: "stale",
        note: `models.dev unreachable; stale cache (${ageLabel(clock() - cached.fetchedAt)})`,
      };
    }

    return { catalog: null, status: "offline", note: "models.dev unreachable; using live metadata only" };
  }
}
