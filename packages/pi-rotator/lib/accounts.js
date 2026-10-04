import { appendJournal, pruneCooldowns, pruneSessions } from "./store.js";
import { aliasDef, builtinBase, nativeBuiltinModule } from "./clone.js";
import { debugLine, readJson } from "./support.js";
import { discoverFamilies, parseSlotId } from "./slots.js";
import { isTransportFamily } from "./transport.js";
import { customAccountBase } from "./custom.js";
import { modelMetadata } from "./catalog.js";

export { CATALOG_FIELDS } from "./catalog.js";


// An overlay is not an account factory. Reuse earlier native provenance only
// while the host still exposes an unchanged alias that we registered ourselves.
function establishedAccountBase(base, registry, state) {
  for (const [id, record] of state?.nativeAliases || []) {
    if (record.base !== base || !state.ownedAliases.has(id)) continue;

    if (registry.getRegisteredNativeProvider?.(id) === record.definition) return record.provider;
  }

  return null;
}

export function registerOwnedAlias(pi, state, base, provider, id, n) {
  const definition = aliasDef(provider, id, n);
  pi.registerProvider(definition);
  state.ownedAliases.add(id);
  state.nativeAliases ||= new Map();
  state.nativeAliases.set(id, { base, provider, definition });
}

function validSavedChat(model, ids) {
  return model?.id && model.id.constructor === String && (!model.type || model.type === "chat") && !ids.has(model.id);
}

function appendSavedSource(provider, models, source, ids, extras) {
  const template = models.find(model => !source.api || model.api === source.api);

  if (!template) return;

  for (const model of source.models) {
    if (!validSavedChat(model, ids)) continue;
    extras.push({ ...template, ...modelMetadata(model), provider: provider.id, baseUrl: provider.baseUrl, type: "chat" });
    ids.add(model.id);
  }
}

function missingSavedModels(provider, models, sources) {
  const ids = new Set(models.map(model => model.id));
  const extras = [];

  for (const [id, source] of Object.entries(sources || {})) {
    if (parseSlotId(id)?.base === provider.id && Array.isArray(source?.models)) appendSavedSource(provider, models, source, ids, extras);
  }

  return extras;
}

// Saved catalogs can supply newer chat IDs, not a new transport or credential.
// Stock entries stay authoritative; package-owned native factories are untouched.
function withSavedCatalog(provider, sources) {
  if (!sources) return provider;

  return {
    ...provider,
    getModels: () => {
      // Extend one snapshot: a second read may observe a different catalog.
      const models = provider.getModels();

      return [...models, ...missingSavedModels(provider, models, sources)];
    },
    getAllModels: () => {
      const all = provider.getAllModels?.();
      const models = provider.getModels();

      return [...(all || models), ...missingSavedModels(provider, models, sources)];
    },
  };
}

export function providerBase(base, registry, builtins = nativeBuiltinModule, state) {
  const native = registry?.getRegisteredNativeProvider?.(base);

  if (native) return native;

  // Legacy definitions can close over custom protocols or one credential.
  // A similarly named builtin is not an equivalent account factory.
  if (registry?.getRegisteredProviderConfig?.(base)) return establishedAccountBase(base, registry, state);

  const declared = state?.accountFactories?.get(base);

  if (declared) return declared;
  const provider = builtins ? builtinBase(builtins, base) || customAccountBase(base, state?.savedModelProviders, builtins) : null;

  return provider ? withSavedCatalog(provider, state?.savedModelProviders) : null;
}


function cloneFailureMessage(error) {
  return String((error && error.message) || error).slice(0, 160);
}

function registerSlot(pi, dir, state, base, id, builtinModule, registry) {
  if (id === base) return { via: "base" };

  if (base === "cursor" && state.cursor?.owns(id)) return { via: "cursor" };

  if (state.ownedAliases.has(id)) return { via: "clone" };

  // Package-owned protocols/auth are never replaced or rolled back.
  if (registry?.getProvider?.(id)) return { via: "registered" };
  const n = parseSlotId(id).n;
  const baseDef = providerBase(base, registry, builtinModule, state);

  if (!baseDef) return { reason: "no pi-ai builtin factory" };

  try {
    registerOwnedAlias(pi, state, base, baseDef, id, n);

    return { via: "clone", created: true };
  } catch (error) {
    debugLine(state, dir, "clone_failed", { id, message: cloneFailureMessage(error) });

    return { reason: "alias registration rejected" };
  }
}

function registerFamilySlots(pi, dir, state, base, slots, builtinModule, viaTransport, registry) {
  // Transport-owned families are route-only; their definitions remain untouched.
  if (viaTransport) return { ok: true, slots: [...slots], via: "transport" };
  const created = [];
  const vias = new Set();

  for (const id of slots) {
    const result = registerSlot(pi, dir, state, base, id, builtinModule, registry);

    if (result.reason) return { ok: false, reason: result.reason, registered: created };

    vias.add(result.via);

    if (result.created) {
      created.push(id);
      debugLine(state, dir, "slot_registered", { id, how: "clone" });
    }
  }

  return { ok: true, slots: [...slots], via: vias.has("cursor") ? "cursor" : registrationVia(vias.has("registered"), vias.has("clone")) };
}

