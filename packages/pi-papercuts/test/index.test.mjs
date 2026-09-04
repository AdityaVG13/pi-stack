import { isObject } from "../decode.js";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerPapercuts from "../index.js";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papercuts-repo-"));
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /tmp/fake\n");
  return dir;
}

function captureTool() {
  let tool;
  const pi = { registerTool: (t) => { tool = t; } };
  registerPapercuts(pi);
  assert.ok(tool, "papercuts tool should register");
  return tool;
}

function dataOf(result) {
  // Prefer structured details; text may prefix a human line before the JSON envelope.
  if (result.details && isObject(result.details)) return result.details;
  const text = result.content[0].text;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

const plainTheme = {
  fg: (_color, text) => String(text),
  bold: (text) => String(text),
};

function rendered(component, width = 120) {
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}

test("registers the papercuts tool with nullable optional fields", () => {
  const tool = captureTool();
  assert.equal(tool.name, "papercuts");
  assert.ok(tool.description.includes("complaint box"));
  assert.ok(tool.parameters.properties.status.anyOf.some((branch) => branch.type === "null"));
});

test("strict-schema null placeholders are treated as absent", () => {
  const params = {
    action: "add",
    text: "strict host placeholders should not break action parsing",
    tags: null, severity: null, evidence: null, cmd: null, exit: null, stderr: null,
    status: null, tag: null, limit: null, format: null, ids: null, note: null,
    target: null, agent: null, file: null,
  };
  const parsed = parsePapercutsParams(params);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.action, "add");
  assert.equal(parsed.value.severity, "minor");
});

test("current Pi execute signature reads cwd from the fifth argument", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const result = dataOf(
    await tool.execute("ctx-five", { action: "add", text: "current signature" }, undefined, undefined, { cwd: repo }),
  );
  assert.equal(result.meta.file, path.join(repo, ".papercuts.jsonl"));
  assert.equal(result.data.record.cwd, repo);
});

test("add uses a compact TUI renderer instead of exposing the JSON envelope", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const args = {
    action: "add",
    text: "A long tool failure was hard to scan; show a concise themed result instead.",
    tags: ["tooling", "tui"],
    severity: "major",
  };

  const call = rendered(tool.renderCall(args, plainTheme, { expanded: false }));
  assert.match(call, /papercuts add/);
  assert.match(call, /major · tooling · tui/);
  assert.match(call, /A long tool failure/);
  assert.doesNotMatch(call, /\{"action"/);

  const result = await tool.execute("render-add", args, undefined, { cwd: repo });
  const view = rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args }));
  assert.match(view, /^✓ Filed pc_[0-9a-f]{12} · major$/);
  assert.doesNotMatch(view, /"ok"|"record"|"cwd"/);

  const expanded = rendered(tool.renderResult(result, { expanded: true }, plainTheme, { args }));
  assert.match(expanded, /tags: tooling, tui/);
  assert.match(expanded, /file:/);
});

test("TUI renderer strips terminal control sequences from displayed arguments", () => {
  const tool = captureTool();
  const args = { action: "add", text: "plain \u001b[31mred\u001b[0m text", tags: ["\u001b[2Jtui"] };
  const call = rendered(tool.renderCall(args, plainTheme, { expanded: false }));
  assert.equal(call.includes("\u001b"), false);
  assert.match(call, /plain red text/);
  assert.match(call, /minor · tui/);
});

