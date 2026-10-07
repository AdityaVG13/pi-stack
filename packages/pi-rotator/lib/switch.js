import { appendJournal, markCooling } from "./store.js";
import { debugLine } from "./support.js";
import { fastCapability, fastCooldownKey } from "./fast.js";
import { familyOf, pickNext, sessionIdOf, sessionState } from "./sessions.js";
import { parseSlotId } from "./slots.js";
import { repairDecision, restoreThinkingLevel, snapshotThinkingLevel } from "./thinking.js";


// setModel reports false when the target is unknown or unauthenticated
// (transport never registered the alias, slot hidden, creds revoked).
// Journal the rejection: the route was decided but never happened.
// The host resets the thinking level on a model-id change (observed: always
// to off), so the pre-switch level stays pending until the next request
// triages it — see repairThinking. The switch path itself makes ZERO
// thinking calls, by hard-won evidence: any get/setThinkingLevel contact
// around setModel corrupts the next turn's setup (bisected live: 4 turns
// errored after switch-path contact, 0 after contact-free switches, and
// the pre-thinking benchmark never errored). The target comes from the
// request context (free, settled, no host call); the baseline is the
// observed reset default, assumed without reading. Settled reads and
// writes inside repairThinking are proven safe.
const ASSUMED_HOST_RESET = "off";


// Switch targets prefer the registry's full model object over a bare
// {provider, id} pair (upstream's exact pattern). A bare pair leaves Pi's
// current-model def unresolved (footer `?/0`, then `reading 'includes'`
// on the next turn); the full object carries the def inline so no
// resolution is needed. Falls back to the bare pair when the registry is
// missing, throws, or has no entry — degraded but never fatal.
//
// Unified listing hides sibling catalogs, so a hidden slot has no entry of
// its own. Same model id on another family slot is the same model served
// elsewhere: reuse that def with the serving provider rewritten. Auth and
// transport still resolve by the target provider id at request time.
export function resolveTarget(ctx, provider, id, slots = []) {
  const find = slot => {
    try {
      return ctx?.modelRegistry?.find?.(slot, id);
    } catch {
      return undefined;
    }
  };

  const direct = find(provider);

  if (direct) return { target: direct, full: true };
  const base = parseSlotId(provider)?.base;

  for (const slot of [base, ...slots]) {
    if (!slot || slot === provider) continue;
    const def = find(slot);

    if (def) return { target: servingDef(def, provider), full: true };
  }

  return { target: { provider, id }, full: false };
}

// A sibling def carries its own account label ("Name (account 2)"); serving
// under another slot must relabel it, or displays name the wrong login.
// Identity (provider/id/api) is untouched; only the alias suffix follows.
const ALIAS_SUFFIX = / \(account \d+\)$/;

function servingDef(def, provider) {
  const target = { ...def, provider };

  if (target.name?.constructor !== String || !ALIAS_SUFFIX.test(target.name)) return target;
  const n = parseSlotId(provider)?.n ?? 1;

  target.name = target.name.replace(ALIAS_SUFFIX, n === 1 ? "" : ` (account ${n})`);

  return target;
}


// Rotation notices are opt-in (announceSwitches) and cosmetic: a missing
// or throwing host UI never touches the switch that just landed.
function notifySwitch(ctx, from, to) {
  try {
    ctx?.ui?.notify?.(`pi-rotator: ${from} → ${to}`, "info");
  } catch {
    // Cosmetic.
  }
}


// Native registration starts an asynchronous host availability refresh. A
// resolvable credential may precede the synchronous eligibility snapshot.
// Await only the target's public offline refresh; never bypass native auth.
function isAborted(ctx, result) {
  return result?.aborted || ctx?.signal?.aborted;
}

function needsAuthRefresh(registry, provider) {
  return registry?.getRegisteredNativeProvider?.(provider) && registry.refresh && registry.hasConfiguredAuth &&
    registry.hasConfiguredAuth({ provider }) === false;
}

function refreshFailed(result, provider) {
  return result?.errors?.has(provider);
}

