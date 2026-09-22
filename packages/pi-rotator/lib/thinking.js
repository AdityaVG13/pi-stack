// Thinking-level preservation across switches. A setModel that changes the
// model id resets the host's thinking level (medium silently becomes off),
// so the switch path snapshots the live level first and restores it after
// the switch lands. Mirrors upstream's getThinkingLevel/setThinkingLevel
// pair; older hosts without either API simply report unsupported.

export function snapshotThinkingLevel(pi) {
  try {
    return pi?.getThinkingLevel?.();
  } catch {
    return undefined;
  }
}

// Outcomes: skipped (nothing to preserve), unsupported (no setter),
// failed (setter threw), kept (already equal, no write — every skipped
// write is a footer re-render that never happens), restored (verified
// equal), unverified (no reader to confirm), clamped (host applied a
// different level).
export async function restoreThinkingLevel(pi, before) {
  if (before === undefined) return "skipped";

  if (pi?.setThinkingLevel == null) return "unsupported";

  if (snapshotThinkingLevel(pi) === before) return "kept";

  try {
    await pi.setThinkingLevel(before);
  } catch {
    return "failed";
  }

  const after = snapshotThinkingLevel(pi);

  if (after === undefined) return "unverified";

  return after === before ? "restored" : "clamped";
}

// Next-request repair triage. target is the pre-switch level, baseline the
// read-back right after the switch. Repair only when the live level still
// equals that baseline (nobody touched it since); anything else is either
// already correct (hold) or a deliberate change we must not stomp (adopt).
// An unreadable live level always adopts: no blind writes.
export function repairDecision(live, target, baseline) {
  if (live === undefined) return "adopt";

  if (live === target) return "hold";

  if (live === baseline) return "repair";

  return "adopt";
}
