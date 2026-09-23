import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeConfig } from "../lib/config.ts";
import { SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { compactSession, liveFromEntries } from "../lib/pi-hook.ts";
import { pAssistant, pResult, pUser } from "./util.mjs";

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
});

describe("liveFromEntries", () => {
  it("starts after the last compaction's firstKeptEntryId", () => {
    const entries = [
      { id: "e0", kind: "message", message: pUser("task") },
      { id: "a0", kind: "message", message: pAssistant("old", ["t0", "bash", { command: "ls" }]) },
      { id: "cmp", kind: "compaction", firstKeptEntryId: "a1" },
      { id: "a1", kind: "message", message: pAssistant("kept", ["t1", "bash", { command: "pwd" }]) },
      { id: "a2", kind: "message", message: pAssistant("new", ["t2", "bash", { command: "id" }]) },
    ];

    const live = liveFromEntries(entries);

    assert.deepEqual(live.map((r) => r.entryId), ["a1", "a2"]);
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
});
