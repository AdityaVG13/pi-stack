import { appendJournal } from "./store.js";
import { detectDrift, detectInvalidation, fingerprintPayload, messageSignatures } from "./fingerprint.js";
import { familyOf, sessionIdOf, sessionState, ttlFor } from "./sessions.js";
import { fastCooldownKey, fastRequested } from "./fast.js";
import { repairThinking } from "./switch.js";


// Observe tier usage for cooldown scoping; fingerprint exactly what was
// delivered, never a shaped copy. Prompt/model/cache-key fields are not
// edited here. Also triages any pending thinking repair from
// the last switch (repairThinking): thinking is global, so this runs for
// every request regardless of family. The request context also carries the
// live thinking level: captured here as the next switch's repair target,
// so the switch path itself never touches the thinking API.
function recordFastRequest(session, model, requested) {
  const fastChanged = session.lastFast !== undefined && session.lastFast !== requested;
  const tierKey = fastCooldownKey(model.provider, model.id);
  session.fastRequests ??= new Set();

  if (requested) session.fastRequests.add(tierKey);
  else session.fastRequests.delete(tierKey);
  session.lastFast = requested;

  // A real request consumes the handoff, but not the activity's account budget.
  if (session.recovery) session.recovery.pending = null;

  return fastChanged;
}

function recordFingerprint(session, model, payload, fastChanged) {
  const next = fingerprintPayload(payload);
  const prev = session.fingerprints.get(model.provider) || null;
  session.fingerprints.set(model.provider, next);
  const { compacted, modelChanged } = detectInvalidation(prev, next, session.lastModelId, model.id);
  session.lastModelId = model.id;

  if (modelChanged || fastChanged) {
    // A fresh namespace retains only its current fingerprint; old warmth is stale.
    session.warm.clear();
    session.fingerprints.clear();
    session.fingerprints.set(model.provider, next);
  } else if (compacted) {
    session.warm.clear();
  }

  return { next, prev, compacted, modelChanged };
}

function traceRequest(dir, family, sessionId, session, model, ctx, fingerprint, fastChanged, requested) {
  const { next, prev, compacted, modelChanged } = fingerprint;
  const now = Date.now();
  const ttlMs = ttlFor(family, model);
  appendJournal(dir, "request", {
    family: family.base, session: String(sessionId).slice(0, 8), slot: model.provider, model: model.id,
    fp: next.fp, len: next.len, prevLen: prev ? prev.len : null, compacted, modelChanged, fastChanged,
    fastRequested: requested, projection: next.projection, ttlMs,
    warm: now - (session.warm.get(model.provider) || 0) < ttlMs,
    drainedTurns: family.drained.get(model.provider) || 0, ctxThinking: ctx?.thinkingLevel || null,
  });
}

export function onBeforeRequest(pi, dir, state, event, ctx) {
  const repaired = repairThinking(pi, dir, state, ctx) === "repair";

  if (ctx?.thinkingLevel && !repaired) state.lastThinking = { level: ctx.thinkingLevel, session: sessionIdOf(ctx) };
  const model = ctx ? ctx.model : null;

  if (!model) return;
  state.requests.set(sessionIdOf(ctx), { ...model });
  const payload = event?.payload;
  const requested = fastRequested(model, payload);
  const family = familyOf(state, model.provider);

  if (!family) return;
  const { id: sessionId, session } = sessionState(family, ctx);
  const fastChanged = recordFastRequest(session, model, requested);
  const fingerprint = recordFingerprint(session, model, payload, fastChanged);
  traceRequest(dir, family, sessionId, session, model, ctx, fingerprint, fastChanged, requested);
}


// Watch raw-history drift before projecting account aliases. pi-ai otherwise
// treats an alias handoff as a model change and strips signed reasoning/text
// and tool IDs. Only discovered slots with the same model AND API are
// interchangeable here. Copy message metadata, never content or raw history.
function projectAliases(event, model, family) {
  if (!model.api || !family.slots.includes(model.provider) || !Array.isArray(event?.messages)) return;
  let changed = false;

  const messages = event.messages.map(message => {
    if (message?.role !== "assistant" || message.model !== model.id || message.api !== model.api ||
        message.provider === model.provider || !family.slots.includes(message.provider)) return message;
    changed = true;

    return { ...message, provider: model.provider };
  });

  if (changed) return { messages };
}

export function onContext(dir, state, event, ctx) {
  const model = ctx ? ctx.model : null;

  if (!model) return;
  const family = familyOf(state, model.provider);

  if (!family) return;
  const { id: sessionId, session } = sessionState(family, ctx);
  const next = messageSignatures(event ? event.messages : null);
  const { drift, position, common } = detectDrift(session.msgSig, next);

  session.msgSig = next;

  if (drift) {
    appendJournal(dir, "drift", {
      family: family.base,
      session: String(sessionId).slice(0, 8),
      slot: model.provider,
      position,
      common,
      messages: next.length,
    });
  }

  return projectAliases(event, model, family);
}


// The host's own compaction signal for this session: the prefix was rebuilt,
// so the session's warmth and fingerprint history is stale. Primary signal;
// the shrink heuristic in onBeforeRequest stays as backup for external edits.
export function onCompact(dir, state, ctx) {
  const sessionId = sessionIdOf(ctx);

  for (const family of state.families.values()) {
    const session = family.sessions.get(sessionId);

    if (!session) continue;
    session.warm.clear();
    session.fingerprints.clear();
    session.msgSig = null;
  }

  appendJournal(dir, "invalidate", {
    cause: "compaction-event",
    session: String(sessionId).slice(0, 8),
  });
}


// Pi core's cache warmer just decided to refresh this session's entry: the
// slot provably holds a hot prefix, so stamp its warmth. A refresh is a
// one-token replay, not a served turn — journaled, never counted as drain.
// Observe-only: the economics decision stays core's.
export function onWarmDecision(dir, state, event, ctx) {
  const model = ctx ? ctx.model : null;

  if (!model || !event || event.action !== "warm") return;
  const family = familyOf(state, model.provider);

  if (!family) return;
  const { id: sessionId, session } = sessionState(family, ctx);

  session.warm.set(model.provider, Date.now());
  appendJournal(dir, "warmed", {
    family: family.base,
    session: String(sessionId).slice(0, 8),
    slot: model.provider,
    model: model.id,
  });
}
