// Wire-prefix fingerprints: content hashes of the provider request payload.
//
// The fingerprint is what lets analysis PROVE prefix identity: the same turn
// served on two slots must hash equal, because rotation ships identical
// bytes. The projection strips volatile envelope keys (chain pointers, ids,
// timestamps) and keeps everything else, so schema drift can only add
// content, never silently drop it. Projection version is journaled with
// every hash so analysis never compares across projections.
import { createHash } from "node:crypto";

export const PROJECTION = "v1";

// Pointer-shaped keys: per-request/per-slot envelope, never prompt content.
// Transcript content (roles, text, tool names, arguments — including model-
// returned call ids, which are transcript-fixed once served) is kept.
// Exported: journal comparability depends on this exact set, so the suite
// pins its membership and strips every member in a loop.
export const VOLATILE_KEYS = new Set([
  "previous_response_id",
  "request_id",
  "response_id",
  "message_id",
  "item_id",
  "timestamp",
  "created",
  "created_at",
  "session_id",
  "trace_id",
  "span_id",
  "id",
]);

export function stableStringify(value) {
  if (value === null || value === undefined) return "null";

  if (value instanceof Function) return "null";

  // Explicit lambda: passing stableStringify bare would inherit map's
  // (element, index, array) arguments if the signature ever grows.
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  // instanceof misses null-prototype objects, which are still dictionaries.
  if (value instanceof Object || Object.getPrototypeOf(value) === null) {
    const keys = Object.keys(value).filter((k) => !VOLATILE_KEYS.has(k)).sort();

    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }

  // Total: BigInt and other unstringifiable values fall back to String
  // instead of throwing the fingerprint (and the turn's warmth) away.
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

export function fingerprintPayload(payload) {
  const text = stableStringify(payload ?? null);
  const fp = createHash("sha256").update(text, "utf8").digest("hex");

  return { fp, len: text.length, projection: PROJECTION };
}

// Compaction collapses the transcript: a sharp shrink of an already-sizable
// payload means the prefix was rebuilt, so the session's warmth is stale.
export function looksLikeCompaction(prevLen, len) {
  return prevLen > 4000 && len < prevLen * 0.5;
}

// Classify a consecutive payload pair on one slot within one session.
// Compaction and model changes invalidate the session's warmth (new prefix /
// new cache namespace). Mid-transcript rewrites are drift (see below) and
// stay journal-only: the most-recent slot still holds the longest common
// prefix, so warmth keeps applying.
export function detectInvalidation(prev, next, prevModelId, modelId) {
  const modelChanged = Boolean(prevModelId && modelId && prevModelId !== modelId);

  if (!prev) return { compacted: false, modelChanged };
  const compacted = looksLikeCompaction(prev.len, next.len);

  return { compacted, modelChanged };
}

// One short hash per transcript message. Structural comparison of two
// consecutive signature lists separates append-growth (common prefix covers
// the whole previous list) from drift (history was rewritten: context edit,
// pruning, compaction keeping a tail).
export function messageSignatures(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.map((message) =>
    createHash("sha256").update(stableStringify(message), "utf8").digest("hex").slice(0, 16),
  );
}

export function detectDrift(prevSig, nextSig) {
  if (!prevSig) return { drift: false, position: 0, common: 0 };
  const prev = prevSig;
  const next = nextSig || [];
  let common = 0;

  while (common < prev.length && common < next.length && prev[common] === next[common]) {
    common += 1;
  }

  return { drift: common < prev.length, position: common, common };
}
