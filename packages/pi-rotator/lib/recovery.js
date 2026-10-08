import { appendJournal, classifyResponse, markCooling, needsBackfill, recordTurn } from "./store.js";
import { debugLine } from "./support.js";
import { familyOf, peekSession, sessionIdOf, sessionState } from "./sessions.js";
import { fastCapability, fastCooldownKey, fastTierError } from "./fast.js";
import { serializeHandoff, switchModel } from "./switch.js";


function failureCooldownKey(session, provider, modelId) {
  const fastKey = fastCooldownKey(provider, modelId);

  return session?.fastRequests?.has(fastKey) ? fastKey : provider;
}


async function rescue(pi, dir, state, family, model, session, ctx, cooldownKey) {
  return serializeHandoff(session, ctx, () => rescueOnce(pi, dir, state, family, model, session, ctx, cooldownKey));
}


async function rescueOnce(pi, dir, state, family, model, session, ctx, cooldownKey) {
  if (!session.recovery || session.recovery.modelId !== model.id) {
    session.recovery = { modelId: model.id, attempted: new Set(), pending: null };
  }

  const recovery = session.recovery;

  if (recovery.attempted.has(model.provider)) return;
  const pending = { from: model.provider, to: null, modelId: model.id };

  recovery.attempted.add(model.provider);
  recovery.pending = pending;
  markCooling(family.cooldowns, cooldownKey ?? failureCooldownKey(session, model.provider, model.id), Date.now() + state.config.cooldownMs);
  const live = ctx?.model;

  if (handoffElsewhere(live, model, family, pending)) return;

  pending.to = await switchModel(
    pi, dir, state, family, model.provider, model, session, "exhausted", ctx, recovery.attempted,
  );
}


function recoveryForModel(state, model, ctx) {
  const family = model && familyOf(state, model.provider);
  const recovery = family && peekSession(family, ctx)?.recovery;

  return { family, recovery };
}

function routingContext(state, ctx) {
  const model = ctx ? ctx.model : null;
  const family = model ? familyOf(state, model.provider) : null;
  const session = family ? sessionState(family, ctx).session : null;

  return { model, family, session };
}

function traceTurn(dir, model, backfilled) {
  appendJournal(dir, "turn", {
    slot: model ? model.provider : null, model: model ? model.id : null,
    backfill: backfilled ? model.provider : null,
  });
}

function turnFailure(event, model, family) {
  return model && family ? failedTurn(event, model) : null;
}

function shouldRotate(model, family, failure) {
  return model && family && family.strategy !== "failover" &&
    (family.strategy !== "round-robin" || failure);
}

function handoffElsewhere(live, model, family, pending) {
  if (!live || (live.provider === model.provider && live.id === model.id)) return false;
  pending.to = live.id === model.id && family.slots.includes(live.provider) ? live.provider : null;

  return true;
}

function currentHandoff(state, ctx) {
  const family = ctx?.model && familyOf(state, ctx.model.provider);

  return family && peekSession(family, ctx)?.handoff;
}

function settledTarget(event, ctx, model, pending) {
  return event?.outcome === "error" && !ctx?.signal?.aborted &&
    pending.to && model.provider === pending.to && model.id === pending.modelId;
}

function matchingFailure(message, source, pending) {
  return source?.type === "message" && source.id && message?.role === "assistant" &&
    message.stopReason === "error" && message.provider === pending.from && message.model === pending.modelId;
}

// A scrubbed failure leaves the model a silent gap after a slot change;
// Grok repeatedly fills it with workspace-loss fiction. Cursor rescues that
// reach this boundary (failures pi-core does not retry first) append a
// truthful handoff note after the omission. Retried failures keep pi-core
// null-omission: the retry request consumes pending before settle.
export function rescueNote(pending, message) {
  const cause = String(message?.errorMessage || "unknown error").split("\n", 1)[0].slice(0, 200).trim() || "unknown error";

  const moved = pending.to && pending.to !== pending.from
    ? `automatically switched account from ${pending.from} to ${pending.to} (same model)`
    : "retrying on the same account";

  return `[pi-rotator] Previous attempt failed (${cause}); ${moved}. Workspace, files and session state are unaffected; continue the task.`;
}

function failedContextTail(event, pending) {
  const tail = event.context?.contextEntries?.findLast(entry => entry.messages.length > 0);
  const message = tail?.messages.at(-1);
  const source = tail?.sourceEntry;

  return matchingFailure(message, source, pending) ? source : undefined;
}

function traceResponse(state, dir, model, family, status, action) {
  debugLine(state, dir, "response", {
    slot: model ? model.provider : null, status: status === undefined ? null : status,
    action, family: family ? family.base : null,
  });
}

