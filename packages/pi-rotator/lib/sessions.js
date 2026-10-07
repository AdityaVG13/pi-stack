import { effectiveTtlMs } from "./ttl.js";
import { fastCapability, fastCooldownKey } from "./fast.js";
import { isCooling } from "./store.js";
import { parseSlotId } from "./slots.js";
import { routeTurn } from "./router.js";


export function familyOf(state, providerId) {
  const slot = parseSlotId(providerId);

  if (!slot) return null;
  const family = state.families.get(slot.base);

  if (!family || family.status !== "active") return null;

  return family;
}


// Warmth and fingerprint history are per-session: prefixes belong to a
// transcript, while drain and cooldowns are per-account (global). Two
// sessions sharing a process must never read each other's warmth.
export function sessionIdOf(ctx) {
  try {
    return ctx.sessionManager.getSessionId() || "default";
  } catch {
    return "default";
  }
}


export function sessionState(family, ctx) {
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


export function peekSession(family, ctx) {
  return family.sessions.get(sessionIdOf(ctx)) || null;
}


// Cache retention tier, mirroring core: short unless PI_CACHE_RETENTION=long.
function retentionOf() {
  return process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}


export function ttlFor(family, model) {
  return effectiveTtlMs(model, family.ttlMs, retentionOf());
}


export function pickNext(family, session, model, excludeCurrent, excluded) {
  // One clock per decision: the cooling checks and the router share this
  // instant instead of sampling Date.now() three times.
  const now = Date.now();
  // Observed fast usage only: an explicitly selected fast model, or a tier
  // this session already requested through Pi-native or upstream shaping.

  const checkFast = fastCapability(model).kind === "native" ||
    session?.fastRequests?.has(fastCooldownKey(model.provider, model.id));

  const base = (id) => excluded?.has(id) || isCooling(family.cooldowns, id, now) ||
    (checkFast && isCooling(family.cooldowns, fastCooldownKey(id, model.id), now));

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
