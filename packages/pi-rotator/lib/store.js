import { appendFileSync } from "node:fs";
import { join } from "node:path";

export function debugLogPath(agentDir) {
  return join(agentDir, "pi-rotator-debug.log");
}

export function journalPath(agentDir) {
  return join(agentDir, "pi-rotator-journal.jsonl");
}

// Credential-free JSONL: ids, models, and truncated reasons only. Never log
// auth entries, tokens, or request bodies through here.
export function appendDebug(agentDir, kind, fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), kind, ...fields }) + "\n";

  try {
    appendFileSync(debugLogPath(agentDir), line);
  } catch {
    // The debug log is cosmetic; a failed write must not break rotation.
  }
}

// Decision journal: one line per request and per routing decision, with the
// wire-prefix fingerprint that lets analysis verify prefix identity and
// cache behavior after the fact. Hashes and counts only — never bodies.
export function appendJournal(agentDir, kind, fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), kind, ...fields }) + "\n";

  try {
    appendFileSync(journalPath(agentDir), line);
  } catch {
    // Evidence loss must not break rotation.
  }
}

export function isCooling(cooldowns, id, now) {
  const until = cooldowns.get(id);

  return until !== undefined && until > now;
}

export function markCooling(cooldowns, id, until) {
  cooldowns.set(id, until);
}

export function pruneCooldowns(cooldowns, now) {
  for (const [id, until] of cooldowns) {
    if (until <= now) cooldowns.delete(id);
  }
}

export function recordTurn(drained, lastActive, id, now) {
  drained.set(id, (drained.get(id) || 0) + 1);
  lastActive.set(id, now);
}

// Statuses that retire a slot mid-turn: rate/quota exhaustion plus the
// billing and auth failures that mean this slot cannot serve at all.
export const EXHAUSTED_STATUS = new Set([429, 402, 403]);

// One decision per provider response, journaled by the caller. Only a real
// 1xx-3xx status is evidence of service: 0/null/undefined mean the host
// reported nothing usable, so the turn ends without drain rather than with
// a fabricated one (warmth still backfills from the request fingerprint).
export function classifyResponse(status) {
  if (Number.isInteger(status) && status >= 100 && status < 400) return "record";

  if (EXHAUSTED_STATUS.has(status)) return "exhausted";

  return "skip";
}

// Response-hook misses happen (turn 1 of the live benchmark): the request
// was fingerprinted but no response was ever recorded, so the warmth stamp
// for a provably-served slot can be backfilled at the turn boundary. A
// cleared fingerprint (model change, compaction) never backfills — that
// cold state is deliberate, not a missed observation.
export function needsBackfill(session, slot) {
  if (!session) return false;

  return session.fingerprints.has(slot) && !session.warm.has(slot);
}

// Per-session routing state expires after a day idle: warmth and fingerprint
// history belong to a live transcript, not to the process.
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

export function pruneSessions(sessions, now, idleMs) {
  const limit = idleMs || SESSION_IDLE_MS;

  for (const [id, session] of sessions) {
    if (now - (session.lastSeen || 0) > limit) sessions.delete(id);
  }
}
