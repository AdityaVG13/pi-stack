import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeConfig } from "../lib/config.ts";
import { DIALECT as ANTHROPIC } from "../lib/dialects/anthropic.ts";
import { SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { Engine, ctxOutgoingBody, estimateTokens } from "../lib/engine.ts";
import { PrefixStore } from "../lib/store.ts";
import { aAssistant, aBody, aSession, grow } from "./util.mjs";

function nSummaries(msgs) {
  let n = 0;

  for (const m of msgs) {
    if (m.role === "user" && String(m.content).startsWith(SUMMARY_HEADER)) {
      n += 1;
    }
  }

  return n;
}

describe("engine pipeline", () => {
  it("estTokensIn matches estimateTokens of the request body", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000 }));
    const body = aBody(aSession(8));
    const ctx = engine.prepare(body, ANTHROPIC);

    assert.equal(ctx.estTokensIn, estimateTokens(body));
    assert.equal(ctx.estTokensOut, estimateTokens(body));
  });

  it("passes through under threshold", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000 }));
    const ctx = engine.prepare(aBody(aSession(4)), ANTHROPIC);

    assert.equal(ctx.modified, false);
    assert.deepEqual(ctxOutgoingBody(ctx).messages, aSession(4));
  });

  it("compacts, stores, and substitutes the original tail", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    const ctx1 = engine.prepare(aBody(msgs), ANTHROPIC);

    assert.equal(ctx1.compacted && ctx1.modified, true);
    assert.equal(nSummaries(ctx1.substituted), 1);
    assert.equal(engine.store.size, 1);
    assert.ok(ctx1.estTokensOut < ctx1.estTokensIn);

    const msgs2 = grow(msgs, 10, 1, 10);
    const ctx2 = engine.prepare(aBody(msgs2), ANTHROPIC);

    assert.equal(ctx2.modified, true);
    const out = ctx2.substituted;
    assert.equal(out[0], msgs2[0]);
    assert.ok(String(out[1].content).startsWith(SUMMARY_HEADER));
    assert.equal(out[out.length - 1], msgs2[msgs2.length - 1]);
    assert.deepEqual(out.slice(2), msgs2.slice(ctx2.baseCut));
  });

  it("recompacts flat and matches the deepest prefix", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    engine.prepare(aBody(msgs), ANTHROPIC);

    const msgs2 = grow(msgs, 10, 8);
    const ctx = engine.prepare(aBody(msgs2), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    assert.equal(nSummaries(ctx.substituted), 1);
    assert.equal(ctx.substituted[0], msgs2[0]);
    assert.equal(ctx.substituted[ctx.substituted.length - 1], msgs2[msgs2.length - 1]);
    assert.equal(engine.store.size, 2);

    const msgs3 = grow(msgs2, 18, 1, 10);
    const ctx3 = engine.prepare(aBody(msgs3), ANTHROPIC);

    assert.ok(ctx3.baseCut > msgs.length);
    assert.equal(nSummaries(ctx3.substituted), 1);
  });

  it("lets diverging branches share a stored prefix", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    engine.prepare(aBody(msgs), ANTHROPIC);

    const branchA = grow(msgs, 10, 1, 10);
    const branchB = msgs.concat([aAssistant("different continuation", null)]);
    const ctxA = engine.prepare(aBody(branchA), ANTHROPIC);
    const ctxB = engine.prepare(aBody(branchB), ANTHROPIC);

    assert.equal(ctxA.modified && ctxB.modified, true);
    assert.equal(ctxA.substituted[ctxA.substituted.length - 1], branchA[branchA.length - 1]);
    assert.equal(ctxB.substituted[ctxB.substituted.length - 1], branchB[branchB.length - 1]);
  });

  it("fail-opens when history mutation breaks the prefix match", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    engine.prepare(aBody(msgs), ANTHROPIC);

    const mutated = msgs.map((m) => ({ ...m }));
    mutated[3] = { role: "user", content: "history rewritten by scaffold" };
    const small = new Engine(makeConfig({ thresholdTokens: 1_000_000 }), engine.store);
    const ctx = small.prepare(aBody(mutated), ANTHROPIC);

    assert.equal(ctx.modified, false);
  });

  it("reactively compact regardless of threshold", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000, keepRecent: 1 }));
    const ctx = engine.prepare(aBody(aSession(10)), ANTHROPIC);

    assert.equal(ctx.modified, false);
    assert.equal(engine.reactive(ctx), true);
    assert.equal(ctx.compacted, true);
    assert.equal(nSummaries(ctx.substituted), 1);
  });

  it("replays a long history to a bounded recent-only summary", () => {
    const cfg = makeConfig({ thresholdTokens: 2_000, keepRecent: 1 });
    const live = new Engine(cfg);
    let msgs = aSession(2);
    let liveCtx = null;

    for (let i = 2; i < 60; i++) {
      liveCtx = live.prepare(aBody(msgs), ANTHROPIC);
      msgs = grow(msgs, i, 1);
    }

    let liveSummary = "";

    for (const m of liveCtx.substituted) {
      if (nSummaries([m])) {
        liveSummary = m.content;
      }
    }

    const fresh = new Engine(cfg);
    const ctx = fresh.prepare(aBody(msgs), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    let freshSummary = "";

    for (const m of ctx.substituted) {
      if (nSummaries([m])) {
        freshSummary = m.content;
      }
    }

    assert.equal(nSummaries(ctx.substituted), 1);
    assert.equal(freshSummary.includes("Step 2"), false);
    assert.equal(freshSummary.includes("Step 10"), false);
    assert.ok(freshSummary.length < 3 * Math.max(liveSummary.length, 1000));
    assert.ok(ctx.estTokensOut <= cfg.thresholdTokens * 2);
  });

  it("terminates the reactive ladder", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const ctx = engine.prepare(aBody(aSession(10)), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    let attempts = 0;

    while (engine.reactive(ctx) && attempts < 10) {
      attempts += 1;
    }

    assert.ok(attempts <= 4);
    assert.equal(engine.reactive(ctx), false);
    assert.equal(engine.reactive(ctx), false);
  });

  it("keeps an empty store it was handed", () => {
    const mine = new PrefixStore(7, 1234);
    const engine = new Engine(makeConfig({}), mine);

    assert.equal(engine.store, mine);
    assert.equal(engine.store.maxBytesLimit, 1234);
  });

  it("builds its store from config", () => {
    const engine = new Engine(makeConfig({ storeMaxEntries: 9, storeMaxBytes: 4321 }));

    assert.equal(engine.store.max, 9);
    assert.equal(engine.store.maxBytesLimit, 4321);
  });
});

