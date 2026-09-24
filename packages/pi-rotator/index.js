// pi-rotator entry: multi-account rotation for every provider family.
//
// Two modes. Transport mode (pi-multi-account installed with routing off):
// IT owns alias registration (logins, catalogs, the cursor transport) and
// this package only routes — which is what lets cursor rotate without a
// vendored transport. Standalone mode: aliases are cloned from pi-ai
// builtins for families nobody else registered.
//
// Integration points (the same ones pi-multi-account proved out):
//   - exhaustion detection via HTTP status or a finalized quota error
//   - confirmed switches via pi.setModel, keeping the model id
//   - context-only recovery via agent_before_settle (no synthetic user input)
// One command: /rotator status | next | rediscover.
//
// Rotation is per-(provider, model): every slot serves the identical model id
// and prompt (no per-account shaping), so each account holds a hot prefix and
// reuse inside TTL is a hit. See README "even drain, warm caches".
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { discoverFamilies, nextFreeSlot, parseSlotId } from "./lib/slots.js";
import { builtinBase, loadBuiltinModule, registerAlias } from "./lib/clone.js";
import { routeTurn } from "./lib/router.js";
import { effectiveTtlMs } from "./lib/ttl.js";
import { findRivals, findTransport } from "./lib/rivals.js";
import { isTransportFamily, readTransportConfig, resolveMode } from "./lib/transport.js";
import {
  detectDrift,
  detectInvalidation,
  fingerprintPayload,
  messageSignatures,
} from "./lib/fingerprint.js";
import {
  appendDebug,
  appendJournal,
  classifyResponse,
  isCooling,
  markCooling,
  needsBackfill,
  pruneCooldowns,
  pruneSessions,
  recordTurn,
} from "./lib/store.js";
import {
  repairDecision,
  restoreThinkingLevel,
  snapshotThinkingLevel,
} from "./lib/thinking.js";
import { CODEX_BASE, defaultCodexModels, registerCodexSlot } from "./lib/codex.js";

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));

