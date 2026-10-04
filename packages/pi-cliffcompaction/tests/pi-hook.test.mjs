import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeConfig } from "../lib/config.ts";
import { SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { compactSession, liveFromEntries, resolveCompactReason } from "../lib/pi-hook.ts";
import { pAssistant, pResult, pUser } from "./util.mjs";
import { estimateTokens } from "../lib/engine.ts";
import { DIALECT as PI } from "../lib/dialects/pi.ts";

function liveSession(nTurns) {
  const live = [{ entryId: "e0", message: pUser("Fix the failing test in repo X.") }];

  for (let i = 0; i < nTurns; i++) {
    live.push({
      entryId: "a" + i,
      message: pAssistant("Step " + i + ": inspect module " + i + ".", [
        "t" + i,
        "bash",
        { command: "pytest tests/test_" + i + ".py -x" },
      ]),
    });
    live.push({
      entryId: "r" + i,
      message: pResult("t" + i, i % 2 === 0 ? "X".repeat(3000) : "test_" + i + " passed (short output)"),
    });
  }

  return live;
}

describe("compactSession", () => {
  it("returns null when there is nothing to gain", () => {
    const live = liveSession(2);

    const out = compactSession({
      live,
      tokensBefore: 100,
      fallbackFirstKeptEntryId: "e0",
      reason: "manual",
      cfg: makeConfig({ keepRecent: 3 }),
    });

    assert.equal(out, null);
  });

  it("produces a mechanical summary and keeps the last turn's entry id", () => {
    const live = liveSession(8);

    const out = compactSession({
      live,
      tokensBefore: 50_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "threshold",
      cfg: makeConfig({ keepRecent: 1 }),
    });

    assert.ok(out);
    assert.ok(out.summary.startsWith(SUMMARY_HEADER));
    assert.ok(out.summary.includes("user: Fix the failing test in repo X."));
    assert.ok(out.summary.includes("[bash]"));
    assert.ok(out.summary.includes("result: test_1 passed (short output)"));
    assert.equal(out.summary.includes("X".repeat(600)), false);
    assert.equal(out.firstKeptEntryId, live[live.length - 2].entryId);
    assert.equal(out.details.method, "cliffcompaction");
    assert.equal(out.details.keptMessages > 0, true);
  });

  it("does not fold a previous summary when live starts after the last cliff", () => {
    const first = liveSession(6);

    const firstOut = compactSession({
      live: first,
      tokensBefore: 40_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "threshold",
      cfg: makeConfig({ keepRecent: 1 }),
    });

    const entries = [
      { id: "e0", kind: "message", message: first[0].message },
      { id: "cmp1", kind: "compaction", firstKeptEntryId: firstOut.firstKeptEntryId },
    ];

    for (const ref of first) {
      if (ref.entryId !== "e0") {
        entries.push({ id: ref.entryId, kind: "message", message: ref.message });
      }
    }

    entries.push({
      id: "a99",
      kind: "message",
      message: pAssistant("Step 99 after cliff", ["t99", "bash", { command: "ls" }]),
    });
    entries.push({ id: "r99", kind: "message", message: pResult("t99", "ok") });
    entries.push({
      id: "a100",
      kind: "message",
      message: pAssistant("Step 100", ["t100", "bash", { command: "pwd" }]),
    });
    entries.push({ id: "r100", kind: "message", message: pResult("t100", "ok") });

    const live = liveFromEntries(entries);

    const second = compactSession({
      live,
      tokensBefore: 20_000,
      fallbackFirstKeptEntryId: firstOut.firstKeptEntryId,
      reason: "threshold",
      cfg: makeConfig({ keepRecent: 1 }),
    });

    assert.ok(second);
    assert.equal(second.summary.includes(SUMMARY_HEADER), true);
    assert.equal((second.summary.match(/The following is a summary/g) || []).length, 1);
    assert.ok(second.summary.includes("Step 99") || second.summary.includes("[bash]"));
  });

  it("escalates keepRecent on overflow when the default floor is too big", () => {
    const live = liveSession(3);

    const out = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "overflow",
      cfg: makeConfig({ keepRecent: 3 }),
    });

    assert.ok(out);
    assert.ok(out.rung >= 1);
    assert.equal(out.firstKeptEntryId, live[live.length - 2].entryId);
  });

  it("overflow with keepRecent 0 recaps thoughts instead of keeping a giant last turn", () => {
    const giant = "R".repeat(40_000);
    const live = [{ entryId: "e0", message: pUser("Fix the failing test in repo X.") }];

    for (let i = 0; i < 8; i++) {
      live.push({
        entryId: "a" + i,
        message: pAssistant("thought " + i + ": " + "y".repeat(2000), ["t" + i, "bash", { command: "make " + i }]),
      });
      live.push({
        entryId: "r" + i,
        message: pResult("t" + i, i === 7 ? giant : "ok"),
      });
    }

    const out = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "overflow",
      cfg: makeConfig({ keepRecent: 0, thresholdTokens: 1000 }),
    });

    assert.ok(out);
    assert.equal(out.details.keepRecent, 0);
    assert.equal(out.details.keptMessages, 0);
    assert.equal(out.firstKeptEntryId, "");
    assert.equal(out.summary.includes(giant), false);
    assert.ok(out.rung >= 2);
    assert.equal(out.summary.includes("y".repeat(2000)), false);
  });

  it("overflow keepRecent 0 recaps a single giant assistant turn", () => {
    const giant = "Y".repeat(40_000);
    const live = [
      { entryId: "e0", message: pUser("Fix the failing test in repo X.") },
      { entryId: "a0", message: pAssistant(giant, null) },
    ];

    const out = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "overflow",
      cfg: makeConfig({ keepRecent: 0, thresholdTokens: 1000 }),
    });

    assert.ok(out);
    assert.equal(out.details.keptMessages, 0);
    assert.equal(out.firstKeptEntryId, "");
    assert.equal(out.summary.includes(giant), false);
    assert.ok(out.rung >= 2);
    assert.ok(out.summary.includes("user: Fix the failing test in repo X."));
  });

  it("overflow still tightens keepRecent when the default floor is under the library threshold", () => {
    const live = liveSession(8);
    const cfg = makeConfig({ keepRecent: 3, thresholdTokens: 200_000 });
    const baseline = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "threshold",
      cfg,
    });

    assert.ok(baseline);
    assert.equal(baseline.rung, 0);
    assert.ok(baseline.details.estTokensOut < cfg.thresholdTokens);
    assert.equal(baseline.details.keepRecent, 3);

    const out = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "overflow",
      cfg,
    });

    assert.ok(out);
    assert.ok(out.rung >= 1);
    assert.equal(out.details.keepRecent, 1);
    assert.ok(out.details.estTokensOut <= baseline.details.estTokensOut);
    assert.equal(out.firstKeptEntryId, live[live.length - 2].entryId);
  });

  it("maps Pi host auto-compaction reasons; session_before_compact has none", () => {
    assert.equal(resolveCompactReason(undefined), "manual");
    assert.equal(resolveCompactReason("overflow"), "overflow");
    assert.equal(resolveCompactReason("incomplete"), "overflow");
    assert.equal(resolveCompactReason("threshold"), "threshold");
    assert.equal(resolveCompactReason("idle"), "threshold");
    assert.equal(resolveCompactReason("manual"), "manual");
  });

  it("unresolved session_before_compact reason does not walk the overflow ladder", () => {
    const live = liveSession(8);
    const cfg = makeConfig({ keepRecent: 3, thresholdTokens: 200_000 });
    const unresolved = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: resolveCompactReason(undefined),
      cfg,
    });
    const overflow = compactSession({
      live,
      tokensBefore: 80_000,
      fallbackFirstKeptEntryId: "e0",
      reason: resolveCompactReason("overflow"),
      cfg,
    });

    assert.ok(unresolved);
    assert.equal(unresolved.rung, 0);
    assert.equal(unresolved.details.keepRecent, 3);
    assert.ok(overflow);
    assert.ok(overflow.rung >= 1);
    assert.equal(overflow.details.keepRecent, 1);
  });

  it("keepRecent 0 does not fall back to a head id that would revive the compacted middle", () => {
    const live = liveSession(6);

    const out = compactSession({
      live,
      tokensBefore: 40_000,
      fallbackFirstKeptEntryId: live[0].entryId,
      reason: "threshold",
      cfg: makeConfig({ keepRecent: 0 }),
    });

    assert.ok(out);
    assert.equal(out.details.keptMessages, 0);
    const entries = live.map((ref) => ({ id: ref.entryId, kind: "message", message: ref.message }));
    entries.push({ id: "cmp", kind: "compaction", firstKeptEntryId: out.firstKeptEntryId });
    const reconstructed = liveFromEntries(entries);

    assert.deepEqual(reconstructed.map((r) => r.entryId), ["e0"]);
    assert.equal(reconstructed.some((r) => r.entryId === "a0"), false);
  });
});