function responseCooldownKey(status, model, session) {
  // Authentication belongs to the account even when its fast capacity is separate.
  const sharedQuota = status === 401 || ([429, 402].includes(status) && fastCapability(model).kind !== "speed");

  return sharedQuota ? model.provider : failureCooldownKey(session, model.provider, model.id);
}

function successfulAssistant(message, model) {
  return message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" &&
    message.provider === model.provider && message.model === model.id;
}

function backfillWarmth(family, session, model) {
  const backfilled = Boolean(family && family.strategy !== "failover" && session && model && needsBackfill(session, model.provider));

  if (backfilled) session.warm.set(model.provider, Date.now());

  return backfilled;
}

export function coolFailedTurn(dir, state, family, session, model, failure) {
  const ours = failure.slot !== null && family.slots.includes(failure.slot);
  const sharedQuota = failure.unauthorized || (failure.exhausted && fastCapability({ ...model, provider: failure.slot, id: failure.modelId }).kind !== "speed");
  const cooldownKey = sharedQuota ? failure.slot : failureCooldownKey(session, failure.slot, failure.modelId);
  const transientAccount = failure.transient && cooldownKey === failure.slot;

  if (ours) markCooling(family.cooldowns, cooldownKey, Date.now() + (transientAccount ? TRANSIENT_COOLDOWN_MS : state.config.cooldownMs));
  appendJournal(dir, "turn_failed", {
    family: family.base, slot: failure.slot, message: failure.message, cooled: ours,
    cooldownScope: transientAccount ? "transient" : cooldownKey === failure.slot ? "account" : "fast-tier",
  });

  return { ours, cooldownKey };
}

function recoveryNeeded(failure, cooldownKey) {
  return failure.exhausted || failure.transient || (cooldownKey !== failure.slot && failure.fastRejected);
}

function confirmedHandoff(session, slot) {
  return session.recovery?.pending?.from === slot;
}

function failureDisposition(session, model, failure, ours, cooldownKey) {
  if (!ours || failure.modelId !== model.id) return "rotate";

  if (confirmedHandoff(session, failure.slot)) return "handled";

  return recoveryNeeded(failure, cooldownKey) ? "rescue" : "rotate";
}

export function resetRecovery(state, ctx) {
  state.requests.delete(sessionIdOf(ctx));

  for (const family of state.families.values()) {
    const session = peekSession(family, ctx);

    if (session) {
      session.recovery = null;
      session.fastRequests?.clear();
    }
  }
}


// Pi's own retries and queued work run before this boundary. Only if the
// failed request is still the tail do we omit that attempt from model context
// and request one context-only continuation. Raw history and completed tools
// are retained; no new user message or prompt shaping is needed.
export async function onBeforeSettle(dir, state, event, ctx) {
  await currentHandoff(state, ctx);
  const model = ctx?.model;
  const { family, recovery } = recoveryForModel(state, model, ctx);
  const pending = recovery?.pending;

  if (!pending) return;
  recovery.pending = null;

  if (!settledTarget(event, ctx, model, pending)) return;
  const source = failedContextTail(event, pending);

  if (!source) return;
  appendJournal(dir, "resume", {
    family: family.base, from: pending.from, to: pending.to, model: pending.modelId,
    session: String(sessionIdOf(ctx)).slice(0, 8),
  });

  // An assistant-slot substitution would block continuation (pi-core only
  // continues past a non-assistant tail), so the omission stays silent and
  // the explanation rides a separate custom message, which projects as a
  // user-role turn. Quota failures keep pure omission: narrating them risks
  // model refusal on the healthy account.
  const explain = family.base === "cursor" && failureInfo(source.message, model).transient;
  const entries = [...event.entries, { type: "context_edit", targetId: source.id, replacement: null }];

  if (explain) {
    entries.push({
      type: "custom_message",
      customType: "pi-rotator/rescue-note",
      content: rescueNote(pending, source.message),
      display: false,
      details: { from: pending.from, to: pending.to, modelId: pending.modelId },
    });
  }

  return { entries, continue: true };
}


export async function onResponse(pi, dir, state, event, ctx) {
  const model = event?.model ?? state.requests.get(sessionIdOf(ctx)) ?? ctx?.model;
  const family = model ? familyOf(state, model.provider) : null;
  const status = event ? event.status : undefined;
  const action = classifyResponse(status);

  // Pre-guard by design: with the debug log on, a missing line means the
  // hook never fired, while model/family nulls mean it fired without
  // routing context. Either way the turn's missing drain is explainable
  // from this one line.
  traceResponse(state, dir, model, family, status, action);

  if (!model || !family) return;
  const { session } = sessionState(family, ctx);

  if (action === "record") {
    // Drain counts served requests; rotation itself happens per turn.
    recordTurn(family.drained, session.warm, model.provider, Date.now());

    return;
  }

  if (action === "skip") return; // transient error: neither drain nor switch

  // OpenAI standard/priority share rate and billing limits. Claude fast
  // capacity is separate; a tier denial must not retire its standard slot.
  const cooldownKey = responseCooldownKey(status, model, session);

  await rescue(pi, dir, state, family, model, session, ctx, cooldownKey);
}