describe("proactive escalation", () => {
  function fatSession(nTurns, resultChars = 6000) {
    const msgs = [{ role: "user", content: "the task: fix the bug" }];

    for (let i = 0; i < nTurns; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "text", text: "thought " + i + ": " + "y".repeat(2000) },
          { type: "tool_use", id: "t" + i, name: "bash", input: { command: "make " + i } },
        ],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t" + i, content: "R".repeat(resultChars) }],
      });
    }

    return msgs;
  }

  it("escalates keepRecent when the floor is over threshold", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 4000, keepRecent: 3 }));
    const ctx = eng.prepare(aBody(fatSession(8)), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    assert.ok(ctx.rung >= 1);
    assert.ok(ctx.estTokensOut <= 4000);
    assert.equal(ctx.substituted.filter((m) => m.role === "assistant").length, 1);
  });

  it("compacts few giant turns via rung 1", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 3000, keepRecent: 3 }));
    const ctx = eng.prepare(aBody(fatSession(3)), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    assert.ok(ctx.rung >= 1);
    assert.ok(ctx.substituted.length < ctx.msgs.length);
  });

  it("soft-sends a giant live turn without throwing", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 3 }));
    const ctx = eng.prepare(aBody(fatSession(1, 40000)), ANTHROPIC);

    assert.ok(ctxOutgoingBody(ctx));
  });

  it("does not escalate without assistant turns", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 100, keepRecent: 3 }));
    const ctx = eng.prepare(aBody([{ role: "user", content: "x".repeat(30000) }]), ANTHROPIC);

    assert.equal(ctx.compacted, false);
    assert.equal(ctx.modified, false);
    assert.equal(ctx.rung, 0);
  });

  it("walks rung 3 under strict and stays under budget", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 1, strict: true }));
    const ctx = eng.prepare(aBody(fatSession(10, 300)), ANTHROPIC);

    assert.equal(ctx.rung, 3);
    assert.equal(ctx.overBudget, false);
    assert.ok(ctx.estTokensOut <= 1000);
  });

  it("stops the default ladder at rung 2", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 1 }));
    const ctx = eng.prepare(aBody(fatSession(10, 300)), ANTHROPIC);

    assert.ok(ctx.rung <= 2);
  });

  it("clears overBudget when under threshold", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 4000, keepRecent: 3, strict: true }));
    const ctx = eng.prepare(aBody(fatSession(8)), ANTHROPIC);

    assert.equal(ctx.overBudget, false);
  });
});