async function synchronizeSlotAuth(ctx, provider) {
  if (isAborted(ctx)) throw new Error("Account availability refresh cancelled");
  const registry = ctx?.modelRegistry;

  if (!needsAuthRefresh(registry, provider)) return;
  let result;

  try {
    result = await registry.refresh({ providers: [provider], allowNetwork: false, signal: ctx?.signal });
  } catch {
    throw new Error("Account availability refresh failed");
  }

  if (isAborted(ctx, result)) throw new Error("Account availability refresh cancelled");

  if (refreshFailed(result, provider)) throw new Error("Account availability refresh failed");
}

function selectionOf(ctx) {
  return { provider: ctx?.model?.provider, id: ctx?.model?.id, session: sessionIdOf(ctx) };
}

function sameSelection(ctx, expected) {
  const live = selectionOf(ctx);

  return live.provider === expected.provider && live.id === expected.id && live.session === expected.session;
}

export async function applySwitch(pi, dir, state, family, from, provider, id, ctx, announce) {
  const selection = selectionOf(ctx);
  const thinking = ctx?.thinkingLevel ?? (state.lastThinking?.session === selection.session ? state.lastThinking.level : undefined);

  try {
    await synchronizeSlotAuth(ctx, provider);

    // Availability yields to user/session changes and may replace model metadata.
    if (!sameSelection(ctx, selection)) return false;

    const { target, full } = resolveTarget(ctx, provider, id, family?.slots);

    debugLine(state, dir, "switch_target", { to: `${provider}/${id}`, full });
    const ok = await pi.setModel(target);

    if (ok === false) {
      debugLine(state, dir, "switch_rejected", { from, to: `${provider}/${id}` });
      appendJournal(dir, "switch_rejected", { family: family.base, from, to: provider });

      return false;
    }

    if (thinking !== undefined) {
      state.pendingThinking = { target: thinking, baseline: ASSUMED_HOST_RESET, selection: { session: selection.session, provider, id } };
    }

    appendJournal(dir, "thinking", {
      family: family.base,
      from,
      to: provider,
      before: thinking === undefined ? null : thinking,
      applied: null,
      outcome: thinking === undefined ? "skipped" : "deferred",
    });

    // Landed switches only: rejections and throws return above, so an
    // announcement always names a switch that happened.
    if (announce === true) notifySwitch(ctx, from, provider);

    return true;
  } catch (error) {
    // A throwing setModel never switches: journal it, or the route entry
    // above claims a switch that never happened.
    appendJournal(dir, "switch_error", {
      family: family.base,
      from,
      to: provider,
      message: String((error && error.message) || error).slice(0, 160),
    });

    return false;
  }
}


// Pi core's virtual-model api id (virtual-models.js). Sessions holding a
// virtual selection belong to another router; restore repair reads the
// marker but never routes those branches.
const VIRTUAL_MODEL_API = "pi-virtual";

function lastModelChangeBefore(branch, before) {
  for (let i = before - 1; i >= 0; i -= 1) {
    const entry = branch[i];

    if (entry?.type === "model_change" && entry.provider && entry.modelId) return { provider: entry.provider, modelId: entry.modelId };
  }

  return undefined;
}

// Session restore reads the branch, not the listing: the last model_change
// wins, else the latest assistant response (which names its physical
// serving id). Mirrors core getBranchSelection for physical models.
// Malformed entries are skipped, never thrown on: branch data is
// host-owned and may predate any schema.
export function branchSelection(branch, getModel) {
  if (!Array.isArray(branch)) return undefined;

  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];

    if (entry?.type === "model_change") {
      if (entry.provider && entry.modelId) return { provider: entry.provider, modelId: entry.modelId };

      continue;
    }

    const message = entry?.type === "message" ? entry.message : undefined;

    if (message?.role !== "assistant" || message.api === VIRTUAL_MODEL_API) continue;

    if (!message.provider || !message.model) continue;
    const change = lastModelChangeBefore(branch, i);
    let held;

    try {
      held = change && getModel?.(change.provider, change.modelId);
    } catch {
      held = undefined;
    }

    // A virtual model that is no longer registered does not hold.
    return held && held.api === VIRTUAL_MODEL_API ? change : { provider: message.provider, modelId: message.model };
  }

  return undefined;
}

