// Generic alias registration: clone a pi-ai builtin provider under a slot id.
//
// No family table: pi-ai's builtinProviders() yields every builtin family
// (openai-codex, anthropic, xai, kimi-coding, ...), and Pi's
// registerProvider(provider) preserves the complete native definition. The
// alias shares the base transport/auth implementation while Pi resolves
// credentials per provider id, so each alias authenticates as its own
// auth.json entry. Families with no builtin factory (extension transports
// like cursor/devin, custom providers like ollama) report unsupported —
// honestly, in status — instead of guessing.
import { parseSlotId } from "./slots.js";

// Pi owns this module. Host peers must use "*" and runtime installations must
// omit local peer copies so the extension loader can bind the host instance.
export const nativeBuiltinModule = await import("@earendil-works/pi-ai/providers/all");

const BUILTIN_WIRE = Symbol("builtin wire identity");

// A FRESH base instance per call: each alias gets its own top-level and
// nested objects (function refs stay module singletons either way), so Pi
// can never cross-contaminate alias state through a shared def object.
export function builtinBase(mod, baseId) {
  if (!mod || !(mod.builtinProviders instanceof Function)) return null;

  try {
    const found = mod.builtinProviders().find((p) => p && p.id === baseId);

    if (found) found[BUILTIN_WIRE] = true;

    return found || null;
  } catch {
    return null;
  }
}

// Builtin APIs contain provider-id-specific auth and replay rules. Canonicalize
// their wire view only; callbacks/results keep the serving account identity.
// A package-supplied factory has no provenance marker and is never rewritten.
function builtinWireStream(base, aliasId, stream) {
  return (model, context, options = {}) => {
    const wireModel = { ...model, provider: base.id };

    const messages = context.messages.map(message => message.role === "assistant" &&
      message.model === model.id && message.api === model.api && parseSlotId(message.provider)?.base === base.id
      ? { ...message, provider: base.id } : message);

    const native = stream(wireModel, { ...context, messages }, {
      ...options,
      onPayload: options.onPayload && (payload => options.onPayload(payload, model)),
      onResponse: options.onResponse && (response => options.onResponse(response, model)),
      onProviderStreamEvent: options.onProviderStreamEvent && (event => options.onProviderStreamEvent(event, model)),
    });

    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of native) {
          yield aliasStreamEvent(event, aliasId);
        }
      },
      async result() {
        return { ...await native.result(), provider: aliasId };
      },
    };
  };
}

export function aliasDef(base, aliasId, n, hidden = false) {
  const def = { ...base, id: aliasId, name: `${base.name} (account ${n})` };
  // Native catalogs carry provider identity. Re-key every operation without
  // mutating the factory's catalog; OAuth, refresh and wire implementations
  // remain provider-owned. Never pass this object through legacy ProviderConfig.
  // Hidden siblings keep everything but the listing: one family catalog on
  // the carrier, every account still routable underneath.
  const rekey = models => models.map(model => ({ ...model, provider: aliasId }));

  def.getModels = hidden ? () => [] : () => rekey(base.getModels());

  if (base.getAllModels) def.getAllModels = hidden ? () => [] : () => rekey(base.getAllModels());

  if (base[BUILTIN_WIRE]) {
    def.stream = builtinWireStream(base, aliasId, base.stream);

    if (base.streamSimple) def.streamSimple = builtinWireStream(base, aliasId, base.streamSimple);
  }

  if (base.refreshModels) {
    // A native factory restores its own id and emits base-shaped rows. The
    // host's persistent catalog and publication generation must remain scoped
    // to the alias; only its private restore input is translated back.
    def.refreshModels = context => base.refreshModels({
      ...context,
      stored: context.stored && { ...context.stored, models: context.stored.models.map(model => ({ ...model, provider: base.id })) },
      publish: change => context.publish({
        ...change,
        persist: change.persist && { ...change.persist, models: rekey(change.persist.models) },
      }),
    });
  }

  return def;
}

function aliasStreamEvent(event, aliasId) {
  const field = ["partial", "message", "error"].find(key => event[key]);

  return field ? { ...event, [field]: { ...event[field], provider: aliasId } } : event;
}
