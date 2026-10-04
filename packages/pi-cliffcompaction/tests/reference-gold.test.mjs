/**
 * Bit-level conformance against the Python reference implementation
 * (nguyenvuthientrang/cliffcompaction) on shared fixtures.
 *
 * OpenAI Chat Completions tool_calls.arguments are a JSON *string*.
 * Python's test util dumps that string with default separators (": "),
 * ours with JSON.stringify (":"). The algorithm passes the string
 * through; only that fixture encoding differs. We compare o10.summary
 * after normalizing object-separator spaces.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compact } from "../lib/cliff.ts";
import { makeConfig } from "../lib/config.ts";
import { DIALECT as ANTHROPIC } from "../lib/dialects/anthropic.ts";
import { SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { DIALECT as OPENAI } from "../lib/dialects/openai-chat.ts";
import { Engine, billableChars, estimateTokens } from "../lib/engine.ts";
import { chainHashes } from "../lib/hashing.ts";
import { MAX_IMAGE_TOKENS, tokensForPayload } from "../lib/images.ts";
import { canonicalJson, dumpsDefault } from "../lib/json.ts";
import { aBody, aSession, oSession } from "./util.mjs";

const gold = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "reference-gold.json"), "utf8"),
);

function pngBytes(w, h) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    Buffer.from([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]),
    Buffer.from([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]),
    Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
  ]);
}

function dataUri(raw) {
  return "data:image/png;base64," + raw.toString("base64");
}

function compactJsonSpaces(s) {
  return s.replace(/": /g, '":');
}

describe("Python reference gold", () => {
  it("matches canonical JSON and the anthropic hash chain", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), gold.canon_obj);
    const msgs = aSession(4);
    const digests = [];

    for (const m of msgs) {
      digests.push(ANTHROPIC.digestMessage(m));
    }

    assert.equal(digests[0], gold.digest0);
    assert.deepEqual(chainHashes(digests), gold.chain4);
  });

  it("matches compact() on a 10-turn Anthropic session", () => {
    const res = compact(aSession(10), ANTHROPIC, makeConfig({ keepRecent: 2 }));

    assert.equal(res.headLen, gold.a10.head_len);
    assert.equal(res.cut, gold.a10.cut);
    assert.equal(res.messages.length, gold.a10.n);
    assert.equal(res.messages[1].content, gold.a10.summary);
    assert.deepEqual(res.messages.slice(2).map((m) => m.role), gold.a10.tail_roles);
  });

  it("matches truncated tool signatures", () => {
    const res = compact(aSession(6), ANTHROPIC, makeConfig({ keepRecent: 1, cmdMaxChars: 20 }));

    assert.equal(res.messages[1].content, gold.a6_cmd20_summary);
  });

  it("matches OpenAI compact structure; summary differs only by JSON spacing in stored arguments", () => {
    const res = compact(oSession(10), OPENAI, makeConfig({ keepRecent: 2 }));

    assert.equal(res.headLen, gold.o10.head_len);
    assert.equal(res.cut, gold.o10.cut);
    assert.equal(res.messages.length, gold.o10.n);
    assert.equal(compactJsonSpaces(res.messages[2].content), compactJsonSpaces(gold.o10.summary));
  });

  it("matches billable chars, dumps length, and token estimate", () => {
    const body = aBody(aSession(10));

    assert.equal(dumpsDefault(body).length, gold.dumps_len);
    assert.equal(billableChars(body), gold.billable_body);
    assert.equal(estimateTokens(body), gold.est_tokens);
  });

  it("matches Engine.prepare on an over-threshold session", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 2000, keepRecent: 1 }));
    const ctx = eng.prepare(aBody(aSession(10)), ANTHROPIC);

    const summary = ctx.substituted.find(
      (m) => m.role === "user" && String(m.content).startsWith(SUMMARY_HEADER),
    ).content;

    assert.equal(ctx.compacted, gold.engine.compacted);
    assert.equal(ctx.modified, gold.engine.modified);
    assert.equal(ctx.substituted.length, gold.engine.n_out);
    assert.equal(ctx.estTokensIn, gold.engine.est_in);
    assert.equal(ctx.estTokensOut, gold.engine.est_out);
    assert.equal(ctx.baseCut, gold.engine.base_cut);
    assert.equal(ctx.baseHead, gold.engine.base_head);
    assert.equal(summary, gold.engine.summary);
  });

  it("matches the published visual-token table", () => {
    assert.equal(MAX_IMAGE_TOKENS, gold.max_image_tokens);

    for (const [w, h, expected] of gold.image_tokens) {
      assert.equal(tokensForPayload(dataUri(pngBytes(w, h))), expected);
    }
  });
});