// Unified listing hides sibling catalogs, so core session restore cannot
// resolve a branch that ended on a hidden slot and falls back to the
// default model instead. Repair that exact case at session start: the
// branch implies a family slot, the live selection differs, the implied id
// is unlisted, and a sibling slot resolves it. Everything else — listed
// ids, foreign providers, virtual selections, unknown models — is left to
// core. Runs through applySwitch so thinking defers down the proven
// pending-repair path instead of touching the thinking API here.
export async function repairHiddenRestore(pi, dir, state, ctx) {
  let branch;

  try {
    branch = ctx?.sessionManager?.getBranch?.();
  } catch {
    return "no-branch";
  }

  if (!Array.isArray(branch)) return "no-branch";

  if (branch.length === 0) return "empty-branch";

  const getModel = (provider, modelId) => {
    try {
      return ctx?.modelRegistry?.find?.(provider, modelId);
    } catch {
      return undefined;
    }
  };

  const implied = branchSelection(branch, getModel);

  if (!implied) return "no-selection";
  const live = ctx?.model;

  if (live?.provider === implied.provider && live?.id === implied.modelId) return "aligned";
  const family = familyOf(state, implied.provider);

  if (!family || !family.slots.includes(implied.provider)) return "foreign";

  if (getModel(implied.provider, implied.modelId)) return "listed";

  if (!resolveTarget(ctx, implied.provider, implied.modelId, family.slots).full) return "unknown-model";
  const { session } = sessionState(family, ctx);
  const selection = selectionOf(ctx);

  return serializeHandoff(session, ctx, async () => {
    if (!sameSelection(ctx, selection)) return "moved";
    const from = ctx?.model?.provider ?? implied.provider;
    const landed = await applySwitch(pi, dir, state, family, from, implied.provider, implied.modelId, ctx);

    if (!landed) return "failed";
    appendJournal(dir, "route", {
      family: family.base, from, to: implied.provider, model: implied.modelId,
      reason: "hidden-restore", warm: null, drained: Object.fromEntries(family.drained),
    });

    return "repaired";
  });
}


// Registry verification: never route into a slot Pi cannot serve, or the
// next turn dies with "Provider is not configured" (a pre-hook auth
// failure no extension hook can observe). getProvider answers
// "registered?" and hasConfiguredAuth answers "credential resolves?" —
// both sync, both side-effect-free. Anything missing or throwing means
// an older host: pass through (current behavior) rather than inventing
// failures. Only an exact false fails, matching the config polarity.
function configuredAuth(registry, slotId) {
  if (registry.hasConfiguredAuth == null) return true;

  try {
    return registry.hasConfiguredAuth({ provider: slotId }) !== false;
  } catch {
    return true;
  }
}

async function verifySlot(ctx, slotId) {
  try {
    await synchronizeSlotAuth(ctx, slotId);
  } catch {
    return { ok: false, reason: "availability" };
  }

  try {
    const registry = ctx ? ctx.modelRegistry : null;

    if (!registry) return { ok: true };

    if (
      registry.getProvider != null &&
      registry.getProvider(slotId) === undefined
    ) {
      return { ok: false, reason: "unregistered" };
    }

    if (!configuredAuth(registry, slotId)) return { ok: false, reason: "unauthorized" };

    return { ok: true };
  } catch {
    return { ok: true };
  }
}


function traceRoute(dir, state, family, from, picked, reason) {
  debugLine(state, dir, reason, { from, to: `${picked.provider}/${picked.id}`, warm: picked.warm });
  appendJournal(dir, "route", {
    family: family.base, from, to: picked.provider, model: picked.id, reason,
    warm: picked.warm, drained: Object.fromEntries(family.drained),
  });
}

function eligiblePick(picked, from) {
  return picked && picked.provider !== from;
}