// A turn Pi core failed before any provider request (auth resolution,
// unknown model): the request/response hooks never fire, so the agent_end
// messages are the only signal. failureMessage carries stopReason "error"
// plus the failed provider; "aborted" is a user cancel and never counts.
function failedTurn(event, model) {
  const messages = event ? event.messages : null;

  if (!Array.isArray(messages)) return null;
  // agent_end includes earlier retry attempts. Only the terminal assistant
  // result can establish a failed activity; a later success/abort supersedes it.
  const failure = messages.findLast(message => message?.stopReason);

  if (failure?.stopReason !== "error") return null;

  return failureInfo(failure, model);
}

// Transport deaths (cursor runs that stall, lose their bridge or end without
// turnEnded) are transient flakes, not quota: rescuable with a short bench so
// one flake cannot bench an account for hours. Never triggered by quota text
// (checked first) or anything abort-flavored (user cancels never rescue).
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

function failureInfo(failure, model) {
  const slot = failure.provider ?? (model ? model.provider : null);
  const text = failure.errorMessage || "";
  const exhausted = /\bHTTP\s+(?:401|402|403|429)\b|usage[_\s-]*limit|insufficient[_\s-]*quota|quota.{0,30}(?:exceed|exhaust)|(?:exceed|exhaust).{0,30}quota|rate[_\s-]*limit|too many requests|credit balance.{0,30}(?:low|exhaust)/i.test(text);

  return {
    slot,
    modelId: failure.model ?? model?.id,
    unauthorized: /\bHTTP\s+401\b/i.test(text),
    fastRejected: fastTierError(text),
    exhausted,
    transient: !exhausted && !/abort/i.test(text) && /\bstalled\b|\btimed?\s?out\b|ended before turnEnded|bridge connection lost|no upstream frames|no useful output|connect error/i.test(text),
    message: String(
      failure.errorMessage === undefined || failure.errorMessage === null
        ? "turn error"
        : failure.errorMessage,
    ).slice(0, 160),
  };
}


// turn_end runs after the assistant stream and its tools finish. The host
// awaits this handoff before preparing the next model request in a long run.
// Errors still use agent_end recovery; manual handoffs must not rotate twice.
export async function onAssistantTurnEnd(pi, dir, state, event, ctx) {
  const model = ctx?.model;
  const family = model && familyOf(state, model.provider);
  const message = event?.message;

  if (family?.strategy !== "round-robin" || !successfulAssistant(message, model)) return;
  const { session } = sessionState(family, ctx);

  await serializeHandoff(session, ctx, () => {
    if (ctx?.model?.provider !== model.provider || ctx.model.id !== model.id) return;
  
    return switchModel(pi, dir, state, family, model.provider, model, session, "rotate", ctx, session.recovery?.attempted);
  });
}


// Run-end bookkeeping and recovery also cover failures before any request.
// Balanced chooses at this boundary; round-robin already chose at turn_end.
export async function onTurnEnd(pi, dir, state, event, ctx) {
  state.requests.delete(sessionIdOf(ctx));
  const { model, family, session } = routingContext(state, ctx);

  // A fingerprinted-but-cold serving slot means its response was never
  // recorded: backfill the warmth it earned (never the drain it didn't).
  const backfilled = backfillWarmth(family, session, model);

  // Turn boundary, journaled unconditionally: the unit drain is analyzed
  // in, and proof the hook fires with (or without) a model attached.
  traceTurn(dir, model, backfilled);

  // Failed turns cool their slot (it cannot serve right now) across every
  // strategy including failover; the normal rotation below then moves away
  // from it. Foreign slots journal as evidence without cooling.
  const failure = turnFailure(event, model, family);

  if (failure) {
    const { ours, cooldownKey } = coolFailedTurn(dir, state, family, session, model, failure);
    // Keep confirmed HTTP handoffs; a 200 stream can still carry quota errors.
    const disposition = failureDisposition(session, model, failure, ours, cooldownKey);

    if (disposition === "handled") return;

    if (disposition === "rescue") {
      await rescue(pi, dir, state, family, { ...model, provider: failure.slot }, session, ctx, cooldownKey);

      return;
    }
  }

  if (!shouldRotate(model, family, failure)) return;
  await serializeHandoff(session, ctx, () => {
    if (ctx?.model?.provider !== model.provider || ctx.model.id !== model.id) return;
  
    return switchModel(pi, dir, state, family, model.provider, model, session, "rotate", ctx);
  });
}