function agentDir() {
  return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readJson(dir, file) {
  const path = join(dir, file);

  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function safeOn(pi, event, handler) {
  try {
    pi.on(event, async (payload, ctx) => {
      try {
        return await handler(payload, ctx);
      } catch (error) {
        appendDebug(agentDir(), "handler_error", {
          event,
          message: String((error && error.message) || error).slice(0, 200),
        });
      }
    });
  } catch {
    // Older hosts may lack pi.on; rotation degrades to manual /rotator next.
  }
}

function familyOf(state, providerId) {
  const slot = parseSlotId(providerId);

  if (!slot) return null;
  const family = state.families.get(slot.base);

  if (!family || family.status !== "active") return null;

  return family;
}

// Routine debug chatter honors config.debugLog; the evidence journal never
// does, and neither do errors and warnings (handler_error, standby, and
// transport_warn keep calling appendDebug directly).
function debugLine(state, dir, kind, fields) {
  if (state.config.debugLog !== false) appendDebug(dir, kind, fields);
}

// Warmth and fingerprint history are per-session: prefixes belong to a
// transcript, while drain and cooldowns are per-account (global). Two
// sessions sharing a process must never read each other's warmth.
function sessionIdOf(ctx) {
  try {
    return ctx.sessionManager.getSessionId() || "default";
  } catch {
    return "default";
  }
}

function sessionState(family, ctx) {
  const id = sessionIdOf(ctx);
  let session = family.sessions.get(id);

  if (!session) {
    session = {
      warm: new Map(),
      fingerprints: new Map(),
      msgSig: null,
      lastModelId: null,
      lastSeen: 0,
    };
    family.sessions.set(id, session);
  }

  session.lastSeen = Date.now();

  return { id, session };
}

function peekSession(family, ctx) {
  return family.sessions.get(sessionIdOf(ctx)) || null;
}

// Cache retention tier, mirroring core: short unless PI_CACHE_RETENTION=long.
function retentionOf() {
  return process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}

function ttlFor(family, model) {
  return effectiveTtlMs(model, family.ttlMs, retentionOf());
}

function pickNext(family, session, model, excludeCurrent, excluded) {
  // One clock per decision: the cooling checks and the router share this
  // instant instead of sampling Date.now() three times.
  const now = Date.now();
  const base = (id) => excluded?.has(id) || isCooling(family.cooldowns, id, now);

  const cooling = excludeCurrent
    ? (id) => id === model.provider || base(id)
    : base;

  const routed = routeTurn(
    family.slots,
    family.strategy,
    cooling,
    model.provider,
    session ? session.warm : new Map(),
    family.drained,
    family.rrIndex,
    now,
    ttlFor(family, model),
  );

  if (!routed) return null;
  family.rrIndex = routed.rrIndex;

  return { provider: routed.provider, id: model.id, warm: routed.warm };
}

function registerFamilySlots(pi, dir, state, base, slots, builtinModule, viaTransport) {
  // Transport-owned families are route-only: the transport registered every
  // alias, and re-registering would clobber its defs. This is also what lets
  // extension-transport families (cursor) rotate — routing is
  // transport-agnostic, only registration needs the factory.
  if (viaTransport) return { ok: true, slots: [...slots], via: "transport" };
  const registered = [];
  let sawClone = false;
  let sawDeclared = false;

  for (const id of slots) {
    if (id === base) {
      registered.push(id);
      continue; // the native/extension registration owns slot 1
    }

    const n = parseSlotId(id).n;
    const baseDef = builtinModule ? builtinBase(builtinModule, base) : null;
    let how = "none";
    let attempted = false;

    if (baseDef) {
      attempted = true;

      try {
        registerAlias(pi, baseDef, id, n);
        how = "clone";
      } catch (error) {
        debugLine(state, dir, "clone_failed", {
          id,
          message: String((error && error.message) || error).slice(0, 160),
        });
      }
    }

    // Declared-def fallback, Codex only (pi-ai OAuth bridge, lib/codex.js).
    if (how === "none" && base === CODEX_BASE) {
      attempted = true;

      try {
        registerCodexSlot(pi, id, defaultCodexModels(), import.meta.url);
        how = "declared";
      } catch (error) {
        debugLine(state, dir, "register_failed", {
          id,
          message: String((error && error.message) || error).slice(0, 160),
        });
      }
    }

    if (how === "none") {
      return {
        ok: false,
        reason: attempted ? "alias registration rejected" : "no pi-ai builtin factory",
        registered,
      };
    }

    if (how === "declared") sawDeclared = true;
    else sawClone = true;
    registered.push(id);
    debugLine(state, dir, "slot_registered", { id, how });
  }

  const via = sawClone && sawDeclared ? "mixed" : sawDeclared ? "declared" : "clone";

  return { ok: true, slots: registered, via };
}

function rediscover(pi, dir, state) {
  const auth = readJson(dir, "auth.json");

  const { module: builtinModule, error: builtinError } = loadBuiltinModule(
    import.meta.url,
    ENTRY_DIR,
  );

  if (builtinError) debugLine(state, dir, "builtin_registry", { error: builtinError });
  const seen = new Set();

  for (const { base, slots } of discoverFamilies(auth)) {
    seen.add(base);
    let family = state.families.get(base);

    if (!family) {
      family = {
        base,
        slots: [],
        cooldowns: new Map(),
        drained: new Map(),
        sessions: new Map(),
        ttlMs: state.config.ttlByFamily[base] || state.config.ttlMs,
        strategy: state.config.strategy,
        rrIndex: -1,
        status: "pending",
        reason: null,
        via: null,
      };
      state.families.set(base, family);
    }

    const viaTransport = state.mode === "transport" && isTransportFamily(base);
    const result = registerFamilySlots(pi, dir, state, base, slots, builtinModule, viaTransport);

    if (result.ok) {
      family.slots = result.slots;
      family.status = "active";
      family.reason = null;
      family.via = result.via;
    } else {
      // Roll back partial aliases so a broken family leaves no residue.
      // Only ids registered just above — never the family's older slots,
      // and never the base (natively owned, only listed, not registered).
      for (const id of result.registered || []) {
        if (id === base) continue;

        try {
          pi.unregisterProvider(id);
        } catch {
          // Best effort; a stale alias is cosmetic until restart.
        }
      }

      family.slots = slots;
      family.status = "unsupported";
      family.reason = result.reason;
    }

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
function resolveTarget(ctx, provider, id) {
  try {
    const found = ctx?.modelRegistry?.find?.(provider, id);

    if (found) return { target: found, full: true };
  } catch {
    // Fall through to the bare pair.
  }

  return { target: { provider, id }, full: false };
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

async function applySwitch(pi, dir, state, family, from, provider, id, ctx, announce) {
  const thinking = state.lastThinking;
  const { target, full } = resolveTarget(ctx, provider, id);

  debugLine(state, dir, "switch_target", { to: `${provider}/${id}`, full });

  try {
    const ok = await pi.setModel(target);

    if (ok === false) {
      debugLine(state, dir, "switch_rejected", { from, to: `${provider}/${id}` });
      appendJournal(dir, "switch_rejected", { family: family.base, from, to: provider });

      return false;
    }

    if (thinking !== undefined) {
      state.pendingThinking = { target: thinking, baseline: ASSUMED_HOST_RESET };
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

// Registry verification: never route into a slot Pi cannot serve, or the
// next turn dies with "Provider is not configured" (a pre-hook auth
// failure no extension hook can observe). getProvider answers
// "registered?" and hasConfiguredAuth answers "credential resolves?" —
// both sync, both side-effect-free. Anything missing or throwing means
// an older host: pass through (current behavior) rather than inventing
// failures. Only an exact false fails, matching the config polarity.
function verifySlot(ctx, slotId) {
  try {
    const registry = ctx ? ctx.modelRegistry : null;

    if (!registry) return { ok: true };

    if (
      registry.getProvider != null &&
      registry.getProvider(slotId) === undefined
    ) {
      return { ok: false, reason: "unregistered" };
    }

    if (registry.hasConfiguredAuth != null) {
      let authed = true;

      try {
        authed = registry.hasConfiguredAuth({ provider: slotId }) !== false;
      } catch {
        authed = true;
      }

      if (!authed) return { ok: false, reason: "unauthorized" };
    }

    return { ok: true };
  } catch {
    return { ok: true };
  }
}

async function switchModel(pi, dir, state, family, from, model, session, reason, ctx, excluded) {
  // Verify-then-switch with retry: a picked slot Pi cannot serve is cooled
  // (existing exclusion machinery, self-heals on expiry) and the next
  // candidate is tried. Bounded by slot count; all-dead stays put.
  for (let attempt = 0; attempt <= family.slots.length; attempt++) {
    if (ctx?.signal?.aborted) return false;
    const picked = pickNext(family, session, model, false, excluded);

    if (!picked || picked.provider === from) return false;
    const check = verifySlot(ctx, picked.provider);

    if (!check.ok) {
      excluded?.add(picked.provider);
      markCooling(family.cooldowns, picked.provider, Date.now() + state.config.cooldownMs);
      appendJournal(dir, "slot_skipped", {
        family: family.base,
        from,
        to: picked.provider,
        reason: check.reason,
      });
      continue;
    }

    debugLine(state, dir, reason, { from, to: `${picked.provider}/${picked.id}`, warm: picked.warm });
    appendJournal(dir, "route", {
      family: family.base,
      from,
      to: picked.provider,
      model: picked.id,
      reason,
      warm: picked.warm,
      drained: Object.fromEntries(family.drained),
    });

    // Automatic rotations only: manual `/rotator next` already confirms via
    // its panel, so it calls applySwitch without the flag and never double-
    // notifies. Manual is also an explicit force: it bypasses verification.
    const landed = await applySwitch(
      pi,
      dir,
      state,
      family,
      from,
      picked.provider,
      picked.id,
      ctx,
      state.config.announceSwitches === true,
    );

    if (landed) return picked.provider;
    excluded?.add(picked.provider);
    markCooling(family.cooldowns, picked.provider, Date.now() + state.config.cooldownMs);
  }

  return false;
}

// One-shot repair for a switch that lost the thinking level: runs on the
// next request, after every post-switch host reset has settled. Repairs
// only untouched loss (repairDecision); a deliberate user change between
// the switch and this request is adopted, never stomped. Async by design:
// the current request proceeds as-is, all future turns run repaired.
function repairThinking(pi, dir, state) {
  const pending = state.pendingThinking;

  if (pending === undefined) return;
  state.pendingThinking = undefined;
  const live = snapshotThinkingLevel(pi);
  const decision = repairDecision(live, pending.target, pending.baseline);

  if (decision !== "repair") {
    debugLine(state, dir, `thinking_${decision}`, {
      live: live === undefined ? null : live,
      target: pending.target,
    });

    return;
  }

  void restoreThinkingLevel(pi, pending.target).then((outcome) => {
    appendJournal(dir, "thinking_repair", {
      target: pending.target,
      observed: live,
      outcome,
    });
  });
}

// Observe-only: fingerprint the outgoing wire payload for the journal.
// Returns nothing and mutates nothing on the request path — Pi owns the
// payload, we only hash it. Also triages any pending thinking repair from
// the last switch (repairThinking): thinking is global, so this runs for
// every request regardless of family. The request context also carries the
// live thinking level: captured here as the next switch's repair target,
// so the switch path itself never touches the thinking API.
function onBeforeRequest(pi, dir, state, event, ctx) {
  repairThinking(pi, dir, state);

  if (ctx?.thinkingLevel) state.lastThinking = ctx.thinkingLevel;
  const model = ctx ? ctx.model : null;

  if (!model) return;
  const family = familyOf(state, model.provider);

  if (!family) return;
  const { id: sessionId, session } = sessionState(family, ctx);

  // A real request consumes the handoff, including retries already owned by
  // Pi. Keep the attempted-account budget until the next user activity.
  if (session.recovery) session.recovery.pending = null;
  const next = fingerprintPayload(event ? event.payload : null);
  const prev = session.fingerprints.get(model.provider) || null;

  session.fingerprints.set(model.provider, next);

  const { compacted, modelChanged } = detectInvalidation(
    prev,
    next,
    session.lastModelId,
    model.id,
  );

  session.lastModelId = model.id;

  if (modelChanged) {
    // New model, new cache namespace: rebuild warmth from scratch (the next
    // boundary is a free drain choice). Old fingerprints go (the backfill must never
    // mistake this deliberate cold state for a missed response); the
    // just-set current one stays as fresh-namespace evidence.
    session.warm.clear();
    session.fingerprints.clear();
    session.fingerprints.set(model.provider, next);
  } else if (compacted) {
    // Fresh prefix for this session: its warmth is stale, least-drained wins.
    session.warm.clear();
  }

  const now = Date.now();
  const ttlMs = ttlFor(family, model);

  appendJournal(dir, "request", {
    family: family.base,
    session: String(sessionId).slice(0, 8),
    slot: model.provider,
    model: model.id,
    fp: next.fp,
    len: next.len,
    prevLen: prev ? prev.len : null,
    compacted,
    modelChanged,
    projection: next.projection,
    ttlMs,
    warm: now - (session.warm.get(model.provider) || 0) < ttlMs,
    drainedTurns: family.drained.get(model.provider) || 0,
    ctxThinking: ctx?.thinkingLevel || null,
  });
}

// Structural drift watch: consecutive transcript signatures separate normal
// append-growth from history rewrites (context edits, pruning). Journal-only
// by design — the most-recent slot still holds the longest common prefix.
// Returns undefined so the transcript passes through untouched.
function onContext(dir, state, event, ctx) {
  const model = ctx ? ctx.model : null;

  if (!model) return;
  const family = familyOf(state, model.provider);

  if (!family) return;
  const { id: sessionId, session } = sessionState(family, ctx);
  const next = messageSignatures(event ? event.messages : null);
  const { drift, position, common } = detectDrift(session.msgSig, next);

  session.msgSig = next;

  if (!drift) return;
  appendJournal(dir, "drift", {
    family: family.base,
    session: String(sessionId).slice(0, 8),
    slot: model.provider,
    position,
    common,
    messages: next.length,
  });
}

// The host's own compaction signal for this session: the prefix was rebuilt,
// so the session's warmth and fingerprint history is stale. Primary signal;
// the shrink heuristic in onBeforeRequest stays as backup for external edits.
function onCompact(dir, state, ctx) {
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
function onWarmDecision(dir, state, event, ctx) {
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

// Cooldowns are shared across turns; attempted slots additionally bound this
// activity even if a cooldown expires while Pi is retrying or running tools.
async function rescue(pi, dir, state, family, model, session, ctx) {
  if (!session.recovery || session.recovery.modelId !== model.id) {
    session.recovery = { modelId: model.id, attempted: new Set(), pending: null };
  }

  const recovery = session.recovery;
  const pending = { from: model.provider, to: null, modelId: model.id };

  recovery.attempted.add(model.provider);
  recovery.pending = pending;
  markCooling(family.cooldowns, model.provider, Date.now() + state.config.cooldownMs);
  pending.to = await switchModel(
    pi, dir, state, family, model.provider, model, session, "exhausted", ctx, recovery.attempted,
  );
}

function resetRecovery(state, ctx) {
  for (const family of state.families.values()) {
    const session = peekSession(family, ctx);

    if (session) session.recovery = null;
  }
}

// Pi's own retries and queued work run before this boundary. Only if the
// failed request is still the tail do we omit that attempt from model context
// and request one context-only continuation. Raw history and completed tools
// are retained; no new user message or prompt shaping is needed.
function onBeforeSettle(dir, state, event, ctx) {
  const model = ctx?.model;
  const family = model && familyOf(state, model.provider);
  const recovery = family && peekSession(family, ctx)?.recovery;
  const pending = recovery?.pending;

  if (!pending) return;
  recovery.pending = null;

  if (event?.outcome !== "error" || ctx?.signal?.aborted ||
      !pending.to || model.provider !== pending.to || model.id !== pending.modelId) return;
  const tail = event.context?.contextEntries?.findLast(entry => entry.messages.length > 0);
  const message = tail?.messages.at(-1);
  const source = tail?.sourceEntry;

  if (source?.type !== "message" || !source.id || message?.role !== "assistant" || message.stopReason !== "error" ||
      message.provider !== pending.from || message.model !== pending.modelId) return;
  appendJournal(dir, "resume", {
    family: family.base, from: pending.from, to: pending.to, model: pending.modelId,
    session: String(sessionIdOf(ctx)).slice(0, 8),
  });

  return {
    entries: [...event.entries, { type: "context_edit", targetId: source.id, replacement: null }],
    continue: true,
  };
}

async function onResponse(pi, dir, state, event, ctx) {
  const model = ctx ? ctx.model : null;
  const family = model ? familyOf(state, model.provider) : null;
  const status = event ? event.status : undefined;
  const action = classifyResponse(status);

  // Pre-guard by design: with the debug log on, a missing line means the
  // hook never fired, while model/family nulls mean it fired without
  // routing context. Either way the turn's missing drain is explainable
  // from this one line.
  debugLine(state, dir, "response", {
    slot: model ? model.provider : null,
    status: status === undefined ? null : status,
    action,
    family: family ? family.base : null,
  });

  if (!model || !family) return;
  const { session } = sessionState(family, ctx);

  if (action === "record") {
    // Drain counts served requests; rotation itself happens per turn.
    recordTurn(family.drained, session.warm, model.provider, Date.now());

    return;
  }

  if (action === "skip") return; // transient error: neither drain nor switch

  await rescue(pi, dir, state, family, model, session, ctx);
}

// A turn Pi core failed before any provider request (auth resolution,
// unknown model): the request/response hooks never fire, so the agent_end
// messages are the only signal. failureMessage carries stopReason "error"
// plus the failed provider; "aborted" is a user cancel and never counts.
function failedTurn(event, model) {
  const messages = event ? event.messages : null;

  if (!Array.isArray(messages)) return null;
  const failure = messages.find((m) => m && m.stopReason === "error");

  if (!failure) return null;

  const slot = failure.provider ?? (model ? model.provider : null);

  return {
    slot,
    modelId: failure.model ?? model?.id,
    exhausted: /usage[_\s-]*limit|insufficient[_\s-]*quota|quota.{0,30}(?:exceed|exhaust)|(?:exceed|exhaust).{0,30}quota|rate[_\s-]*limit|too many requests|credit balance.{0,30}(?:low|exhaust)/i.test(failure.errorMessage || ""),
    message: String(
      failure.errorMessage === undefined || failure.errorMessage === null
        ? "turn error"
        : failure.errorMessage,
    ).slice(0, 160),
  };
}

// Per-turn rotation: every request of a turn stays on one slot, and any
// switch lands before the next turn starts. Failover never rotates here by design.
async function onTurnEnd(pi, dir, state, event, ctx) {
  const model = ctx ? ctx.model : null;
  const family = model ? familyOf(state, model.provider) : null;

  const session = family ? sessionState(family, ctx).session : null;

  // A fingerprinted-but-cold serving slot means its response was never
  // recorded: backfill the warmth it earned (never the drain it didn't).
  const backfilled = Boolean(
    family && family.strategy !== "failover" && session && model && needsBackfill(session, model.provider),
  );

  if (backfilled) session.warm.set(model.provider, Date.now());

  // Turn boundary, journaled unconditionally: the unit drain is analyzed
  // in, and proof the hook fires with (or without) a model attached.
  appendJournal(dir, "turn", {
    slot: model ? model.provider : null,
    model: model ? model.id : null,
    backfill: backfilled ? model.provider : null,
  });

  // Failed turns cool their slot (it cannot serve right now) across every
  // strategy including failover; the normal rotation below then moves away
  // from it. Foreign slots journal as evidence without cooling.
  const failure = model && family ? failedTurn(event, model) : null;

  if (failure) {
    const ours = failure.slot !== null && family.slots.includes(failure.slot);

    if (ours) markCooling(family.cooldowns, failure.slot, Date.now() + state.config.cooldownMs);
    appendJournal(dir, "turn_failed", {
      family: family.base,
      slot: failure.slot,
      message: failure.message,
      cooled: ours,
    });

    // Keep the confirmed HTTP handoff instead of rotating past it. Streaming
    // providers can also report quota failure in a 200 response body.
    if (ours && failure.modelId === model.id) {
      if (session.recovery?.pending?.from === failure.slot) return;

      if (failure.exhausted) {
        await rescue(pi, dir, state, family, { ...model, provider: failure.slot }, session, ctx);

        return;
      }
    }
  }

  if (!model || !family || family.strategy === "failover") return;
  await switchModel(pi, dir, state, family, model.provider, model, session, "rotate", ctx);
}

function slotLine(family, session, id, now, ttlMs) {
  const until = family.cooldowns.get(id);
  const cooling = until !== undefined && until > now;

  if (cooling) return `  ${id}: cooling ${Math.ceil((until - now) / 60000)}m`;
  const turns = family.drained.get(id) || 0;
  const warm = session && now - (session.warm.get(id) || 0) < ttlMs;

  return `  ${id}: ${turns} turns · ${warm ? "warm" : "cold"}`;
}

function statusText(dir, state, config, ctx) {
  const now = Date.now();
  const auth = readJson(dir, "auth.json");
  const families = [...state.families.values()];

  const lines = [
    `pi-rotator: ${state.config.strategy} · ${families.length} families · ttl ${Math.round(state.config.ttlMs / 60000)}m · ${state.mode}`,
  ];

  if (state.transportWarn) {
    lines.push("warning: multi-account onlyActive is on — hidden slots may reject switches");
  }

  for (const family of families) {
    if (family.status !== "active") {
      lines.push(`${family.base}: unsupported (${family.reason})`);
      continue;
    }

    const session = peekSession(family, ctx);
    const model = ctx ? ctx.model : null;
    const slot = model ? parseSlotId(model.provider) : null;
    const inFamily = model && slot && slot.base === family.base;
    const ttlMs = ttlFor(family, inFamily ? model : null);

    const via = family.via && family.via !== "clone" ? ` · ${family.via}` : "";

    lines.push(`${family.base}: ${family.slots.length} slots · ttl ${Math.round(ttlMs / 60000)}m${via}`);

    for (const id of family.slots) {
      lines.push(slotLine(family, session, id, now, ttlMs));
    }

    lines.push(`  next free slot for /login: ${nextFreeSlot(auth, family.base)}`);
  }

  lines.push(`cooldown: ${Math.round(config.cooldownMs / 60000)}m`);

  return lines.join("\n");
}

// Command output must be SHOWN, not returned: hosts ignore string results.
// A persistent widget above the editor beats the transient notify flash;
// notify stays as the fallback for hosts without setWidget.
function showText(ctx, text) {
  const body = String(text);

  try {
    if (ctx?.ui?.setWidget != null) {
      ctx.ui.setWidget("pi-rotator", body.split("\n"), { placement: "aboveEditor" });

      return body;
    }
  } catch {
    // Fall through to notify.
  }

  try {
    if (ctx?.ui?.notify != null) {
      ctx.ui.notify(body, "info");
    }
  } catch {
    // Cosmetic; the debug log still has everything.
  }

  return body;
}

function hideWidget(ctx) {
  try {
    if (ctx?.ui?.setWidget != null) {
      ctx.ui.setWidget("pi-rotator", undefined);
    }
  } catch {
    // Cosmetic.
  }
}

function onCommand(pi, dir, state, config, raw, ctx) {
  const sub = String(Array.isArray(raw) ? raw[0] : raw || "")
    .trim()
    .split(/\s+/, 1)[0];

  if (sub === "hide") {
    hideWidget(ctx);

    return "pi-rotator: panel hidden.";
  }

  if (sub === "next") {
    const model = ctx ? ctx.model : null;
    const family = model ? familyOf(state, model.provider) : null;
    const session = family ? sessionState(family, ctx).session : null;
    const picked = family ? pickNext(family, session, model, true) : null;

    if (!picked) return showText(ctx, "pi-rotator: no other healthy slot to switch to.");
    appendJournal(dir, "route", {
      family: family.base,
      from: model.provider,
      to: picked.provider,
      model: picked.id,
      reason: "manual",
      warm: picked.warm,
      drained: Object.fromEntries(family.drained),
    });
    applySwitch(pi, dir, state, family, model.provider, picked.provider, picked.id, ctx);

    return showText(ctx, `pi-rotator: switching to ${picked.provider}/${picked.id}`);
  }

  if (sub === "rediscover") {
    const families = rediscover(pi, dir, state);

    const summary = [...families.values()].map(
      (family) => `${family.base}×${family.slots.length}${family.status === "active" ? "" : ` (${family.status})`}`,
    );

    return showText(ctx, `pi-rotator: tracking ${summary.join(", ") || "no families"}.`);
  }

  return showText(ctx, statusText(dir, state, config, ctx));
}

function standbyText(rivals) {
  return [
    `pi-rotator: STANDBY — conflicting balancer installed (${rivals.join(", ")}).`,
    "Two routers would fight over setModel with split cooldown state.",
    "Uninstall the other balancer and restart Pi to activate pi-rotator.",
  ].join("\n");
}

function standbyTransportText() {
  return [
    "pi-rotator: STANDBY — pi-multi-account routing is still on.",
    "Two routers would fight over setModel with split cooldown state.",
    'Set "enabled": false in ~/.pi/agent/provider-failover.json and restart Pi:',
    "multi-account keeps the transports (login, catalogs, cursor), rotator routes.",
  ].join("\n");
}

export default function piRotator(pi) {
  const dir = agentDir();
  const config = loadConfig(dir);

  if (!config.enabled) return;
  const settings = readJson(dir, "settings.json") || {};
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const rivals = findRivals(packages);
  const transport = readTransportConfig(dir);

  const mode = resolveMode({
    transportPresent: findTransport(packages),
    routingOff: transport.routingOff,
    rivals,
  });

  if (mode === "standby-rivals") {
    appendDebug(dir, "standby", { rivals });
    pi.registerCommand("rotator", {
      description: "pi-rotator is on standby (conflicting balancer installed)",
      handler: (_raw, ctx) => showText(ctx, standbyText(rivals)),
    });

    return;
  }

  if (mode === "standby-transport") {
    appendDebug(dir, "standby", { reason: "transport-routing-on" });
    pi.registerCommand("rotator", {
      description: "pi-rotator is on standby (transport routing still on)",
      handler: (_raw, ctx) => showText(ctx, standbyTransportText()),
    });

    return;
  }

  const state = {
    families: new Map(),
    config,
    mode,
    transportWarn: mode === "transport" && transport.onlyActive,
    pendingThinking: undefined,
    lastThinking: undefined,
  };

  if (state.transportWarn) {
    appendDebug(dir, "transport_warn", { onlyActive: true });
  }

  safeOn(pi, "session_start", () => rediscover(pi, dir, state));
  safeOn(pi, "before_agent_start", (_event, ctx) => resetRecovery(state, ctx));
  safeOn(pi, "agent_before_settle", (event, ctx) => onBeforeSettle(dir, state, event, ctx));
  safeOn(pi, "context_with_system", (event, ctx) => onContext(dir, state, event, ctx));
  safeOn(pi, "before_provider_request", (event, ctx) => onBeforeRequest(pi, dir, state, event, ctx));
  safeOn(pi, "after_provider_response", (event, ctx) => onResponse(pi, dir, state, event, ctx));
  safeOn(pi, "agent_end", (event, ctx) => onTurnEnd(pi, dir, state, event, ctx));
  safeOn(pi, "session_compact", (_event, ctx) => onCompact(dir, state, ctx));
  safeOn(pi, "cache_warming_decision", (event, ctx) => onWarmDecision(dir, state, event, ctx));
  pi.registerCommand("rotator", {
    description: "Multi-account rotation: status | next | rediscover | hide",
    handler: (raw, ctx) => onCommand(pi, dir, state, config, raw, ctx),
  });
}