describe("liveFromEntries", () => {
  it("retains the original head and starts the suffix at the last compaction's firstKeptEntryId", () => {
    const entries = [
      { id: "e0", kind: "message", message: pUser("task") },
      { id: "a0", kind: "message", message: pAssistant("old", ["t0", "bash", { command: "ls" }]) },
      { id: "cmp", kind: "compaction", firstKeptEntryId: "a1" },
      { id: "a1", kind: "message", message: pAssistant("kept", ["t1", "bash", { command: "pwd" }]) },
      { id: "a2", kind: "message", message: pAssistant("new", ["t2", "bash", { command: "id" }]) },
    ];

    const live = liveFromEntries(entries);

    assert.deepEqual(live.map((r) => r.entryId), ["e0", "a1", "a2"]);
  });

  it("skips compaction entries themselves", () => {
    const entries = [
      { id: "cmp", kind: "compaction", firstKeptEntryId: "e0" },
      { id: "e0", kind: "message", message: pUser("task") },
    ];

    const live = liveFromEntries(entries);

    assert.equal(live.length, 1);
    assert.equal(live[0].entryId, "e0");
  });

  it("keeps /tree branch summaries in live and recaps them instead of dropping them", () => {
    const abandoned = "Abandoned approach: rewrite pkg/foo in Rust.";
    const first = liveSession(6);
    const entries = first.map((ref) => ({ id: ref.entryId, kind: "message", message: ref.message }));
    entries.splice(3, 0, { id: "br", kind: "branch_summary", summary: abandoned });

    const live = liveFromEntries(entries);

    assert.equal(live.some((r) => r.entryId === "br"), true);
    assert.ok(String(live.find((r) => r.entryId === "br")?.message.content).includes(abandoned));

    const out = compactSession({
      live,
      tokensBefore: 40_000,
      fallbackFirstKeptEntryId: "e0",
      reason: "threshold",
      cfg: makeConfig({ keepRecent: 1 }),
    });

    assert.ok(out);
    assert.ok(out.summary.includes(abandoned));
    assert.equal(out.firstKeptEntryId === "br", false);
  });
});

