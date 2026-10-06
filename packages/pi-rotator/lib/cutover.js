import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { providerBase } from "./accounts.js";
import { modelMetadata } from "./catalog.js";
import { customAccountEndpoint } from "./custom.js";
import { parseSlotId } from "./slots.js";
import { findTransport } from "./rivals.js";
import { appendDebug } from "./store.js";
import { atomicStorage, readStorage, restoreShadowedAuth, isLegacyModelMarker } from "./credentials.js";

const MANAGED_APIS = { anthropic: "anthropic-messages", "openai-codex": "openai-codex-responses", cursor: "openai-completions" };

export function managedFamily(id, source) {
  const base = parseSlotId(id)?.base;

  if (!source || source.constructor !== Object) return undefined;

  if (!Object.hasOwn(MANAGED_APIS, base) || !source.baseUrl || !isLegacyModelMarker(source.apiKey)) return undefined;
  let url;

  try {
    url = new URL(source.baseUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return undefined;

  if (source.api !== MANAGED_APIS[base]) throw new Error("Refusing ambiguous managed transport: " + id);

  return base;
}

function retireRoute(plan, id, source, base) {
  const rows = Array.isArray(source.models) ? source.models : [];

  const models = rows.flatMap(model => {
    if (model?.type && model.type !== "chat") return [];
    const metadata = modelMetadata(model);

    return metadata.id ? [metadata] : [];
  });

  if (base === "cursor") {
    if (plan.auth[id]?.type === "oauth") plan.models.providers[id] = { modelOverrides: Object.fromEntries(models.map(({ id: modelId, ...values }) => [modelId, values])) };

    return;
  }

  if (!plan.models.providers[base] || plan.models.providers[base].constructor !== Object) plan.models.providers[base] = {};
  const target = plan.models.providers[base];

  if (!Array.isArray(target.models)) target.models = [];
  const existing = target.models;
  const stock = providerBase(base)?.getModels?.() || [];
  const ids = new Set([...stock, ...existing].map(model => model?.id));

  for (const model of models) {
    if (!ids.has(model.id)) existing.push(model);
    ids.add(model.id);
  }
}

function managedRoutes(providers) {
  const routes = [];

  for (const [id, source] of Object.entries(providers || {})) {
    const base = managedFamily(id, source);

    if (base) routes.push({ id, source, base });
  }

  return routes;
}

function retireRoutes(plan, routes) {
  // Remove every proxy entry first so catalog merging never sees a stale route.
  for (const { id } of routes) delete plan.models.providers[id];

  for (const { id, source, base } of routes) retireRoute(plan, id, source, base);

  for (const base of ["anthropic", "openai-codex"]) {
    const source = plan.models.providers[base];

    if (source?.models?.length === 0 && Object.keys(source).length === 1) delete plan.models.providers[base];
  }
}

function retireCopiedKeys(providers, auth) {
  for (const [id, source] of Object.entries(providers || {})) {
    if (!source || source.constructor !== Object) continue;
    const endpoint = customAccountEndpoint(parseSlotId(id)?.base);
    const credential = auth[id];

    if (endpoint && source.baseUrl === endpoint && source.api === "openai-completions" && credential?.type === "api_key" && source.apiKey === credential.key) delete source.apiKey;
  }
}

// A stale settings default must never block migration or startup: the plan
// copies settings verbatim and Pi falls back gracefully on its own. Record
// it for diagnostics instead. Only stock-backed families can judge; cursor
// catalogs resolve at runtime, never from this snapshot.
function warnStaleDefault(dir, plan) {
  try {
    const provider = plan.settings?.defaultProvider;
    const id = plan.settings?.defaultModel;

    if (!provider || !id) return;
    const base = parseSlotId(provider)?.base;
    const stock = providerBase(base)?.getModels?.() || [];

    if (!stock.length) return;
    const section = name => plan.models.providers?.[name];
    const saved = [...(Array.isArray(section(provider)?.models) ? section(provider).models : []), ...(Array.isArray(section(base)?.models) ? section(base).models : [])];

    if ([...stock, ...saved].some(model => model?.id === id)) return;
    appendDebug(dir, "stale_default", { provider, model: id });
  } catch {
    // Diagnostics never block startup.
  }
}

export function prepareMigration(input, restoreAll = restoreShadowedAuth) {
  const plan = structuredClone(input);
  plan.models.providers ||= {};
  const restored = restoreAll(plan.auth, plan.sidecar);
  plan.auth = restored.auth;
  plan.sidecar = restored.sidecar;
  const packages = Array.isArray(plan.settings.packages) ? plan.settings.packages : [];
  plan.settings.packages = packages.filter(setting => !findTransport([setting]));
  retireRoutes(plan, managedRoutes(input.models.providers));
  // Only exact legacy copies on known endpoints are retired; env/command keys
  // and foreign provider configurations stay owned by their original package.
  retireCopiedKeys(plan.models.providers, input.auth);

  return plan;
}

// Old transport shutdown/removal is the ownership boundary. No live credentials
// or catalogs are changed while that owner is configured. Restoration is replayable:
// auth first, models next, sidecar last, so any failed write leaves a recovery copy.
export function initializeStandalone(dir) {
  const settings = readStorage(join(dir, "settings.json"));

  if (findTransport(settings.packages)) return { changed: false };
  const authPath = join(dir, "auth.json");
  const modelsPath = join(dir, "models.json");
  const sidecarPath = join(dir, "pi-multi-account-proxy-oauth.json");

  if (!existsSync(authPath)) return { changed: false };
  const releases = [];

  try {
    if (existsSync(modelsPath)) releases.push(lockfile.lockSync(modelsPath, { realpath: false }));
    releases.push(lockfile.lockSync(authPath, { realpath: false }));
    const input = { settings, auth: readStorage(authPath), sidecar: readStorage(sidecarPath), models: readStorage(modelsPath) };
    input.models.providers ||= {};
    const plan = prepareMigration(input);
    warnStaleDefault(dir, plan);
    let changed = false;

    for (const [key, path] of [["auth", authPath], ["models", modelsPath], ["sidecar", sidecarPath]]) {
      if (JSON.stringify(input[key]) === JSON.stringify(plan[key])) continue;
      atomicStorage(path, plan[key]);
      changed = true;
    }

    return { changed };
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export async function beginCutover(dir, ctx, { restart = false } = {}) {
  if (!ctx?.isIdle?.()) throw new Error("Cutover requires an idle session");

  if (!restart && !(ctx.reload instanceof Function)) throw new Error("Host reload is unavailable; no configuration changed");
  const path = join(dir, "settings.json");
  const initial = readStorage(path);

  if (!findTransport(initial.packages)) return false;
  const started = performance.now();

  const phase = value => appendDebug(dir, "cutover_phase", { phase: value, elapsedMs: Math.round(performance.now() - started) });

  phase("validate");

  const release = lockfile.lockSync(path, { realpath: false });
  let previous, next;

  try {
    previous = readStorage(path);
    // Validate the actual login/catalog shapes before handing off ownership.
    // Tokens may refresh meanwhile; startup restoration re-reads under auth lock.
    prepareMigration({ settings: previous, auth: readStorage(join(dir, "auth.json")), sidecar: readStorage(join(dir, "pi-multi-account-proxy-oauth.json")), models: readStorage(join(dir, "models.json")) });
    next = { ...previous, packages: (previous.packages || []).filter(setting => !findTransport([setting])) };
    atomicStorage(path, next);
  } finally {
    release();
  }

  phase("staged");

  // Staging changes only settings. The running legacy owner keeps its files
  // until shutdown; the next standalone startup performs guarded restoration.
  if (restart) return true;

  phase("reload_start");

  try {
    // The old owner's shutdown runs BEFORE a new Rotator factory can restore
    // auth and replace publications. No interactive re-login is involved.
    await ctx.reload();
    phase("reload_complete");

    return true;
  } catch {
    phase("reload_failed");

    const unlock = lockfile.lockSync(path, { realpath: false });

    try {
      const current = readStorage(path);

      if (JSON.stringify(current.packages) === JSON.stringify(next.packages)) atomicStorage(path, { ...current, packages: previous.packages });
    } finally {
      unlock();
    }

    throw new Error("Reload failed; previous package ownership restored where unchanged. Restart Pi before retrying cutover");
  }
}
