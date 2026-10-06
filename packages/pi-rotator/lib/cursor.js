import { familyCarrier } from "./accounts.js";
import { modelMetadata } from "./catalog.js";
import { FALLBACK_MODELS, modelConfig, processModels } from "./cursor/models.js";
import { parseSlotId } from "./slots.js";
import { appendDebug } from "./store.js";
import { readJson } from "./support.js";
import { markAccountOwner } from "./ownership.js";

function cursorIdentity(credential) {
  const access = credential?.access;

  if (!access) return undefined;

  try {
    const subject = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()).sub;

    if (subject && subject.constructor === String) return subject;
  } catch {
    // Opaque tokens retain pi-multi-account's same-token duplicate check.
  }

  return access;
}

function rejectDuplicate(readAuth, id, credential) {
  const identity = cursorIdentity(credential);

  if (!identity) return credential;

  const duplicate = Object.entries(readAuth()).find(([other, value]) =>
    other !== id && parseSlotId(other)?.base === "cursor" && cursorIdentity(value) === identity);

  if (duplicate) throw new Error("This real account is already logged in as " + duplicate[0] + ". Use that slot or log it out first.");

  return credential;
}

function familyOverrideRows(id, providers) {
  const base = parseSlotId(id)?.base;

  const sections = Object.keys(providers || {})
    .filter(section => section === id || parseSlotId(section)?.base === base && section !== id)
    .sort((a, b) => a === id ? -1 : b === id ? 1 : a < b ? -1 : a > b ? 1 : 0);

  const rows = new Map();

  for (const section of sections) {
    const overrides = providers[section]?.modelOverrides;

    if (!overrides || overrides.constructor !== Object) continue;

    for (const [modelId, values] of Object.entries(overrides)) {
      if (!rows.has(modelId)) rows.set(modelId, values);
    }
  }

  return rows;
}

function savedStartupCatalog(id, config, providers) {
  // The carrier lists for the whole family, so it merges saved ids from
  // every family section (own section wins ties); hidden siblings skip
  // this merge entirely and stay empty.
  const rows = familyOverrideRows(id, providers);
  const models = new Map(config.models.map(model => [model.id, model]));
  const template = config.models[0] ?? {};
  const extra = [];

  for (const [modelId, values] of rows) {
    if (!modelId || !modelId.trim() || models.has(modelId)) continue;
    const metadata = modelMetadata(values);
    extra.push({
      id: modelId,
      name: metadata.name ?? template.name ?? modelId,
      contextWindow: metadata.contextWindow ?? template.contextWindow ?? 200000,
      maxTokens: metadata.maxTokens ?? template.maxTokens ?? 64000,
    });
  }

  // Legacy cutovers persisted RAW discovered ids (effort embedded) as
  // overrides. Re-collapse them through the same grouping as the live
  // catalog: stale variants land on registered bases and are skipped, while
  // genuinely unknown families survive as collapsed entries with effort maps
  // instead of ghost raw ids that defeat thinking levels.
  for (const collapsed of processModels(extra)) {
    if (models.has(collapsed.id)) continue;
    models.set(collapsed.id, modelConfig(collapsed));
  }

  return { ...config, models: [...models.values()] };
}

function startupCatalogHost(pi, state, definitions, catalogPolicy) {

  return {
    on: (...args) => pi.on(...args),
    registerProvider(id, config) {
      // Hidden siblings stay empty: merging saved ids here would re-list
      // exactly the duplicates the unified catalog removes. A live catalog
      // supersedes saved startup-only ids once the slot discovers its own.
      const definition = catalogPolicy.shouldMergeSavedIds(id)
        ? savedStartupCatalog(id, config, state.savedModelProviders)
        : config;

      pi.registerProvider(id, definition);

      definitions.set(id, definition);
      state.ownedAliases.add(id);
    },
  };
}

function foreignStartupCatalog(id, providers) {
  const source = providers?.[id];

  if (!source || source.apiKey === "cursor-proxy") return false;

  // Bootstrap precedes the live registry; a family marker cannot authorize replacing explicit transport/auth.
  return ["baseUrl", "apiKey", "headers", "auth", "oauth"].some(field => Object.hasOwn(source, field)) || !!source.api && source.api !== "openai-completions";
}

