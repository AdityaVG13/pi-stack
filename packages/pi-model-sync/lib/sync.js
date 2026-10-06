/**
 * pi-model-sync orchestration.
 *
 * One provider at a time for merging, all providers at once for discovery:
 * live listing is I/O-bound and fully isolated per provider, so discoveries
 * run concurrently while the models.json merge stays sequential and
 * deterministic. A dead token, a missing list endpoint, or a failed
 * enrichment fetch degrades that provider to a skip-with-reason and never
 * aborts the run. Writes go through store.js, which only touches tagged
 * entries and only prunes on successful non-empty discovery.
 */

import { cachePathFor, loadCatalog } from "./cache.js";
import { defined, isFunction, isNonEmptyString, isObject, isString } from "./decode.js";
import { DiscoveryError, discoveryFamily, listModels } from "./discover.js";
import { enrichModel } from "./modelsdev.js";
import { planOrphanSweep, planProviderUpdate, readModelsFile, writeModelsFile } from "./store.js";
import { buildThinking } from "./thinking.js";

const SLOT_SUFFIX = /-account-\d+$/;

function isSlotAliasId(id) {
  return SLOT_SUFFIX.test(id);
}

function providerIdsOf(models) {
  const ids = [];

  for (const model of models) {
    if (isObject(model) && isString(model.provider) && !ids.includes(model.provider)) {
      ids.push(model.provider);
    }
  }

  ids.sort();

  return ids;
}

function firstApiOf(models, providerId) {
  const found = models.find((model) => isObject(model) && model.provider === providerId && isString(model.api));

  return found?.api;
}