it("strict Pi compaction protects the entire task and measures the actual summary plus tail", () => {
  for (const task of ["TASK: fix the flaky test and do not touch pkg/bar.", "TASK:" + "x".repeat(2000)]) {
    const msgs = [pUser(task)];

    for (let i = 0; i < 12; i++) {
      msgs.push(pAssistant("step " + i + " " + "reasoning ".repeat(20), ["c" + i, "bash", { command: "run " + i }]));
      msgs.push(pResult("c" + i, "short result " + i));
    }

    const live = msgs.map((message, i) => ({ entryId: "e" + i, message }));

    const out = compactSession({ live, tokensBefore: 5000, fallbackFirstKeptEntryId: "e0", reason: "threshold",
      cfg: makeConfig({ strict: true, thresholdTokens: 300, humanMaxChars: 20 }) });

    assert.ok(out);
    assert.ok(out.summary.includes(task));
    assert.deepEqual(out.firstKeptEntryId, live[out.details.cut].entryId);
    const tail = msgs.slice(out.details.cut);
    const actual = estimateTokens({ messages: [PI.userMessage(out.summary), ...tail] });

    assert.equal(out.details.estTokensOut, actual);
    assert.equal(out.details.overBudget, actual > 300);
    const floor = estimateTokens({ messages: [PI.userMessage(SUMMARY_HEADER + "\n\nuser: " + task), ...tail] });

    assert.ok(actual <= 300 || floor > 300);
  }
});

