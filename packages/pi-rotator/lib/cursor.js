import { CATALOG_FIELDS } from "./accounts.js";
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

function savedStartupCatalog(id, config, providers) {
  const source = providers?.[id] || providers?.cursor;
  const rows = Object.entries(source?.modelOverrides || {});
  const models = new Map(config.models.map(model => [model.id, model]));

  for (const [modelId, values] of rows) {
    if (models.has(modelId)) continue;
    const metadata = Object.fromEntries(CATALOG_FIELDS.flatMap(field => values[field] === undefined ? [] : [[field, values[field]]]));
    models.set(modelId, { ...config.models[0], ...metadata, id: modelId });
  }

  return { ...config, models: [...models.values()] };
}

function startupCatalogHost(pi, state, definitions) {

  return {
    on: (...args) => pi.on(...args),
    registerProvider(id, config) {
      const first = !definitions.has(id);
      const definition = first ? savedStartupCatalog(id, config, state.savedModelProviders) : config;
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
  let modelRegistry;
  let pending = Promise.resolve();
  const readAuth = () => readJson(dir, "auth.json") || {};
  const owner = startupCatalogHost(pi, state, definitions);

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
      const all = [...new Set([...registered, ...ids])];

      const port = await setupCursorSubscription(owner, {
        readAuth, slotIds: all, discover: false, registered,
        canRegister: id => owns(id) || !modelRegistry?.getProvider?.(id),
        rejectDuplicateLogin: (id, credential) => rejectDuplicate(readAuth, id, credential),
        log: (kind, data) => appendDebug(dir, kind, data),
      });

      if (!port) throw new Error("Cursor transport is unavailable");

      for (const id of ["cursor", ...all]) {
        registered.add(id);
        state.ownedAliases.add(id);
      }

      return true;
    });

    pending = work;

    return work;
  }

  function credentialIds() {
    return Object.entries(readAuth()).filter(([id, value]) =>
      parseSlotId(id)?.base === "cursor" && value?.type === "oauth" && value.access).map(([id]) => id);
  }

  async function restore(registry) {
    const ids = credentialIds();

    if (!ids.length) return;
    const ready = await prepare(ids, registry);

    if (ready && registry?.refresh) await registry.refresh({ providers: ids, allowNetwork: false });
  }

  return { owns, prepare, restore, credentialIds };
}