function isLocalBaseUrl(baseUrl) {
  if (!isString(baseUrl)) {
    return false;
  }

  let hostname = "";

  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// Resolved request auth with a uniform shape: missing or malformed auth
// reads as empty rather than throwing through optional chains.
function requestAuth(auth) {
  return isObject(auth?.auth) ? auth.auth : {};
}

function hasHeaderCredential(headers) {
  return isObject(headers) && Object.keys(headers).length > 0;
}

function hasUsableCredential(auth, baseUrl) {
  const { apiKey, headers } = requestAuth(auth);

  return (
    isNonEmptyString(apiKey) ||
    hasHeaderCredential(headers) ||
    isLocalBaseUrl(baseUrl ?? requestAuth(auth).baseUrl)
  );
}

function buildEntry(live, enriched, target) {
  const thinking = buildThinking(enriched.reasoning, enriched.explicitEfforts ?? null);

  const known = target.models.get(live.id);

  const entry = defined({
    id: live.id,
    api: known?.api ?? target.api,
    baseUrl: isNonEmptyString(known?.baseUrl) ? known.baseUrl : target.modelBaseUrl,
    name: enriched.name,
    reasoning: thinking.reasoning,
    input: enriched.input,
    contextWindow: enriched.contextWindow,
    maxTokens: enriched.maxTokens,
    cost: enriched.cost,
    thinkingLevelMap: thinking.thinkingLevelMap,
  });

  return { entry, trainingRetained: enriched.trainingRetained === true };
}

function skipped(providerId, reason) {
  return { providerId, skipped: reason, entries: [], liveCount: 0, dropped: 0, trainingNotes: [], residentIds: [] };
}

// Private control flow: provider-level skips unwind to discoverProvider.
// Only Skip and locally generated DiscoveryError messages reach reports;
// raw provider exceptions can carry credentials.
class Skip extends Error {}

// Resolve where and how to list one provider. Throws Skip with the exact
// skip reason when the provider cannot be listed.
async function listingTarget(deps, providerId, models) {
  const provider = deps.registry.getProvider(providerId);

  if (provider === undefined) {
    throw new Skip("unknown to registry");
  }

  const registration = isFunction(deps.registry.getRegisteredProviderConfig)
    ? deps.registry.getRegisteredProviderConfig(providerId) : undefined;

  if (Array.isArray(registration?.models)) {
    throw new Skip("extension owns an explicit model list; models.json cannot extend it");
  }

  let auth;

  try {
    auth = await deps.registry.getProviderAuth(providerId);
  } catch {
    throw new Skip("auth resolution failed");
  }

  return listingTransport(provider, auth, providerId, models);
}

function listingTransport(provider, auth, providerId, models) {
  const api = firstApiOf(models, providerId);
  const knownModels = models.filter(model => isObject(model) && model.provider === providerId);
  const families = [];

  for (const model of knownModels) {
    if (!isNonEmptyString(model.api)) {
      continue;
    }

    const family = discoveryFamily(model.api);

    if (!families.includes(family)) {
      families.push(family);
    }
  }

  // Copilot/Fireworks mix Anthropic and OpenAI wire APIs. Stamping firstApiOf
  // on a new id makes Pi send the wrong request shape.
  if (families.length > 1) {
    throw new Skip("provider models use mixed APIs; models.json cannot assign a single api");
  }

  const reference = knownModels.find(model => model.api === api);
  // Persist configured transport defaults, never the resolved credential-bearing request URL.
  const modelBaseUrl = isNonEmptyString(reference?.baseUrl) ? reference.baseUrl : provider.baseUrl;
  const { apiKey, headers, baseUrl: authBaseUrl } = requestAuth(auth);
  const baseUrl = authBaseUrl ?? provider.baseUrl ?? modelBaseUrl;

  if (!isNonEmptyString(baseUrl)) {
    throw new Skip("no base URL to list");
  }

  if (!hasUsableCredential(auth, baseUrl)) {
    throw new Skip("not logged in");
  }

  if (!isNonEmptyString(api) || !isNonEmptyString(modelBaseUrl)) {
    throw new Skip("no configured model transport defaults");
  }

  return {
    baseUrl, apiKey, headers, family: discoveryFamily(api), api, modelBaseUrl,
    models: new Map(knownModels.map(model => [model.id, model])),
  };
}

function buildEntries(catalog, providerId, live, target) {
  const entries = [];
  const trainingNotes = [];
  let dropped = 0;

  for (const item of live) {
    const enriched = enrichModel(catalog, providerId, item.id, item.meta);

    if (enriched === undefined) {
      dropped += 1;

      continue;
    }

    const built = buildEntry(item, enriched, target);

    entries.push(built.entry);

    if (built.trainingRetained) {
      trainingNotes.push(`  ! ${providerId}/${item.id}: prompts may be retained for training`);
    }
  }

  return { providerId, skipped: undefined, entries, liveCount: live.length, dropped, trainingNotes, residentIds: [...target.models.keys()] };
}

// Discovery phase: network only, no merging, safe to run concurrently.
// Resolves per provider to entries or a skip reason; never rejects.
async function discoverProvider(deps, catalog, providerId, models) {
  try {
    const target = await listingTarget(deps, providerId, models);

    const live = await listModels(
      target.baseUrl,
      { apiKey: target.apiKey, headers: target.headers },
      target.family,
      deps.fetchImpl,
      deps.userAgent,
    );

    return buildEntries(catalog, providerId, live, target);
  } catch (error) {
    return skipped(providerId, error instanceof Skip || error instanceof DiscoveryError ? error.message : "provider lookup failed");
  }
}

// Resolve the run scope: which registry providers to sync. Returns
// {ids, allModels}, or {abort} with report lines when the run cannot start.
function planRun(deps) {
  let models;

  try {
    models = deps.registry.getAll();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { abort: [`model-sync: cannot read provider catalog (${reason})`] };
  }

  if (!isFunction(deps.registry.getProvider) || !isFunction(deps.registry.getProviderAuth)) {
    return { abort: ["model-sync: this Pi version exposes no provider registry; update Pi and retry."] };
  }

  const allModels = Array.isArray(models) ? models : [];
  const ids = providerIdsOf(allModels);

  if (isNonEmptyString(deps.filter)) {
    if (!ids.includes(deps.filter)) {
      return { abort: [`model-sync: unknown provider "${deps.filter}"`, `known: ${ids.join(", ") || "(none)"}`] };
    }

    return { ids: [deps.filter], allModels };
  }

  return { ids, allModels };
}

// Merge one provider result per line, accumulating totals and training
// notes. An empty live list is trusted for additions (there are none) but
// never for pruning: a transient empty response must not wipe a catalog.
function mergeDiscovered(doc, discovered, lines, totals, trainingNotes) {
  for (const result of discovered) {
    if (result.skipped !== undefined) {
      lines.push(`  ${result.providerId}: skipped (${result.skipped})`);
      totals.skipped += 1;

      continue;
    }

    const plan = planProviderUpdate(doc, result.providerId, result.entries, result.liveCount > 0, result.residentIds);
    doc = plan.next;
    totals.synced += 1;
    totals.added += plan.added;
    totals.updated += plan.updated;
    totals.removed += plan.removed;

    const droppedNote = result.dropped > 0 ? `, ${result.dropped} dropped non-text` : "";
    const emptyNote = result.liveCount === 0 ? "; kept existing" : "";

    lines.push(
      `  ${result.providerId}: +${plan.added} ~${plan.updated} -${plan.removed} =${plan.kept} ` +
        `(${result.liveCount} live${droppedNote}${emptyNote})`,
    );

    for (const note of result.trainingNotes) {
      trainingNotes.push(note);
    }
  }

  return doc;
}

// Orphan sweep last: providers that left the registry (uninstalled
// extensions) can never sync again, and Pi composition-errors on their
// stale managed sections every startup. Filtered runs touch only the
// filter; an empty registry proves nothing and sweeps nothing.
function sweepOrphans(doc, registry, filter, lines, totals) {
  if (isNonEmptyString(filter)) {
    return doc;
  }

  let ids;

  try {
    ids = providerIdsOf(registry.getAll());

    if (ids.length === 0) return doc;

    if (isFunction(registry.getRegisteredProviderIds)) {
      for (const id of registry.getRegisteredProviderIds()) {
        // Rotator hides owned slot catalogs under the family carrier, so a
        // registered sibling that lists nothing is unified, not missing:
        // its tagged static leftovers are stale by definition and sweepable.
        // Listed siblings (other balancers, adopted endpoints) stay known
        // through getAll above, as do model-less base providers.
        if (isString(id) && !ids.includes(id) && !isSlotAliasId(id)) ids.push(id);
      }
    }
  } catch {
    return doc;
  }

  const sweep = planOrphanSweep(doc, ids);

  for (const { providerId, removed } of sweep.swept) {
    lines.push(`  ${providerId}: -${removed} (orphaned; provider not in registry)`);
    totals.removed += removed;
  }

  return sweep.next;
}

// Training flags are per-model signal but provider-scale noise: list a
// handful, summarize a crowd.
function reportTraining(trainingNotes, lines) {
  if (trainingNotes.length > 5) {
    lines.push(`  ! ${trainingNotes.length} models report no zero-retention (prompts may train)`);

    return;
  }

  for (const note of trainingNotes) {
    lines.push(note);
  }
}

function discoveredModelsVisible(registry, discovered) {
  if (!isFunction(registry.find)) return true;

  for (const result of discovered) {
    for (const entry of result.entries) {
      if (!registry.find(result.providerId, entry.id)) return false;
    }
  }

  return true;
}

async function announceRefresh(deps, discovered, lines) {
  if (isFunction(deps.registry.refresh)) {
    try {
      await deps.registry.refresh({ allowNetwork: false });

      if (isFunction(deps.registry.getError) && deps.registry.getError()) {
        lines.push("models.json saved, but Pi reports catalog errors; check the model configuration");

        return false;
      }

      if (!discoveredModelsVisible(deps.registry, discovered)) {
        lines.push("models.json saved, but Pi did not expose every discovered model; check provider model ownership");

        return false;
      }

      lines.push("catalog live now; no restart needed");

      return true;
    } catch {
      lines.push("models.json saved, but Pi could not reload the catalog; check the configuration and retry");

      return false;
    }
  }

  lines.push("restart Pi to pick up the new catalog");

  return true;
}

async function finishRun(deps, doc, lines, totals, discovered) {
  lines.push(`+added ~updated -removed =kept (${totals.added} added, ${totals.updated} updated, ${totals.removed} removed)`);

  if (deps.dryRun) {
    lines.push("dry run: models.json untouched");

    return { ok: true, lines, totals };
  }

  if (totals.added === 0 && totals.updated === 0 && totals.removed === 0) {
    lines.push("already up to date");

    // A previous write may have succeeded while its reload failed. Disk equality
    // does not establish activation; a successful discovery must retry the reload.
    const ok = totals.synced > 0 && isFunction(deps.registry.refresh)
      ? await announceRefresh(deps, discovered, lines) : true;

    return { ok, lines, totals };
  }

  let backupPath = null;

  try {
    backupPath = writeModelsFile(deps.modelsPath, doc, deps.fs).backupPath;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { ok: false, lines: [...lines, `model-sync failed to write: ${reason}`], totals };
  }

  if (backupPath !== null) {
    lines.push(`backup: ${backupPath}`);
  }

  lines.push(`wrote ${deps.modelsPath}`);
  const ok = await announceRefresh(deps, discovered, lines);

  return { ok, lines, totals };
}

// deps: {registry, fetchImpl, fs, modelsPath, userAgent, filter?, dryRun?, refresh?}.
// Report lines are deterministic: sorted providers, fixed legend.
export async function runSync(deps) {
  const lines = [];
  const totals = { added: 0, updated: 0, removed: 0, synced: 0, skipped: 0 };
  const trainingNotes = [];
  const scope = planRun(deps);

  if (scope.abort !== undefined) {
    return { ok: false, lines: scope.abort, totals };
  }

  const { ids, allModels } = scope;

  lines.push(`model-sync${deps.dryRun ? " (dry run)" : ""}: ${ids.length} provider${ids.length === 1 ? "" : "s"}`);

  let doc;

  try {
    doc = readModelsFile(deps.modelsPath, deps.fs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { ok: false, lines: [...lines, `model-sync aborted: ${reason}`], totals };
  }

  let catalog = null;

  if (ids.length > 0) {
    const loaded = await loadCatalog({
      fetchImpl: deps.fetchImpl,
      userAgent: deps.userAgent,
      cachePath: cachePathFor(deps.modelsPath),
      fs: deps.fs,
      refresh: deps.refresh,
      dryRun: deps.dryRun,
    });

    catalog = loaded.catalog;
    lines.push(`  ${loaded.note}`);
  }

  // Discovery can yield to another sync or a user edit. The final read/merge/write
  // stays synchronous; unrelated changes completed during discovery survive.
  const discovered = await Promise.all(ids.map((id) => discoverProvider(deps, catalog, id, allModels)));

  try {
    doc = readModelsFile(deps.modelsPath, deps.fs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { ok: false, lines: [...lines, `model-sync aborted: ${reason}`], totals };
  }

  doc = mergeDiscovered(doc, discovered, lines, totals, trainingNotes);
  doc = sweepOrphans(doc, deps.registry, deps.filter, lines, totals);
  reportTraining(trainingNotes, lines);

  return finishRun(deps, doc, lines, totals, discovered);
}
