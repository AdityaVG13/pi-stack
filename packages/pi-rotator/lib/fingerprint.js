// Canonical projected-request fingerprints, not proofs of identical wire bytes.
// v2 drops volatile keys only at the request root and preserves all transcript
// and schema keys. Compare hashes only within the same projection version;
// cryptographic collision freedom is an assumption, not established here.
import { createHash } from "node:crypto";

export const PROJECTION = "v2";

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

function canonicalJson(value, stripEnvelope) {
  if (value === null) return "null";

  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, false)).join(",")}]`;

  if (value instanceof Object) {
    const keys = Object.keys(value).filter((key) => !stripEnvelope || !VOLATILE_KEYS.has(key)).sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], false)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function stableStringify(value, stripEnvelope = true) {
  // Match JSON's omitted fields, sparse arrays and toJSON behavior. Cycles
  // and BigInt fail explicitly instead of colliding with fabricated content.
  const wire = JSON.stringify(value) ?? "null";

  return canonicalJson(JSON.parse(wire), stripEnvelope);
}

export function fingerprintPayload(payload) {
  const text = stableStringify(payload ?? null);
  const fp = createHash("sha256").update(text, "utf8").digest("hex");

  return { fp, len: Buffer.byteLength(text, "utf8"), projection: PROJECTION };
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
    createHash("sha256").update(stableStringify(message, false), "utf8").digest("hex").slice(0, 16),
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
