// Stay on the session's warm serving slot; spend drain only at cold boundaries.
//
// Only the slot that served this session's latest turn holds the session's
// current prefix. Every other slot holds a stale one (it lacks the turns
// served elsewhere), and pi-ai re-serializes assistant messages whose
// provider id differs from the request's (thinking -> plain text, signatures
// dropped), so a mid-session switch rewrites the conversation from the first
// such message. Live repro (2026-09-24, Opus, two slots): A->B->A read 8,088
// and rewrote the B turn, vs 8,211 read / 18 written staying on A.
//
// So: a warm, healthy current slot is kept. When it is cold (TTL passed),
// cooling (exhausted), or its warmth was cleared (compaction, model change),
// the least-drained healthy slot wins, slot order breaking ties. Drain still
// spreads, at the boundaries where a rewrite is paid anyway.
//
// lastActive: this session's slot -> last served time. current: the slot
// that served the latest turn (null when unknown).
function isWarmCurrent(slots, lastActive, isCooling, now, ttlMs, current) {
  return current != null && slots.includes(current) && !isCooling(current) &&
    now - (lastActive.get(current) || 0) < ttlMs;
}

export function pickBalanced(slots, lastActive, drained, isCooling, now, ttlMs, current) {
  if (isWarmCurrent(slots, lastActive, isCooling, now, ttlMs, current)) return { id: current, warm: true };

  let pick = null;
  let least = Infinity;

  for (const id of slots) {
    if (isCooling(id)) continue;
    const used = drained.get(id) || 0;

    if (used < least) {
      pick = id;
      least = used;
    }
  }

  return pick ? { id: pick, warm: false } : null;
}