function rejectSlot(dir, state, family, from, picked, check, excluded) {
  excluded?.add(picked.provider);
  markCooling(family.cooldowns, picked.provider, Date.now() + state.config.cooldownMs);
  appendJournal(dir, "slot_skipped", { family: family.base, from, to: picked.provider, reason: check.reason });
}

function coolFailedSwitch(state, family, model, picked, excluded) {
  excluded?.add(picked.provider);

  const cooldownKey = fastCapability(model).kind === "native"
    ? fastCooldownKey(picked.provider, model.id) : picked.provider;

  markCooling(family.cooldowns, cooldownKey, Date.now() + state.config.cooldownMs);
}

async function attemptVerifiedSwitch(context, picked) {
  const { pi, dir, state, family, from, model, reason, ctx, excluded, selection } = context;
  const check = await verifySlot(ctx, picked.provider);

  if (isAborted(ctx) || !sameSelection(ctx, selection)) return false;

  if (!check.ok) {
    rejectSlot(dir, state, family, from, picked, check, excluded);

    return undefined;
  }

  traceRoute(dir, state, family, from, picked, reason);
  const landed = await applySwitch(pi, dir, state, family, from, picked.provider, picked.id, ctx, state.config.announceSwitches);

  if (landed) return picked.provider;

  if (isAborted(ctx) || !sameSelection(ctx, selection)) return false;

  coolFailedSwitch(state, family, model, picked, excluded);

  return undefined;
}

export async function switchModel(pi, dir, state, family, from, model, session, reason, ctx, excluded) {
  const context = { pi, dir, state, family, from, model, reason, ctx, excluded, selection: selectionOf(ctx) };
  // Undefined retries; false terminates; a provider id reports the committed target.

  for (let attempt = 0; attempt <= family.slots.length; attempt++) {
    if (isAborted(ctx) || !sameSelection(ctx, context.selection)) return false;

    const picked = pickNext(family, session, model, false, excluded);

    if (!eligiblePick(picked, from)) return false;
    const result = await attemptVerifiedSwitch(context, picked);

    if (result !== undefined) return result;
  }

  return false;
}

// One-shot repair for a switch that lost the thinking level: runs on the
// next request, after every post-switch host reset has settled. Repairs
// only untouched loss (repairDecision); a deliberate user change between
// the switch and this request is adopted, never stomped. Async by design:
// the current request proceeds as-is, all future turns run repaired.
export function repairThinking(pi, dir, state, ctx) {
  const pending = state.pendingThinking;

  if (pending === undefined) return;

  // A mismatched request must not consume the deferred repair: thinking is
  // process-global, but the snapshot belongs to one session/model. Dropping
  // it here left the switched session stuck at the host reset.
  if (!sameSelection(ctx, pending.selection)) return;

  state.pendingThinking = undefined;
  const live = snapshotThinkingLevel(pi);
  const decision = repairDecision(live, pending.target, pending.baseline);

  if (decision !== "repair") {
    debugLine(state, dir, `thinking_${decision}`, {
      live: live === undefined ? null : live,
      target: pending.target,
    });

    return decision;
  }

  // The request context still carries the host reset; that is not a new
  // preference. Future switches must snapshot the restored target.
  state.lastThinking = { level: pending.target, session: pending.selection.session };

  void restoreThinkingLevel(pi, pending.target).then((outcome) => {
    appendJournal(dir, "thinking_repair", {
      target: pending.target,
      observed: live,
      outcome,
    });
  });

  return decision;
}


// Cooldowns are shared across turns; attempted slots additionally bound this
// activity even if a cooldown expires while Pi is retrying or running tools.
// Keep manual and recovery handoffs ordered even when commands overlap hooks.
export function serializeHandoff(session, ctx, operation) {
  const owner = sessionIdOf(ctx);
  // Predecessors may change models, but queued work cannot follow a new session.
  const run = () => sessionIdOf(ctx) === owner ? operation() : undefined;
  const pending = session.handoff ? session.handoff.then(run, run) : Promise.resolve(run());

  session.handoff = pending;

  return pending.finally(() => {
    if (session.handoff === pending) session.handoff = null;
  });
}
