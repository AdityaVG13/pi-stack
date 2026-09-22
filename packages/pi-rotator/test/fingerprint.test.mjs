import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PROJECTION,
  VOLATILE_KEYS,
  detectDrift,
  detectInvalidation,
  fingerprintPayload,
  looksLikeCompaction,
  messageSignatures,
  stableStringify,
} from "../lib/fingerprint.js";

function fpOf(payload) {
  return fingerprintPayload(payload);
}

describe("fingerprint", () => {
  it("serializes a fixed input to a golden string", () => {
    // Hand-derived: keys sorted, volatile keys stripped at every depth.
    const input = {
      model: "gpt-5.5",
      request_id: "req-1",
      input: [
        { role: "user", text: "hi", message_id: "m1" },
        { text: "again", role: "user" },
      ],
      previous_response_id: "resp-aaa",
    };

    assert.equal(
      stableStringify(input),
      '{"input":[{"role":"user","text":"hi"},{"role":"user","text":"again"}],'
        + '"model":"gpt-5.5"}',
    );
    // The projection must stay parseable: external analysis reads it back.
    assert.doesNotThrow(() => JSON.parse(stableStringify(input)));
    assert.doesNotThrow(() => JSON.parse(stableStringify({ a: [{ b: [1, { c: null }] }] })));
  });

  it("pins the hash pipeline end to end", () => {
    // Tripwire, not truth: any projection/denylist/hash change must flip
    // this hex AND bump PROJECTION, never silently. Journaled fingerprints
    // are only comparable within one projection.
    assert.equal(fpOf({ model: "gpt-5.5", input: ["hi"] }).projection, PROJECTION);
    assert.equal(
      fpOf({ model: "gpt-5.5", input: ["hi"] }).fp,
      "5ca572917695ba49052d97bcf24ee45ce0743206b0686e763008295fb99d4dfa",
    );
  });

  it("is deterministic across key order and hashes the projection", () => {
    const a = { model: "gpt-5.5", input: [{ role: "user", text: "hi" }] };
    const b = { input: [{ text: "hi", role: "user" }], model: "gpt-5.5" };

    assert.equal(stableStringify(a), stableStringify(b));
    assert.equal(fpOf(a).fp, fpOf(b).fp);
    // Independent derivation: fp is the sha256 hex of the projection.
    assert.equal(
      fpOf(a).fp,
      createHash("sha256").update(stableStringify(a), "utf8").digest("hex"),
    );
    assert.equal(fpOf(a).len, stableStringify(a).length);
    // Chunked hashing must encode astral characters identically: chunks are
    // whole tokens, never split strings, so surrogate pairs stay intact —
    // including a lone surrogate, which UTF-8 replaces deterministically.
    const astral = { text: "emoji-safe 🧠 café", lone: "a\uD800b" };

    assert.equal(
      fpOf(astral).fp,
      createHash("sha256").update(stableStringify(astral), "utf8").digest("hex"),
    );
    assert.equal(fpOf(astral).len, stableStringify(astral).length);
  });

  it("pins the volatile denylist membership exactly", () => {
    assert.deepEqual(
      [...VOLATILE_KEYS].sort(),
      [
        "created",
        "created_at",
        "id",
        "item_id",
        "message_id",
        "previous_response_id",
        "request_id",
        "response_id",
        "session_id",
        "span_id",
        "timestamp",
        "trace_id",
      ],
    );
  });

  it("strips every volatile key but keeps content", () => {
    for (const key of VOLATILE_KEYS) {
      const a = { model: "gpt-5.5", input: ["hi"], [key]: "one" };
      const b = { model: "gpt-5.5", input: ["hi"], [key]: "two" };

      assert.equal(fpOf(a).fp, fpOf(b).fp, `key ${key} must not affect the hash`);
    }

    const c = { model: "gpt-5.5", input: ["hi"] };
    const d = { model: "gpt-5.5", input: ["bye"] };

    assert.notEqual(fpOf(c).fp, fpOf(d).fp);
  });

  it("keeps transcript-fixed pointer content like call ids", () => {
    const a = { input: [{ type: "function_call", call_id: "c1", name: "read" }] };
    const b = { input: [{ type: "function_call", call_id: "c2", name: "read" }] };

    assert.notEqual(fpOf(a).fp, fpOf(b).fp);
  });

  it("treats arrays as ordered and nullish as null", () => {
    assert.notEqual(
      stableStringify({ input: [1, 2] }),
      stableStringify({ input: [2, 1] }),
    );
    assert.equal(stableStringify(undefined), "null");
    assert.equal(fpOf(null).len > 0, true);
  });

  it("nulls functions and projects null-prototype objects", () => {
    assert.equal(stableStringify(() => {}), "null");
    assert.equal(stableStringify(async () => {}), "null");
    assert.equal(
      stableStringify(Object.assign(Object.create(null), { id: "x", text: "hi" })),
      '{"text":"hi"}',
    );
    assert.equal(stableStringify("hi"), '"hi"');
    assert.equal(stableStringify(7), "7");
  });

  it("falls back to String for unstringifiable values", () => {
    assert.equal(stableStringify(10n), "10");
    assert.equal(fpOf({ n: 10n }).len > 0, true);
  });

  it("infers compaction from a sharp shrink of a sizable payload", () => {
    assert.equal(looksLikeCompaction(10000, 4000), true);
    assert.equal(looksLikeCompaction(10000, 6000), false);
    assert.equal(looksLikeCompaction(3000, 1000), false);
    assert.equal(looksLikeCompaction(10000, 12000), false);
  });

  it("pins the compaction boundary as strict", () => {
    assert.equal(looksLikeCompaction(10000, 4999), true);
    assert.equal(looksLikeCompaction(10000, 5000), false);
    assert.equal(looksLikeCompaction(4000, 1000), false);
    assert.equal(looksLikeCompaction(4001, 1000), true);
  });

  it("detectInvalidation classifies pairs and model changes", () => {
    const big = { system: "s".repeat(5000), input: ["one"] };
    const grown = { system: "s".repeat(5000), input: ["one", "two"] };
    const small = { system: "tiny", input: ["one"] };

    assert.deepEqual(
      detectInvalidation(fpOf(big), fpOf(grown), "gpt-5.5", "gpt-5.5"),
      { compacted: false, modelChanged: false },
    );
    assert.deepEqual(
      detectInvalidation(fpOf(big), fpOf(small), "gpt-5.5", "gpt-5.5"),
      { compacted: true, modelChanged: false },
    );
    assert.deepEqual(
      detectInvalidation(fpOf(big), fpOf(grown), "gpt-5.5", "gpt-5.6"),
      { compacted: false, modelChanged: true },
    );
    assert.deepEqual(
      detectInvalidation(null, fpOf(big), null, "gpt-5.5"),
      { compacted: false, modelChanged: false },
    );
  });

  it("message signatures separate append-growth from drift", () => {
    const m1 = { role: "user", content: "hi" };
    const m2 = { role: "assistant", content: "hello" };
    const m3 = { role: "user", content: "more" };
    const prev = messageSignatures([m1, m2]);

    assert.equal(prev.length, 2);
    assert.deepEqual(
      detectDrift(prev, messageSignatures([m1, m2, m3])),
      { drift: false, position: 2, common: 2 },
    );

    const edited = { role: "assistant", content: "CHANGED" };
    const drifted = detectDrift(prev, messageSignatures([m1, edited, m3]));

    assert.equal(drifted.drift, true);
    assert.equal(drifted.position, 1);
    assert.equal(drifted.common, 1);
  });

  it("detectDrift handles first sight and truncation", () => {
    const sig = messageSignatures([{ role: "user", content: "hi" }]);

    assert.deepEqual(detectDrift(null, sig), { drift: false, position: 0, common: 0 });
    assert.deepEqual(detectDrift(sig, null), { drift: true, position: 0, common: 0 });
    assert.deepEqual(messageSignatures(null), []);
    assert.deepEqual(messageSignatures(42), []);
    assert.deepEqual(messageSignatures("nope"), []);
    assert.equal(messageSignatures([null, "x", 42]).length, 3);

    const long = messageSignatures([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);

    const truncated = detectDrift(long, messageSignatures([{ role: "assistant", content: "b" }]));

    assert.equal(truncated.drift, true);
    assert.equal(truncated.position, 0);
  });
});
