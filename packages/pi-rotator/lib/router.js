import { pickFailover, pickRoundRobin } from "./strategy.js";
import { pickBalanced } from "./balanced.js";

// Single strategy dispatch. Pure: every input arrives as an argument so the
// routing decision stays unit-testable and the Pi edge in index.js stays thin.
export function routeTurn(slots, strategy, isCooling, current, lastActive, drained, rrIndex, now, ttlMs) {
  if (strategy === "round-robin") {
    // A restored session or manual selection can disagree with the cursor.
    // Advance from the account that actually served, including the first turn.
    const currentIndex = slots.indexOf(current);
    const pick = pickRoundRobin(slots, isCooling, currentIndex < 0 ? rrIndex : currentIndex);

    if (!pick) return null;

    return { provider: pick.id, rrIndex: pick.index, warm: null };
  }

  if (strategy === "balanced") {
    const pick = pickBalanced(slots, lastActive, drained, isCooling, now, ttlMs, current);

    if (!pick) return null;

    return { provider: pick.id, rrIndex, warm: pick.warm };
  }

  const provider = pickFailover(slots, isCooling, current);

  if (!provider) return null;

  return { provider, rrIndex, warm: null };
}