test("usage errors render as readable guidance instead of raw JSON", async () => {
  const tool = captureTool();
  const args = { action: "add" };
  const result = await tool.execute("render-error", args, undefined, { cwd: tmpRepo() });
  const view = rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args }));
  assert.match(view, /^✗ papercuts add requires non-empty 'text'\./);
  assert.match(view, /papercuts\(\{action:'add'/);
  assert.doesNotMatch(view, /"ok"|"error":\{/);
});

test("add then list then resolve round-trips through the git-root log", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const ctx = { cwd: repo };

  const added = dataOf(await tool.execute("1", { action: "add", text: "dead-end tool call; surface the error reason", tags: ["tooling"], severity: "major" }, undefined, ctx));
  assert.equal(added.ok, true);
  assert.equal(added.data.changed, true);
  assert.match(added.data.record.id, /^pc_[0-9a-f]{12}$/);
  assert.equal(added.meta.file, path.join(repo, ".papercuts.jsonl"));
  assert.ok(fs.existsSync(path.join(repo, ".papercuts.jsonl")));

  // duplicate line (same content-addressed id) is a no-op
  process.env.PAPERCUTS_NOW = "2026-08-05T00:00:00.000Z";
  await tool.execute("x", { action: "add", text: "fixed-clock", tags: ["tooling"] }, undefined, ctx);
  const dup = dataOf(await tool.execute("2", { action: "add", text: "fixed-clock", tags: ["tooling"] }, undefined, ctx));
  delete process.env.PAPERCUTS_NOW;
  assert.equal(dup.data.changed, false);

  const listed = dataOf(await tool.execute("3", { action: "list" }, undefined, ctx));
  assert.equal(listed.data.count, 2);
  assert.equal(listed.data.items[0].severity, "major");

  const resolved = dataOf(await tool.execute("4", { action: "resolve", ids: [added.data.record.id.slice(0, 8)], note: "fixed" }, undefined, ctx));
  assert.equal(resolved.data.changed, true);

  const openAfter = dataOf(await tool.execute("5", { action: "list" }, undefined, ctx));
  assert.equal(openAfter.data.count, 1);
  const allAfter = dataOf(await tool.execute("6", { action: "list", status: "resolved" }, undefined, ctx));
  assert.equal(allAfter.data.count, 1);
});