it("strict truncation keeps --- between the protected head and remaining excerpts", () => {
  const task = "TASK: keep this head verbatim.";
  const msgs = [pUser(task)];

  for (let i = 0; i < 12; i++) {
    msgs.push(pAssistant("step " + i + " " + "reasoning ".repeat(20), ["c" + i, "bash", { command: "run " + i }]));
    msgs.push(pResult("c" + i, "short result " + i));
  }

  const live = msgs.map((message, i) => ({ entryId: "e" + i, message }));
  const out = compactSession({
    live,
    tokensBefore: 5000,
    fallbackFirstKeptEntryId: "e0",
    reason: "threshold",
    cfg: makeConfig({ strict: true, thresholdTokens: 300, humanMaxChars: 20 }),
  });

  assert.ok(out);
  assert.equal(out.rung, 3);
  const headLine = "user: " + task;
  assert.ok(out.summary.includes(headLine));
  const after = out.summary.split(headLine)[1] ?? "";
  assert.ok(after.trim().length > 0);
  assert.ok(after.startsWith("\n\n---\n\n"));
});

it("retains the original task through repeated cliffs without retaining the discarded middle", () => {
  const first = liveSession(7);
  const cfg = makeConfig({ keepRecent: 1, thresholdTokens: 1000 });
  const entries = first.map(ref => ({ id: ref.entryId, kind: "message", message: ref.message }));
  let lastKept = "e0";

  for (let round = 0; round < 4; round++) {
    const live = liveFromEntries(entries);
    const out = compactSession({ live, tokensBefore: 40_000, fallbackFirstKeptEntryId: lastKept, reason: "threshold", cfg });

    assert.ok(out);
    assert.ok(out.summary.includes("Fix the failing test in repo X."));
    assert.equal(live.filter(ref => ref.entryId === "e0").length, 1);
    assert.equal(out.summary.split(SUMMARY_HEADER).length - 1, 1);

    if (round > 0) assert.equal(live.some(ref => ref.entryId === "a0"), false);
    lastKept = out.firstKeptEntryId;
    entries.push({ id: "cliff" + round, kind: "compaction", firstKeptEntryId: lastKept });

    for (let i = 0; i < 3; i++) {
      const id = round + "-" + i;
      entries.push({ id: "next-a" + id, kind: "message", message: pAssistant("Next " + id, [id, "bash", { command: "pwd" }]) });
      entries.push({ id: "next-r" + id, kind: "message", message: pResult(id, "ok") });
    }
  }
});

it("declines text-only Pi compaction when the protected head contains an image", () => {
  const live = liveSession(7);
  live[0].message.content.push({ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=" });
  const before = JSON.stringify(live);
  const out = compactSession({ live, tokensBefore: 40_000, fallbackFirstKeptEntryId: "e0", reason: "threshold", cfg: makeConfig({ keepRecent: 1 }) });

  assert.equal(out, null);
  assert.equal(JSON.stringify(live), before);
});

it("folds protected head text without trimming or interpreting quoted summary markers", () => {
  for (const text of ["  Keep these exact spaces.  ", SUMMARY_HEADER + "\nThis is quoted task text, not an old compaction."]) {
    for (const content of [text, [{ type: "text", text }]]) {
      const live = liveSession(7);
      live[0].message.content = content;
      const out = compactSession({ live, tokensBefore: 40_000, fallbackFirstKeptEntryId: "e0", reason: "threshold", cfg: makeConfig({ keepRecent: 1 }) });

      assert.ok(out);
      assert.ok(out.summary.includes("user: " + text));
    }
  }
});
