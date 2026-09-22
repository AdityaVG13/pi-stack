// Least-drained slot whose cache is still warm; cold only when all cooled.
//
// Two spread mechanisms. (1) Onboarding: slots with no prefix for this
// session yet go first, paying one cold miss each to bring every account
// hot. Without it the just-used slot is always warmest and rotation sticks
// forever — every rapid turn on one account, zero drain. (2)
// Least-drained among warm, which degrades to round-robin once all slots
// are hot. Drain is counted in served turns (the response hook carries no
// token usage; session files do, but only post-hoc).
//
// served: ids that already served this session (own a prefix for it). Any
// object with .has works; null/undefined disables onboarding (the pre-fix
// behavior, kept for the other strategies' call path).
export function pickBalanced(slots, lastActive, drained, isCooling, now, ttlMs, served) {
  let onboardPick = null;
  let warmPick = null;
  let warmDrained = Infinity;
  let coldPick = null;
  let coldDrained = Infinity;

  for (const id of slots) {
    if (isCooling(id)) continue;
    const used = drained.get(id) || 0;
    const warm = now - (lastActive.get(id) || 0) < ttlMs;

    if (served != null && served.has instanceof Function && !served.has(id) && !onboardPick) {
      onboardPick = id;
    }

    if (warm && used < warmDrained) {
      warmPick = id;
      warmDrained = used;
    }

    if (!warm && used < coldDrained) {
      coldPick = id;
      coldDrained = used;
    }
  }

  // Onboarding is definitionally a cold miss; journaled as such.
  if (onboardPick) return { id: onboardPick, warm: false };

  if (warmPick) return { id: warmPick, warm: true };

  if (coldPick) return { id: coldPick, warm: false };

  return null;
}