test("add without text returns a usage error envelope", async () => {
  const tool = captureTool();
  const res = dataOf(await tool.execute("7", { action: "add" }, undefined, { cwd: tmpRepo() }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "usage");
});

test("resolve of an unknown id returns not_found", async () => {
  const tool = captureTool();
  const res = dataOf(await tool.execute("8", { action: "resolve", ids: ["pc_deadbeef"] }, undefined, { cwd: tmpRepo() }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "not_found");
});

test("doctor validates a healthy log", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  await tool.execute("9", { action: "add", text: "one" }, undefined, { cwd: repo });
  const res = dataOf(await tool.execute("10", { action: "doctor" }, undefined, { cwd: repo }));
  assert.equal(res.ok, true);
  assert.equal(res.data.healthy, true);
  assert.equal(res.data.cuts, 1);
});

test("schema returns the machine contract", async () => {
  const tool = captureTool();
  const res = dataOf(await tool.execute("11", { action: "schema" }, undefined, { cwd: tmpRepo() }));
  assert.equal(res.ok, true);
  assert.equal(res.data.contract, 1);
  assert.ok(res.data.records.cut);
  assert.ok(res.data.commands.add);
});

import { parsePapercutsParams, SCHEMA_TARGETS, SEVERITIES } from "../index.js";

test("parsePapercutsParams rejects list + add-only fields", () => {
  const r = parsePapercutsParams({ action: "list", text: "should not be here", ids: ["pc_abcd"] });
  assert.equal(r.ok, false);
  assert.equal(r.error.error.code, "usage");
  assert.match(r.error.error.message, /Illegal field/);
});

test("parsePapercutsParams collapses log → add and requires text", () => {
  const bad = parsePapercutsParams({ action: "log" });
  assert.equal(bad.ok, false);
  const ok = parsePapercutsParams({ action: "log", text: "via alias" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.action, "add");
  assert.equal(ok.value.text, "via alias");
  assert.equal(ok.value.severity, "minor");
});

test("parsePapercutsParams closes schema target union", () => {
  const bad = parsePapercutsParams({ action: "schema", target: "exit_codes" });
  assert.equal(bad.ok, false);
  assert.match(bad.error.error.message, /all\|record\|error\|exit-codes/);
  const ok = parsePapercutsParams({ action: "schema", target: "exit-codes" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.target, "exit-codes");
  assert.deepEqual(SCHEMA_TARGETS, ["all", "record", "error", "exit-codes"]);
});

test("schema unknown target returns usage (not silent all)", async () => {
  const tool = captureTool();
  const res = dataOf(await tool.execute("s", { action: "schema", target: "nope" }, undefined, { cwd: tmpRepo() }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "usage");
});

test("execute rejects resolve + text as illegal combo", async () => {
  const tool = captureTool();
  const res = dataOf(
    await tool.execute("x", { action: "resolve", ids: ["pc_dead"], text: "nope" }, undefined, { cwd: tmpRepo() }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "usage");
  assert.match(res.error.message, /Illegal field/);
});


test("evidence free-note XOR tool-failure at parse", () => {
  const mixed = parsePapercutsParams({ action: "add", text: "x", evidence: "note", cmd: "ls" });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error.error.message, /XOR|mix|free-note/i);

  const note = parsePapercutsParams({ action: "add", text: "x", evidence: "just a note" });
  assert.equal(note.ok, true);
  assert.deepEqual(note.value.evidence, { note: "just a note" });
  assert.equal(note.value.cmd, undefined);

  const tool = parsePapercutsParams({ action: "add", text: "x", cmd: "rg", exit: 1, stderr: "nope" });
  assert.equal(tool.ok, true);
  assert.equal(tool.value.evidence.cmd, "rg");
  assert.equal(tool.value.evidence.exit, 1);
  assert.equal(tool.value.evidence.stderr, "nope");
  assert.equal(tool.value.evidence.note, undefined);

  const none = parsePapercutsParams({ action: "add", text: "x" });
  assert.equal(none.ok, true);
  assert.equal(none.value.evidence, undefined);
});

test("joint-illegal combos rejected at parse (action × field product)", () => {
  const cases = [
    // list forbids add/resolve-only fields
    { action: "list", text: "x" },
    { action: "list", ids: ["pc_abcd"] },
    { action: "list", cmd: "x" },
    { action: "list", evidence: "n" },
    { action: "list", note: "x" },
    { action: "list", target: "all" },
    { action: "list", tags: ["t"] }, // list uses singular `tag`
    // doctor/schema only action (+ optional file/target)
    { action: "doctor", text: "x" },
    { action: "doctor", ids: ["pc_abcd"] },
    { action: "doctor", severity: "major" },
    { action: "doctor", target: "all" },
    { action: "doctor", limit: 1 },
    { action: "schema", ids: ["pc_a"] },
    { action: "schema", text: "x" },
    { action: "schema", severity: "minor" },
    { action: "schema", limit: 1 },
    { action: "schema", status: "open" },
    // add forbids list/resolve/schema fields
    { action: "add", text: "x", status: "open" },
    { action: "add", text: "x", limit: 5 },
    { action: "add", text: "x", ids: ["pc_abcd"] },
    { action: "add", text: "x", note: "n" },
    { action: "add", text: "x", target: "all" },
    { action: "add", text: "x", format: "json" },
    // resolve forbids add/list fields
    { action: "resolve", ids: ["pc_abcd"], severity: "major" },
    { action: "resolve", ids: ["pc_abcd"], tags: ["t"] },
    { action: "resolve", ids: ["pc_abcd"], limit: 1 },
    { action: "resolve", ids: ["pc_abcd"], status: "open" },
    { action: "resolve", ids: ["pc_abcd"], format: "json" },
    { action: "resolve", ids: ["pc_abcd"], target: "all" },
    { action: "resolve", ids: ["pc_abcd"], evidence: "n" },
    // closed enums / XOR (not just foreign keys)
    { action: "list", severity: "critical" },
    { action: "list", limit: -1 },
    { action: "list", format: "yaml" },
    { action: "list", status: "pending" },
    { action: "add", text: "x", severity: "urgent" },
    { action: "add", text: "x", evidence: "n", exit: 2 },
    { action: "add", text: "x", evidence: "n", stderr: "e" },
    { action: "add", text: "x", evidence: "n", cmd: "ls" },
    { action: "schema", target: "exit_codes" },
  ];
  for (const c of cases) {
    const r = parsePapercutsParams(c);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(c)} got ${JSON.stringify(r)}`);
  }
});

test("SEVERITIES is sole severity vocabulary (export + parse allowlist)", () => {
  assert.deepEqual(SEVERITIES, ["minor", "major", "blocker"]);
  for (const s of SEVERITIES) {
    const r = parsePapercutsParams({ action: "add", text: "ok", severity: s });
    assert.equal(r.ok, true, s);
    assert.equal(r.value.severity, s);
  }
  const badList = parsePapercutsParams({ action: "list", severity: "HIGH" });
  assert.equal(badList.ok, false);
});

test("execute files free-note evidence without cmd/exit/stderr mix", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const note = dataOf(
    await tool.execute("e1", { action: "add", text: "note only", evidence: "see docs" }, undefined, { cwd: repo }),
  );
  assert.equal(note.ok, true);
  assert.deepEqual(note.data.record.evidence, { note: "see docs" });

  const toolFail = dataOf(
    await tool.execute("e2", { action: "add", text: "tool fail", cmd: "false", exit: 1 }, undefined, { cwd: repo }),
  );
  assert.equal(toolFail.ok, true);
  assert.equal(toolFail.data.record.evidence.cmd, "false");
  assert.equal(toolFail.data.record.evidence.exit, 1);
  assert.equal(toolFail.data.record.evidence.note, undefined);

  const mixed = dataOf(
    await tool.execute(
      "e3",
      { action: "add", text: "mixed", evidence: "n", cmd: "x" },
      undefined,
      { cwd: repo },
    ),
  );
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error.code, "usage");
});


test("parsePapercutsParams refuses non-object wire bags", () => {
  for (const bad of [null, undefined, "add", 1, true, ["action", "add"]]) {
    const r = parsePapercutsParams(bad);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
    assert.equal(r.error.error.code, "usage");
  }
});

test("joint-legal closed enums + limit 0 accepted at parse", () => {
  for (const t of SCHEMA_TARGETS) {
    const r = parsePapercutsParams({ action: "schema", target: t });
    assert.equal(r.ok, true, t);
    assert.equal(r.value.target, t);
  }
  for (const status of ["open", "resolved", "all"]) {
    const r = parsePapercutsParams({ action: "list", status });
    assert.equal(r.ok, true, status);
    assert.equal(r.value.status, status);
  }
  for (const format of ["json", "md"]) {
    const r = parsePapercutsParams({ action: "list", format });
    assert.equal(r.ok, true, format);
    assert.equal(r.value.format, format);
  }
  const zero = parsePapercutsParams({ action: "list", limit: 0 });
  assert.equal(zero.ok, true);
  assert.equal(zero.value.limit, 0);
  // tool-failure path: exit-only / stderr-only / cmd-only legal (XOR free-note)
  for (const partial of [{ exit: 1 }, { stderr: "e" }, { cmd: "rg" }]) {
    const r = parsePapercutsParams({ action: "add", text: "x", ...partial });
    assert.equal(r.ok, true, JSON.stringify(partial));
    assert.equal(r.value.evidence.note, undefined);
  }
});

test("resolve ambiguous id prefix is usage (not first-wins)", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  // Force two distinct content-addressed ids that share a long common prefix by
  // writing cuts with controlled ids is not possible via add — plant JSONL directly.
  const file = path.join(repo, ".papercuts.jsonl");
  const base = {
    kind: "cut",
    ts: "2026-01-01T00:00:00.000Z",
    agent: "pi",
    text: "a",
    tags: [],
    severity: "minor",
    cwd: repo,
    repo,
  };
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ ...base, id: "pc_abcd00000001", text: "one" }),
      JSON.stringify({ ...base, id: "pc_abcd00000002", text: "two" }),
    ].join("\n") + "\n",
  );
  const res = dataOf(
    await tool.execute("amb", { action: "resolve", ids: ["pc_abcd"] }, undefined, { cwd: repo }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "usage");
  assert.match(res.error.message, /Ambiguous/i);
});