function registrationVia(adopted, cloned) {
  return adopted ? (cloned ? "mixed" : "registered") : "clone";
}

function ensureFamily(state, base) {
  let family = state.families.get(base);

  if (!family) {
    family = {
      base, slots: [], cooldowns: new Map(), drained: new Map(), sessions: new Map(),
      ttlMs: Object.hasOwn(state.config.ttlByFamily, base) ? state.config.ttlByFamily[base] : state.config.ttlMs,
      strategy: state.config.strategy, rrIndex: -1, status: "pending", reason: null, via: null,
    };
    state.families.set(base, family);
  }

  return family;
}

function updateFamily(pi, state, family, slots, result) {
  if (result.ok) {
    family.slots = result.slots;
    family.status = "active";
    family.reason = null;
    family.via = result.via;

    return;
  }

  // Roll back only aliases created in this attempt, never older or base slots.
  for (const id of result.registered || []) {
    if (id === family.base) continue;

    try {
      pi.unregisterProvider(id);
      state.ownedAliases.delete(id);
      state.nativeAliases?.delete(id);
    } catch {
      // Best effort; a stale alias is cosmetic until restart.
    }
  }

  family.slots = slots;
  family.status = "unsupported";
  family.reason = result.reason;
}

// Discovery consumes IDs, never package keys. Host auth metadata permits
// config/runtime/environment accounts without copying credentials into auth.json.
// Our own aliases still require their login entries, not a shared environment key.
function registeredIds(registry) {
  return registry?.getRegisteredProviderIds?.() || [];
}

function configuredAccount(registry, id) {
  return registry.getProvider?.(id) && registry.getProviderAuthStatus?.(id)?.configured === true;
}

function discoveryAccounts(auth, registry, state) {
  const ids = new Set(Object.keys(auth || {}));

  for (const id of registeredIds(registry)) {
    if (state.ownedAliases.has(id) || !parseSlotId(id)) continue;

    if (configuredAccount(registry, id)) ids.add(id);
  }

  return Object.fromEntries([...ids].map(id => [id, true]));
}


export function rediscover(pi, dir, state, auth = readJson(dir, "auth.json"), registry) {
  if (registry) state.nativeFamilies = nativeFamilyNames(registry, state.cursor, state);
  const builtinModule = nativeBuiltinModule;
  const seen = new Set();

  for (const { base, slots } of discoverFamilies(discoveryAccounts(auth, registry, state))) {
    seen.add(base);
    const family = ensureFamily(state, base);
    const viaTransport = state.mode === "transport" && isTransportFamily(base);
    const result = registerFamilySlots(pi, dir, state, base, slots, builtinModule, viaTransport, registry);
    updateFamily(pi, state, family, slots, result);

    pruneCooldowns(family.cooldowns, Date.now());
    pruneSessions(family.sessions, Date.now());
    debugLine(state, dir, "rediscover", {
      base,
      slots,
      status: family.status,
      reason: family.reason,
    });
    appendJournal(dir, "rediscover", {
      family: base,
      slots,
      status: family.status,
      reason: family.reason,
      via: family.via,
    });
  }

  // Drop families whose credentials vanished; re-login re-adds them.
  // (Deleting during Map iteration is safe — the iterator skips removed keys.)
  for (const base of state.families.keys()) {
    if (!seen.has(base)) state.families.delete(base);
  }

  return state.families;
}


// Only prepared aliases need a login handoff. Reuse the same auth snapshot
// throughout discovery; a missing prepared credential leaves serving families alone.
// Existing discovery preserves warmth, cooldowns and native provider instances.
export function syncPreparedAccounts(pi, dir, state, ctx) {
  if (!state.preparedAccounts.size) return;
  const auth = readJson(dir, "auth.json");

  if (!auth || Array.isArray(auth)) return;
  const authenticated = [...state.preparedAccounts].filter(id => Object.hasOwn(auth, id));

  if (!authenticated.length) return;
  const families = rediscover(pi, dir, state, auth, ctx?.modelRegistry);

  clearPrepared(state, families, authenticated);
}

function clearPrepared(state, families, authenticated) {
  for (const id of authenticated) {
    const family = families.get(parseSlotId(id).base);

    if (family?.status === "active" && family.slots.includes(id)) state.preparedAccounts.delete(id);
  }
}


function reconcileFamilyName(names, id, registry, cursor, state) {
  if (parseSlotId(id)?.n !== 1) return;

  if (cursor?.owns(id) || registry.getRegisteredNativeProvider?.(id) || establishedAccountBase(id, registry, state)) names.add(id);
  else if (registry.getRegisteredProviderConfig?.(id)) names.delete(id);
}

export function nativeFamilyNames(registry, cursor, state) {
  const names = new Set([...nativeBuiltinModule.builtinProviders().map(provider => provider.id), "cursor", "qwen", "ollama"]);

  for (const id of state?.accountFactories?.keys() || []) names.add(id);

  for (const id of registeredIds(registry)) reconcileFamilyName(names, id, registry, cursor, state);

  return [...names].sort();
}