// The reused transport owns OAuth, payload shaping and its process-local proxy.
// Rotator owns account IDs and policy; it never writes tokens or models.json.
export function createCursorAccounts(pi, dir, state) {
  const registered = new Set();
  const definitions = new Map();
  // Raw per-slot catalogs (fallback until a slot discovers its own) and
  // the slot currently carrying their union in the model picker.
  const catalogs = new Map();
  const discoveredIds = new Set();
  const carrierRef = { current: null };
  let cursorHandle = null;
  let lastUnionKey = null;
  let modelRegistry;
  let pending = Promise.resolve();
  const readAuth = () => readJson(dir, "auth.json") || {};

  const owner = startupCatalogHost(pi, state, definitions, {
    shouldMergeSavedIds: id => id === carrierRef.current && !discoveredIds.has(id),
  });

  function unionCatalog() {
    const byId = new Map();

    const ordered = [...catalogs.keys()].sort((a, b) =>
      a === carrierRef.current ? -1 : b === carrierRef.current ? 1 : a < b ? -1 : a > b ? 1 : 0);

    for (const id of ordered) {
      for (const model of catalogs.get(id) || []) {
        if (model?.id?.constructor === String && !byId.has(model.id)) byId.set(model.id, model);
      }
    }

    return [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function unionKey() {
    return JSON.stringify(unionCatalog().map(model => model.id));
  }

  // Bridge policy: store every raw catalog for the union, list the union
  // on the carrier and nothing elsewhere. Empty raws never overwrite a
  // stored catalog: discovery only reports non-empty reads.
  function resolveSlotCatalog(id, raw) {
    if (Array.isArray(raw) && raw.length) {
      catalogs.set(id, raw);
      lastUnionKey = unionKey();
    }

    return id === carrierRef.current ? unionCatalog() : [];
  }

  function owns(id) {
    if (!registered.has(id)) return false;

    if (!modelRegistry?.getRegisteredProviderConfig) return true;
    const expected = definitions.get(id);
    const current = modelRegistry.getRegisteredProviderConfig(id);
    const keys = Object.keys(expected || {}).filter(key => expected[key] !== undefined);

    // Pi shallow-merges registration configs; compare defined fields, not the merged object's identity.
    if (current && Object.keys(current).filter(key => current[key] !== undefined).length === keys.length && keys.every(key => current[key] === expected[key])) return true;
    registered.delete(id);
    definitions.delete(id);
    state.ownedAliases.delete(id);

    return false;
  }

  async function prepare(ids, registry) {
    modelRegistry = registry ?? modelRegistry;
    const additions = ids.filter(id => !owns(id));

    if (!additions.length) return true;
    const previous = pending;

    const work = previous.catch(() => {}).then(async () => {
      if (["cursor", ...ids].some(id => foreignStartupCatalog(id, state.savedModelProviders) || !owns(id) && registry?.getProvider?.(id))) return false;
      markAccountOwner(dir, "cursor");
      const { setupCursorSubscription } = await import("./cursor-bridge.js");
      const all = [...new Set([...registered, ...ids])].sort((a, b) => (parseSlotId(a)?.n ?? 1) - (parseSlotId(b)?.n ?? 1));
      // Mirror the bridge registration set: the base always registers, so it
      // is always a carrier candidate even before any login exists.
      carrierRef.current = familyCarrier([...new Set(["cursor", ...all])], readAuth(), registry ?? modelRegistry);

      const handle = await setupCursorSubscription(owner, {
        readAuth, slotIds: all, discover: false, registered,
        resolveSlotCatalog, carrierId: () => carrierRef.current,
        markDiscovered: id => discoveredIds.add(id),
        canRegister: id => owns(id) || !modelRegistry?.getProvider?.(id),
        rejectDuplicateLogin: (id, credential) => rejectDuplicate(readAuth, id, credential),
        log: (kind, data) => appendDebug(dir, kind, data),
      });

      if (!handle) throw new Error("Cursor transport is unavailable");
      cursorHandle = handle;
      lastUnionKey = unionKey();

      for (const id of ["cursor", ...all]) {
        registered.add(id);
        state.ownedAliases.add(id);
      }

      return true;
    });

    pending = work;

    return work;
  }

  // Converge owned listings on the authoritative carrier: drop catalogs
  // for departed slots, hide demoted siblings, list the union on the
  // carrier. Skips cleanly before the first setup; re-registers only on
  // hidden-state flips, carrier swaps, or union membership changes.
  function syncCarrier(slots, carrier) {
    if (!cursorHandle) return;

    // Deleting during Map iteration is safe; the iterator skips removed keys.
    for (const id of catalogs.keys()) {
      if (!slots.includes(id)) catalogs.delete(id);
    }

    for (const id of discoveredIds) {
      if (!slots.includes(id)) discoveredIds.delete(id);
    }

    for (const id of slots) {
      // A re-added slot restarts from fallback until it discovers again;
      // without a seed its share of the union stays missing.
      if (owns(id) && !catalogs.has(id)) catalogs.set(id, FALLBACK_MODELS);
    }

    if (carrier) carrierRef.current = carrier;
    const key = unionKey();
    const grown = key !== lastUnionKey;
    lastUnionKey = key;

    for (const id of slots) {
      if (!owns(id)) continue;
      const current = definitions.get(id);
      const hidden = !!current && Array.isArray(current.models) && current.models.length === 0;
      const wantHidden = id !== carrierRef.current;

      if (hidden === wantHidden && !(id === carrierRef.current && grown)) continue;

      try {
        cursorHandle.reregister(id, catalogs.get(id) || []);
      } catch (error) {
        appendDebug(dir, "cursor_slot_reregister_failed", { id, message: String(error?.message || error).slice(0, 160) });
      }
    }
  }

  // Removal drops the slot's union share immediately; without this a logged-out
  // account's discovered ids linger in the listing until something rediscovers.
  function forgetSlot(id) {
    catalogs.delete(id);
    discoveredIds.delete(id);
  }

  function credentialIds() {
    return Object.entries(readAuth()).filter(([id, value]) =>
      parseSlotId(id)?.base === "cursor" && value?.type === "oauth" && value.access).map(([id]) => id);
  }

  async function restore(registry) {
    if (!credentialIds().length) return;
    // Prepare every family key, not just usable credentials: a malformed
    // entry must fail its own slot at route time (verify + cool), never the
    // whole family at discovery time the way an unprepared id would.
    const ids = Object.keys(readAuth()).filter(id => parseSlotId(id)?.base === "cursor");
    const ready = await prepare(ids, registry);

    if (ready && registry?.refresh) await registry.refresh({ providers: ids, allowNetwork: false });
  }

  return { owns, prepare, restore, credentialIds, syncCarrier, forgetSlot };
}
