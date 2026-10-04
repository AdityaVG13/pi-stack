import { isObject } from "../lib/decode.js";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import registerPapercuts from "../index.js";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papercuts-repo-"));
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /tmp/fake\n");

  return dir;
}

const shutdowns = [];

afterEach(async () => {
  for (const close of shutdowns.splice(0)) await close();
});

function captureTool() {
  let tool;

  const pi = { registerTool: (t) => { tool = t; },
    on: (event, handler) => { if (event === "session_shutdown") shutdowns.push(handler); } };

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

test("custom log basenames cannot fabricate repository paths", async () => {
  const tool = captureTool(), repo = tmpRepo(), cwd = path.join(repo, "nested");
  fs.mkdirSync(cwd);
  const file = path.join(repo, "team.papercuts.jsonl");
  const added = await tool.execute("custom-repo", { action: "add", text: "custom backlog", file }, undefined, undefined, { cwd });
  assert.equal(added.isError, false);
  assert.equal(added.structuredContent.data.record.repo, cwd, "custom files retain the execution-directory fallback, not a filename-derived phantom repo");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).repo, cwd);
  const discovered = await tool.execute("discovered-repo", { action: "add", text: "discovered backlog" }, undefined, undefined, { cwd });
  assert.equal(discovered.isError, false);
  assert.equal(discovered.structuredContent.data.record.repo, repo, "the standard git-root log still records the discovered root");
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


test("contended writers return a retryable busy envelope without appending", async () => {
  const repo = tmpRepo();
  const file = path.join(repo, ".papercuts.jsonl");
  const lock = file + ".lock";
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const result = dataOf(await captureTool().execute("busy", { action: "add", text: "must retry", file }, undefined, { cwd: repo }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "busy");
  assert.equal(result.error.retryable, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
});


test("modern tool results expose the envelope and explicit operation failure", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const successful = await tool.execute("modern-success", { action: "schema" }, undefined, undefined, { cwd: repo });
  assert.deepEqual(successful.structuredContent, dataOf(successful));
  assert.equal(successful.isError, false);
  assert.equal(tool.outputSchema.type, "object");
  assert.equal(tool.annotations.openWorldHint, false);
  assert.notEqual(tool.annotations.readOnlyHint, true, "mixed actions include writes");
  const failure = await tool.execute("modern-failure", { action: "add" }, undefined, undefined, { cwd: repo });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.ok, false);
  assert.deepEqual(failure.structuredContent, dataOf(failure));
  const log = path.join(repo, ".papercuts.jsonl");
  assert.equal(fs.existsSync(log), false, "rejected add writes nothing");
  fs.writeFileSync(log, "");
  const lock = log + ".lock";
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const busy = await tool.execute("modern-busy", { action: "add", text: "must not write through busy lock" }, undefined, undefined, { cwd: repo });
  assert.equal(busy.isError, true);
  assert.equal(busy.structuredContent.error.code, "busy");
  assert.equal(busy.structuredContent.error.retryable, true);
  assert.equal(fs.readFileSync(log, "utf8"), "");
});

test("review regression: Markdown lists retain the programmatic envelope", async () => {
  const tool = captureTool(), repo = tmpRepo();
  await tool.execute("md-add", { action: "add", text: "durable Markdown cut" }, undefined, undefined, { cwd: repo });
  const result = await tool.execute("md-list", { action: "list", format: "md" }, undefined, undefined, { cwd: repo });
  assert.match(result.content[0].text, /^# Papercuts/);
  assert.match(result.content[0].text, /durable Markdown cut/);
  assert.deepEqual(result.structuredContent, result.details);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.count, 1);
  assert.equal(result.isError, false);
});

test("list TUI more-line counts the full backlog, including limit truncation", () => {
  const tool = captureTool();
  const items = Array.from({ length: 3 }, (_, i) => ({
    id: `pc_00000000000${i}`,
    severity: "minor",
    text: `cut ${i}`,
  }));
  const result = {
    content: [],
    details: { ok: true, data: { items, count: 3, total: 8, truncated: true } },
  };
  const args = { action: "list", limit: 3 };
  const compact = rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args }));
  assert.match(compact, /8 open papercuts/);
  assert.match(compact, /… 5 more/);
  const expanded = rendered(tool.renderResult(result, { expanded: true }, plainTheme, { args, expanded: true }));
  assert.match(expanded, /8 open papercuts/);
  assert.match(expanded, /… 5 more/);
});

test("expanded list reveals the complete cut instead of retaining the compact preview", async () => {
  const tool = captureTool(), repo = tmpRepo(), ctx = { cwd: repo };
  const ending = "prevent this by retaining the trailing failure reason";
  const body = "x".repeat(130) + " \u001b[31m" + ending + "\u001b[0m";
  const added = await tool.execute("full-list-add", { action: "add", text: body }, undefined, undefined, ctx);
  assert.equal(added.isError, false);
  const args = { action: "list" };
  const result = await tool.execute("full-list", args, undefined, undefined, ctx);
  assert.equal(result.isError, false);
  const compact = rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args }), 240);
  assert.equal(compact.includes(ending), false, "collapsed rows remain previews");
  const expanded = rendered(tool.renderResult(result, { expanded: true }, plainTheme, { args, expanded: true }), 240);
  assert.ok(expanded.includes(ending), "expanding must reveal the reason after the 120-character preview");
  assert.equal(expanded.includes("\u001b"), false, "full text remains sanitized for terminal display");
  assert.equal(result.structuredContent.data.items[0].text, body, "display must not modify stored text");
});

test("expanded lists expose stored tags and the active log path", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "review.jsonl");
  const ctx = { cwd: repo };
  const tags = ["tooling", "ui\u001b[31m"];
  const added = await tool.execute("metadata-add", { action: "add", text: "review this tagged cut", tags, file }, undefined, undefined, ctx);
  assert.equal(added.isError, false);
  const args = { action: "list", file };
  const result = await tool.execute("metadata-list", args, undefined, undefined, ctx);
  assert.equal(result.isError, false);
  const compact = rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args }));
  assert.doesNotMatch(compact, /tags:|file:/, "compact output stays a preview");
  const expanded = rendered(tool.renderResult(result, { expanded: true }, plainTheme, { args, expanded: true }), 240);
  assert.match(expanded, /tags: tooling, ui/);
  assert.ok(expanded.includes(`file: ${file}`), "review must identify the backlog being displayed");
  assert.equal(expanded.includes("\u001b"), false, "stored metadata remains sanitized");
  assert.deepEqual(result.structuredContent.data.items[0].tags, tags, "presentation must not alter stored tags");
});

test("add human line stays one line so the JSON envelope remains on line 2", async () => {
  const tool = captureTool(), repo = tmpRepo();
  const body = "first line\n- injected\n{not json}";
  const result = await tool.execute("nl-add", { action: "add", text: body }, undefined, undefined, { cwd: repo });
  const text = result.content[0].text;
  const lines = text.split("\n");
  assert.equal(lines[0].includes("\n"), false);
  assert.match(lines[0], /^filed pc_[0-9a-f]{12} · minor · first line - injected \{not json\}$/);
  assert.doesNotMatch(text, /^- injected/m);
  const payload = JSON.parse(lines.slice(1).join("\n"));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.record.text, body);
  assert.equal(result.structuredContent.data.record.text, body);
});

test("markdown list digest keeps one flattened line per cut", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, ".papercuts.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ kind: "cut", id: "pc_aaaaaaaaaaaa", text: "Valid cut", agent: "pi", severity: "major" }),
    JSON.stringify({ kind: "cut", id: "pc_bbbbbbbbbbbb", severity: "constructor" }),
    JSON.stringify({ kind: "cut", id: "pc_cccccccccccc", text: "line1\n- injected\nline2", agent: "pi", severity: "minor" }),
  ].join("\n") + "\n");
  const result = await tool.execute("md-lines", { action: "list", format: "md", status: "all", file }, undefined, undefined, { cwd: repo });
  const text = result.content[0].text;
  const itemLines = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(itemLines.length, 3, text);
  assert.equal(text.includes("undefined"), false, text);
  assert.doesNotMatch(text, /^- injected/m);
  assert.match(text, /line1 - injected line2/);
  assert.match(text, /^- \[constructor\] pc_bbbbbbbbbbbb$/m);
});

test("list tag filter uses the same trim and byte cap as add", async () => {
  const tool = captureTool(), repo = tmpRepo(), ctx = { cwd: repo };
  const long = "x".repeat(80);
  const added = dataOf(await tool.execute("tag-add", { action: "add", text: "tagged cut", tags: ["  tooling  ", long] }, undefined, undefined, ctx));
  assert.equal(added.ok, true);
  assert.deepEqual(added.data.record.tags, ["tooling", "x".repeat(64)]);
  const padded = dataOf(await tool.execute("tag-pad", { action: "list", tag: "  tooling  " }, undefined, undefined, ctx));
  assert.equal(padded.ok, true, padded.error?.message);
  assert.equal(padded.data.count, 1, "listing the tag as filed must find the cut");
  assert.equal(padded.data.items[0].text, "tagged cut");
  const overlong = dataOf(await tool.execute("tag-long", { action: "list", tag: long }, undefined, undefined, ctx));
  assert.equal(overlong.data.count, 1, "listing the untruncated tag must still match the stored cap");
});

test("review regression: relative overrides use the active execution directory", async () => {
  const tool = captureTool(), repo = tmpRepo(), name = "relative-" + path.basename(repo) + ".jsonl";
  const store = await import("../lib/store.js");
  assert.equal(store.resolveLogPath({ file: name, cwd: repo, env: {} }), path.join(repo, name));
  const result = await tool.execute("relative-add", { action: "add", text: "correct project", file: name }, undefined, undefined, { cwd: repo });
  assert.equal(result.details.meta.file, path.join(repo, name));
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, name), "utf8")).text, "correct project");
});

test("review regression: malformed wire values reject before writing", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, ".papercuts.jsonl");

  const cases = [
    { action: "add", text: 42 }, { action: "add", text: "x", tags: "tooling" },
    { action: "add", text: "x", tags: ["valid", 7] }, { action: "add", text: "x", agent: { name: "pi" } },
    { action: "add", text: "x", cmd: { command: "false" } }, { action: "add", text: "x", stderr: ["failure"] },
    { action: "resolve", ids: ["pc_abcd"], note: { text: "fixed" } }, { action: "list", file: 17 },
    { action: "list", tag: ["tooling"] }, { action: "add", text: "x", unknown: null },
  ];

  for (const params of cases) {
    const result = await tool.execute("bad-wire", params, undefined, undefined, { cwd: repo });
    assert.equal(result.details.ok, false, JSON.stringify(params));
    assert.equal(result.details.error.code, "usage");
    assert.equal(result.isError, true);
    assert.equal(fs.existsSync(file), false, "invalid inputs must not create the backlog");
  }
});

test("review regression: every call renderer removes terminal control sequences", () => {
  const tool = captureTool();

  const calls = [
    { action: "list", status: "open\u001b[2J", severity: "major\u001b[31m", tag: "tooling\u001b]52;c;YQ==\u0007" },
    { action: "add", text: "body\u001b[2J", tags: ["tag\u001b[31m"] },
    { action: "resolve", ids: ["pc_abcd\u001b[2J"] },
  ];

  for (const args of calls) {
    const view = rendered(tool.renderCall(args, plainTheme, { expanded: false }));
    assert.equal(view.includes("\u001b"), false);
  }

  const md = { content: [{ type: "text", text: "# Backlog\n- text\u001b[2J" }], details: { ok: true, data: { total: 1 }, meta: { contract: 1 } } };
  const view = rendered(tool.renderResult(md, { expanded: true }, plainTheme, { args: { action: "list", format: "md" } }));
  assert.equal(view.includes("\u001b"), false);
  assert.match(view, /# Backlog/);
});

test("review regression: clipping never introduces a lone UTF-16 surrogate", async () => {
  const tool = captureTool();
  const args = { action: "add", text: "a".repeat(238) + "😀😀" };
  const call = rendered(tool.renderCall(args, plainTheme, { expanded: false }));
  assert.equal(call.isWellFormed(), true);
  const result = { content: [], details: { ok: true, data: { total: 1, items: [{ id: "pc_abcdef123456", severity: "minor", text: "a".repeat(118) + "😀😀" }] }, meta: { contract: 1 } } };
  const list = rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args: { action: "list" } }));
  assert.equal(list.isWellFormed(), true);
  const added = await tool.execute("unicode-preview", { action: "add", text: "a".repeat(71) + "😀😀" }, undefined, undefined, { cwd: tmpRepo() });
  assert.equal(added.content[0].text.isWellFormed(), true, "model-facing previews must not split an emoji either");
  assert.equal(added.structuredContent.data.record.text, "a".repeat(71) + "😀😀");
});

test("review regression: overlapping prefixes resolve a cut exactly once", async () => {
  const tool = captureTool(), repo = tmpRepo(), ctx = { cwd: repo };
  const added = await tool.execute("prefix-add", { action: "add", text: "unique resolution" }, undefined, undefined, ctx);
  const id = added.details.data.record.id;
  const result = await tool.execute("prefix-resolve", { action: "resolve", ids: [id, id.slice(0, 8), id.toUpperCase()] }, undefined, undefined, ctx);
  assert.deepEqual(result.details.data.resolved, [id]);
  const events = fs.readFileSync(result.details.meta.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.kind === "resolve").length, 1);
});

test("review regression: the public schema requires an action and describes prune", async () => {
  const tool = captureTool();
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.equal(tool.parameters.additionalProperties, false);
  const schema = await tool.execute("schema-prune", { action: "schema" });
  assert.equal(schema.structuredContent.data.commands.prune.read_only, false);
  assert.equal(schema.structuredContent.data.commands.prune.archives, true);
});

test("review regression: resolve cannot append an orphan after concurrent prune", async t => {
  const { createActionExecutor } = await import("../lib/worker-client.js");
  const { pathToFileURL } = await import("node:url");
  const testStore = await import("../lib/store.js");
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, ".papercuts.jsonl"), ctx = { cwd: repo };
  const added = await tool.execute("race-add", { action: "add", text: "keep resolutions linked" }, undefined, undefined, ctx);
  const id = added.details.data.record.id, fixture = path.join(repo, "race-worker.mjs"), probe = path.join(repo, "race-probe.txt");
  // Inject at the same read-to-append boundary, now in the thread doing the I/O.
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import * as store from ${JSON.stringify(new URL("../lib/store.js", import.meta.url).href)};
    import ${JSON.stringify(new URL("../lib/actions.js", import.meta.url).href)};
    const read = fs.readFileSync;
    let interrupted = false;
    fs.readFileSync = function (...args) {
      const bytes = read.apply(this, args);
      if (!interrupted && Number.isInteger(args[0])) {
        interrupted = true;
        try {
          store.appendEvents(${JSON.stringify(file)}, [{kind:'resolve',id:${JSON.stringify(id)},ts:'2026-01-01T00:00:00.000Z',agent:'other',note:'other writer'}]);
          store.prune(${JSON.stringify(file)});
          fs.writeFileSync(${JSON.stringify(probe)}, 'entered');
        } catch (error) {
          if (error.code !== 'busy') throw error;
          fs.writeFileSync(${JSON.stringify(probe)}, 'busy');
        }
      }
      return bytes;
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(new URL("../lib/worker.js", import.meta.url).href)});
  `);
  const executor = createActionExecutor(pathToFileURL(fixture));
  t.after(() => executor.close());
  const result = await executor.run({ action: "resolve", ids: [id], note: "my linked resolution", file }, repo);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(fs.readFileSync(probe, "utf8"), "busy", "cooperating prune must not enter the snapshot-to-append window");
  const working = testStore.readEvents(file).events;
  const cutIds = new Set(working.filter(event => event.kind === "cut").map(event => event.id));
  assert.ok(working.filter(event => event.kind === "resolve").every(event => cutIds.has(event.id)), "an acknowledged resolution must stay linked to its cut");
  testStore.prune(file);
  const history = testStore.fold(testStore.readEvents(path.join(repo, ".papercuts.archive.jsonl")).events);
  assert.equal(history[0].resolution.note, "my linked resolution");
  assert.deepEqual(testStore.readEvents(file).events, []);
});


test("stable tool rows retain layout while updates, expansion, resize and themes stay fresh", () => {
  const tool = captureTool();
  const args = { action: "add", text: "row 中文 😀 é", tags: ["tooling"] };
  let tint = "\u001b[31m";
  const theme = { fg: (_color, text) => tint + text + "\u001b[0m", bold: text => text };
  const first = tool.renderCall(args, theme, { expanded: false });
  const lines = first.render(80);
  const same = tool.renderCall({ ...args }, theme, { expanded: false, lastComponent: first });
  assert.equal(same, first, "a stable row must retain its Text layout cache");
  assert.equal(same.render(80), lines);
  args.text = "updated row 😀";
  const changed = tool.renderCall(args, theme, { expanded: true, lastComponent: same });
  assert.match(rendered(changed), /updated row 😀/);
  assert.doesNotMatch(rendered(changed), /row 中文/);
  tint = "\u001b[32m";
  changed.invalidate();
  const themed = tool.renderCall(args, theme, { expanded: true, lastComponent: changed });
  assert.ok(themed.render(24).join("").includes("\u001b[32m"));
  assert.ok(!themed.render(24).join("").includes("\u001b[31m"));
  const item = { id: "pc_abcdef123456", severity: "minor", text: "old result 中文 😀" };
  const payload = { ok: true, data: { total: 1, items: [item] }, meta: { contract: 1 } };
  const context = { args: { action: "list" } };
  const result = () => ({ content: [], details: payload });
  const list = tool.renderResult(result(), { expanded: false }, plainTheme, context);
  const listLines = list.render(80);
  context.lastComponent = list;
  const again = tool.renderResult(result(), { expanded: false }, plainTheme, context);
  assert.equal(again, list);
  assert.equal(again.render(80), listLines);
  item.text = "changed result 😀";
  assert.match(rendered(tool.renderResult(result(), { expanded: true }, plainTheme, context), 24), /changed result/);

  for (const sample of [
    { content: [], details: { ok: false, error: { message: "failed" } } },
    { content: [{ type: "text", text: "fallback" }] },
    { content: [{ type: "text", text: "# Markdown" }], details: { ok: true, data: { total: 1 } } },
  ]) {
    const previous = tool.renderResult(sample, { expanded: false }, plainTheme, context);
    previous.render(80);
    const reused = tool.renderResult({ ...sample }, { expanded: false }, plainTheme, { ...context, lastComponent: previous });
    assert.equal(reused, previous);
    assert.deepEqual(reused.render(80), previous.render(80));
  }
});


test("add dedupe considers cuts, not orphan resolves with the same ID", async t => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, ".papercuts.jsonl");
  const { cutId } = await import("../lib/store.js");
  const ts = "2026-01-01T00:00:00.000Z", text = "orphan does not dedupe";
  const previous = process.env.PAPERCUTS_NOW;
  process.env.PAPERCUTS_NOW = ts;
  t.after(() => { if (previous === undefined) delete process.env.PAPERCUTS_NOW; else process.env.PAPERCUTS_NOW = previous; });
  const id = cutId(ts, "pi", text, "minor", []);
  fs.writeFileSync(file, JSON.stringify({ kind: "resolve", id, ts, agent: "pi", note: "old orphan" }) + "\n");
  const args = { action: "add", text, agent: "pi" }, ctx = { cwd: repo };
  const added = await tool.execute("orphan-add", args, undefined, undefined, ctx);
  assert.equal(added.structuredContent.data.changed, true);
  assert.equal(added.structuredContent.data.record.id, id);
  const duplicate = await tool.execute("orphan-duplicate", args, undefined, undefined, ctx);
  assert.equal(duplicate.structuredContent.data.changed, false);
  const events = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.kind), ["resolve", "cut"]);
});


test("self-rendered frame retains layout and matches the default box through state changes", async () => {
  const { Box } = await import("@earendil-works/pi-tui");
  const { renderPapercutsCall, renderPapercutsResult } = await import("../lib/render.js");
  const tool = captureTool();
  assert.equal(tool.renderShell, "self");
  let tint = "\u001b[31m";
  const theme = { ...plainTheme, fg: (_color, text) => tint + text + "\u001b[0m", bg: (color, text) => (color === "toolPendingBg" ? "\u001b[44m" : color === "toolErrorBg" ? "\u001b[41m" : "\u001b[42m") + text + "\u001b[0m" };
  const args = { action: "list" }, context = { state: {}, args, expanded: false, isPartial: true, isError: false };
  let result, call, tail, retained, compactLines, expandedLines;

  const expected = width => {
    const box = new Box(1, 1, text => theme.bg(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg", text));
    box.addChild(renderPapercutsCall(args, theme, context));

    if (result) box.addChild(renderPapercutsResult(result, { expanded: context.expanded }, theme, context));

    return box.render(width);
  };

  for (const phase of ["pending", "partial", "complete", "same", "expanded", "collapse", "reexpand", "theme", "error", "resize"]) {
    if (phase === "partial") result = { content: [], details: { ok: true, data: { total: 8, items: Array.from({ length: 8 }, (_, i) => ({ id: `pc_00000000000${i}`, severity: "minor", text: "reason 中文 😀 " + i })) } } };

    if (phase === "complete") context.isPartial = false;

    if (phase === "expanded" || phase === "reexpand") context.expanded = true;

    if (phase === "collapse") context.expanded = false;

    if (phase === "theme") { tint = "\u001b[36m"; call.invalidate(); }

    if (phase === "error") { context.isError = true; result = { content: [], details: { ok: false, error: { message: "failed" } } }; }

    const previous = call;
    call = tool.renderCall(args, theme, { ...context, lastComponent: call });

    if (result) tail = tool.renderResult({ ...result }, { expanded: context.expanded }, theme, { ...context, lastComponent: tail });
    const width = phase === "resize" ? 24 : 100;
    const lines = call.render(width);
    assert.deepEqual([...lines, ...(tail?.render(width) ?? [])], expected(width), phase);

    if (phase === "same") { assert.equal(call, previous); assert.equal(lines, retained, "stable outer frame must retain its layout"); }

    if (phase === "same") compactLines = lines;

    if (phase === "expanded") expandedLines = lines;

    if (phase === "collapse") assert.equal(lines, compactLines, "compact layout survives expansion");

    if (phase === "reexpand") assert.equal(lines, expandedLines, "expanded layout survives collapse");

    retained = lines;
  }
});


test("durable actions leave the UI thread and preserve request environment snapshots", async t => {
  const { default: mutableFs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const tool = captureTool(), repo = tmpRepo(), ctx = { cwd: repo };
  const oldNow = process.env.PAPERCUTS_NOW, oldFile = process.env.PAPERCUTS_FILE, oldAgent = process.env.PAPERCUTS_AGENT;
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };

  const sync = t.mock.method(mutableFs, "fsyncSync", () => { throw new Error("fsync ran on the UI thread"); });
  syncBuiltinESMExports();
  let a, b;

  try {
    process.env.PAPERCUTS_NOW = "2026-01-01T00:00:00.000Z";
    process.env.PAPERCUTS_FILE = "a.jsonl"; process.env.PAPERCUTS_AGENT = "agent-a";
    a = tool.execute("background-a", { action: "add", text: "snapshot a" }, undefined, undefined, ctx);
    process.env.PAPERCUTS_NOW = "2026-01-02T00:00:00.000Z";
    process.env.PAPERCUTS_FILE = "b.jsonl"; process.env.PAPERCUTS_AGENT = "agent-b";
    b = tool.execute("background-b", { action: "add", text: "snapshot b" }, undefined, undefined, ctx);
    [a, b] = await Promise.all([a, b]);
  } finally {
    sync.mock.restore(); syncBuiltinESMExports();
    restore("PAPERCUTS_NOW", oldNow); restore("PAPERCUTS_FILE", oldFile); restore("PAPERCUTS_AGENT", oldAgent);
  }

  assert.equal(a.isError, false, a.content[0].text);
  assert.equal(b.isError, false, b.content[0].text);
  const first = JSON.parse(fs.readFileSync(path.join(repo, "a.jsonl"), "utf8"));
  const second = JSON.parse(fs.readFileSync(path.join(repo, "b.jsonl"), "utf8"));
  assert.equal(first.ts, "2026-01-01T00:00:00.000Z"); assert.equal(first.agent, "agent-a");
  assert.equal(second.ts, "2026-01-02T00:00:00.000Z"); assert.equal(second.agent, "agent-b");
  assert.equal(fs.existsSync(path.join(repo, "a.jsonl.lock")), false);
  assert.equal(fs.existsSync(path.join(repo, "b.jsonl.lock")), false);
});


test("worker shutdown drains accepted writes, rejects new work and can restart", async t => {
  const { createActionExecutor } = await import("../lib/worker-client.js");
  const executor = createActionExecutor(), repo = tmpRepo(), file = path.join(repo, "drain.jsonl");
  t.after(() => executor.close());
  const parsed = text => parsePapercutsParams({ action: "add", text, file }).value;
  await assert.rejects(executor.run(parsed("never dispatched"), repo, AbortSignal.abort()), /before dispatch/);
  assert.equal(fs.existsSync(file), false);
  const controller = new AbortController();
  const first = executor.run(parsed("accepted one"), repo, controller.signal);
  controller.abort();
  const second = executor.run(parsed("accepted two"), repo);
  const closing = executor.close();
  await assert.rejects(executor.run(parsed("too late"), repo), { code: "busy" });
  const receipts = await Promise.all([first, second]);
  await closing;
  assert.ok(receipts.every(result => result.structuredContent.data.changed));
  assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line).text), ["accepted one", "accepted two"]);
  assert.equal(fs.existsSync(file + ".lock"), false);
  const listed = await executor.run(parsePapercutsParams({ action: "list", file }).value, repo);
  assert.equal(listed.structuredContent.data.count, 2);
  await executor.close();
});

test("worker failures never fabricate receipts or automatically replay a write", async t => {
  const { createActionExecutor } = await import("../lib/worker-client.js");
  const { pathToFileURL } = await import("node:url");
  const repo = tmpRepo(), file = path.join(repo, "crash.jsonl"), fixture = path.join(repo, "crash-worker.mjs");
  fs.writeFileSync(fixture, "throw new Error('startup failed');");
  const executor = createActionExecutor(pathToFileURL(fixture));
  t.after(() => executor.close());
  await assert.rejects(executor.run(parsePapercutsParams({ action: "add", text: "must not write", file }).value, repo), /startup failed/);
  await executor.close();
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(fixture, `
    import {parentPort} from 'node:worker_threads';
    import {ACTIONS} from ${JSON.stringify(new URL("../lib/actions.js", import.meta.url).href)};
    parentPort.on('message', ({params,cwd}) => { ACTIONS[params.action](params,{cwd}); process.exit(9); });
  `);
  await assert.rejects(executor.run(parsePapercutsParams({ action: "add", text: "written but no receipt", file }).value, repo), /before returning a receipt/);
  await executor.close();
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, "written but no receipt");
  fs.writeFileSync(fixture, `await import(${JSON.stringify(new URL("../lib/worker.js", import.meta.url).href)});`);
  const listed = await executor.run(parsePapercutsParams({ action: "list", file }).value, repo);
  assert.equal(listed.structuredContent.data.count, 1);
  await assert.rejects(executor.run({ action: "add", text: () => {} }, repo), /clone/);
  await assert.rejects(executor.run(parsePapercutsParams({ action: "add", text: "bad path", file: repo }).value, repo), { code: "usage" });
  await executor.close();
});


test("session shutdown waits for the registered tool's accepted transaction", async () => {
  let tool, shutdown;
  registerPapercuts({ registerTool: value => { tool = value; }, on: (event, handler) => { if (event === "session_shutdown") shutdown = handler; } });
  const repo = tmpRepo(), file = path.join(repo, "shutdown.jsonl");
  const pending = tool.execute("shutdown-write", { action: "add", text: "drain before shutdown", file }, undefined, undefined, { cwd: repo });
  assert.ok(shutdown);
  const closed = shutdown();
  const receipt = await pending;
  await closed;
  assert.equal(receipt.isError, false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).text, "drain before shutdown");
  assert.equal(fs.existsSync(file + ".lock"), false);
});


test("final review: sparse resolution arguments reject before storage", async () => {
  const tool = captureTool(), repo = tmpRepo();

  const holes = [], partial = ["pc_abcd"];
  holes.length = 1; partial.length = 3; partial[2] = "pc_ffff";

  for (const ids of [holes, partial]) {
    const result = await tool.execute("sparse", { action: "resolve", ids }, undefined, undefined, { cwd: repo });
    assert.equal(result.structuredContent.error.code, "usage");
    assert.equal(fs.existsSync(path.join(repo, ".papercuts.jsonl")), false);
  }
});

test("final review: malformed stored IDs and tags cannot poison valid actions", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, ".papercuts.jsonl"), ctx = { cwd: repo };
  const good = { kind: "cut", id: "pc_abcdef123456", tags: ["tooling"], text: "healthy cut", severity: "minor", ts: "2026-01-01T00:00:00.000Z" };
  const bad = [{ ...good, id: 42 }, { ...good, id: null }, { ...good, id: "" }, { ...good, tags: 7 }, { ...good, tags: [7] }];
  fs.writeFileSync(file, [...bad, good].map(item => JSON.stringify(item)).join("\n") + "\n");
  const doctor = await tool.execute("doctor-bad", { action: "doctor" }, undefined, undefined, ctx);
  assert.equal(doctor.structuredContent.data.healthy, false);
  const listed = await tool.execute("list-good", { action: "list", tag: "tooling" }, undefined, undefined, ctx);
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent.data.items.map(item => item.id), [good.id]);
  const resolved = await tool.execute("resolve-good", { action: "resolve", ids: [good.id] }, undefined, undefined, ctx);
  assert.deepEqual(resolved.structuredContent.data.resolved, [good.id]);
  const pruned = await tool.execute("prune-bad", { action: "prune" }, undefined, undefined, ctx);
  assert.equal(pruned.structuredContent.data.tornDropped, bad.length);
  assert.equal(pruned.structuredContent.data.archived, 1);
});

test("final review: all raw display paths strip C0/C1 controls and ANSI", () => {
  const tool = captureTool(), dirty = "hello\u0007\u0008\u007f\u009b2J\u001b[31mworld\u001b[0m";
  const call = rendered(tool.renderCall({ action: "add", text: dirty }, plainTheme, {}));

  const unsafe = text => Array.from(text).some(char => {
    const code = char.codePointAt(0);

    return code < 32 && code !== 9 && code !== 10 || code >= 127 && code <= 159;
  });

  assert.equal(unsafe(call), false);

  for (const details of [undefined, { ok: true, data: { total: 1 } }]) {
    const result = { content: [{ type: "text", text: "# Header\n" + dirty }], details };
    const view = rendered(tool.renderResult(result, { expanded: true }, plainTheme, { args: { action: "list" } }));
    assert.equal(unsafe(view), false);
    assert.match(view, /# Header\n/);
    assert.equal(result.content[0].text, "# Header\n" + dirty, "only presentation is sanitized");
  }

  const receipt = { details: { ok: true, data: { changed: false, record: { id: dirty, severity: dirty, text: "stored", tags: [] } } } };

  for (const expanded of [false, true]) {
    const view = rendered(tool.renderResult(receipt, { expanded }, plainTheme, { args: { action: "add" } }));
    assert.equal(unsafe(view), false, "stored receipt fields are untrusted display text too");
  }

  assert.equal(receipt.details.data.record.severity, dirty, "display sanitation must not alter the stored receipt");
});


test("call renderer fallback cannot swallow the Papercuts error result", () => {
  const tool = captureTool();
  const theme = { ...plainTheme, bg: (_color, text) => text };

  for (const warmed of [false, true]) {
    const context = { state: {}, expanded: false, args: { action: "add", text: "partial arguments" }, isError: true };

    if (warmed) tool.renderCall(context.args, theme, context);
    // A JSON-valid partial argument can fail display coercion before validation.
    context.args.severity = { toString: 0 };
    assert.throws(() => tool.renderCall(context.args, theme, context));
    const failure = { content: [], details: { ok: false, error: { message: "severity must be minor|major|blocker" } } };
    const shown = tool.renderResult(failure, { expanded: false }, theme, context);
    assert.match(rendered(shown), /severity must be minor/);
  }
});


test("independent registrations do not shut down each other's executor", async t => {
  const register = () => {
    const instance = {};
    registerPapercuts({ registerTool: tool => { instance.tool = tool; }, on: (event, handler) => { if (event === "session_shutdown") instance.close = handler; } });

    return instance;
  };

  const a = register(), b = register(), repo = tmpRepo();
  t.after(() => Promise.all([a.close(), b.close()]));
  const first = await a.tool.execute("a", { action: "add", text: "session A", file: path.join(repo, "a.jsonl") });
  assert.equal(first.isError, false);
  const closing = a.close();
  const other = await b.tool.execute("b", { action: "add", text: "session B", file: path.join(repo, "b.jsonl") });
  await closing;
  assert.equal(other.isError, false, "closing A must not reject B's accepted work as busy");
  assert.equal(other.details.data.record.text, "session B");
});

test("result-render failure clears old Papercuts output and permits recovery", () => {
  const tool = captureTool(), theme = { ...plainTheme, bg: (_color, text) => text };

  const context = { state: {}, args: { action: "add" }, expanded: true };

  const original = { content: [{ type: "text", text: "safe fallback" }], details: { ok: true, data: { changed: true,
    record: { id: "pc_000000000001", severity: "minor", text: "old receipt", tags: ["ui"] } } } };

  const frame = tool.renderCall(context.args, theme, context);
  tool.renderResult(original, { expanded: true }, theme, context);
  assert.match(rendered(frame), /old receipt/);
  const malformed = structuredClone(original);
  malformed.details.data.record.tags = "legacy malformed tags";
  assert.throws(() => tool.renderResult(malformed, { expanded: true }, theme, context));
  assert.doesNotMatch(rendered(frame), /old receipt/, "the host fallback must not be accompanied by stale successful output");
  tool.renderResult(original, { expanded: true }, theme, context);
  assert.match(rendered(frame), /old receipt/, "clearing a failed render must update the text cache too");
});


test("byte caps preserve lone surrogates instead of merging distinct papercuts", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "surrogate-caps.jsonl");
  const previous = process.env.PAPERCUTS_NOW;
  process.env.PAPERCUTS_NOW = "2026-01-01T00:00:00.000Z";

  try {
    const ids = [];

    for (const prefix of ["\uD800", "\uDC00", "\uFFFD"]) {
      const result = await tool.execute("surrogate-cap", {
        action: "add", file, agent: "test", text: prefix + "x".repeat(10_000),
        tags: [prefix + "t".repeat(64)], evidence: prefix + "e".repeat(4096),
      });

      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.data.changed, true, "different retained text must not dedupe");
      const record = result.structuredContent.data.record;

      assert.equal(record.text, prefix + "x".repeat(9997));
      assert.deepEqual(record.tags, [prefix + "t".repeat(61)]);
      assert.equal(record.evidence.note, prefix + "e".repeat(4093));
      ids.push(record.id);
    }

    assert.equal(new Set(ids).size, 3);
    const records = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.text[0]), ["\uD800", "\uDC00", "\uFFFD"]);
  } finally {
    if (previous === undefined) delete process.env.PAPERCUTS_NOW;
    else process.env.PAPERCUTS_NOW = previous;
  }
});


test("duplicate adds return the winning stored record, not unsaved evidence", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "duplicates.jsonl");
  const previous = process.env.PAPERCUTS_NOW;
  process.env.PAPERCUTS_NOW = "2026-01-01T00:00:00.000Z";

  try {
    const args = { action: "add", file, agent: "test", text: "one identity", tags: ["ui", "worker"], evidence: "original evidence" };
    const first = await tool.execute("first", args);
    assert.equal(first.isError, false);
    const stored = fs.readFileSync(file, "utf8");
    const duplicate = await tool.execute("duplicate", { ...args, tags: ["worker", "ui"], evidence: "not written" });
    assert.equal(duplicate.isError, false);
    assert.equal(duplicate.structuredContent.data.changed, false);
    assert.equal(fs.readFileSync(file, "utf8"), stored);
    assert.deepEqual(duplicate.structuredContent.data.record, JSON.parse(stored));
    assert.deepEqual(duplicate.details.data.record, first.details.data.record);
  } finally {
    if (previous === undefined) delete process.env.PAPERCUTS_NOW;
    else process.env.PAPERCUTS_NOW = previous;
  }
});

test("unknown stored severities cannot outrank blockers in limited lists", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "severity.jsonl");

  const records = ["constructor", "__proto__", ["blocker"], null].map((severity, i) => ({
    kind: "cut", id: "legacy-" + i, text: "legacy cut", severity, ts: "2026-02-01T00:00:00.000Z", tags: [],
  }));

  records.push({ kind: "cut", id: "pc_000000000001", text: "must be first", severity: "blocker", ts: "2026-01-01T00:00:00.000Z", tags: [] });
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const before = fs.readFileSync(file, "utf8");
  const listed = await tool.execute("list", { action: "list", limit: 1, file });
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent.data.items.map(item => item.id), ["pc_000000000001"]);
  assert.equal(fs.readFileSync(file, "utf8"), before, "legacy records remain preserved");
});


test("malformed scalar records are diagnosed and skipped until explicit pruning", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "legacy.jsonl");
  const valid = { kind: "cut", id: "pc_aaaaaaaaaaaa", ts: "2026-01-01T00:00:00.000Z", text: "Valid cut", agent: "pi", severity: "major", tags: [] };
  const sparse = { kind: "cut", id: "pc_bbbbbbbbbbbb", severity: "constructor", extra: { toString: null, payload: [1, 2] } };
  const poison = { toString: null, valueOf: null };
  let serial = 0;

  const malformed = ["ts", "agent", "text", "severity"].flatMap(field =>
    [poison, [], 17, null].map(value => ({ ...valid, id: "pc_" + (++serial).toString(16).padStart(12, "0"), [field]: value })),
  );

  malformed.push({ kind: "resolve", id: valid.id, ts: poison }, { kind: "resolve", id: valid.id, agent: poison });
  const raw = [valid, sparse, ...malformed].map(record => JSON.stringify(record)).join("\n") + "\n";
  fs.writeFileSync(file, raw);
  const run = params => tool.execute("legacy", { ...params, file }, undefined, undefined, { cwd: repo });
  const diagnosis = dataOf(await run({ action: "doctor" }));
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.data.healthy, false);
  assert.equal(diagnosis.data.checked_lines, 2);
  const listed = await run({ action: "list", status: "all" });
  assert.equal(listed.isError, false);
  assert.deepEqual(dataOf(listed).data.items.map(item => [item.id, item.status]), [[valid.id, "open"], [sparse.id, "open"]]);
  assert.deepEqual(dataOf(listed).data.items[1].extra, sparse.extra);
  const preview = tool.renderResult(listed, { expanded: true }, plainTheme, { args: { action: "list" }, expanded: true });
  assert.match(rendered(preview), /Valid cut/);
  const markdown = await run({ action: "list", format: "md" });
  assert.equal(markdown.isError, false);
  assert.match(markdown.content[0].text, /Valid cut/);
  assert.equal(fs.readFileSync(file, "utf8"), raw, "reads must leave malformed lines untouched");
  assert.equal(dataOf(await run({ action: "resolve", ids: [valid.id] })).ok, true);
  const pruned = dataOf(await run({ action: "prune" }));
  assert.equal(pruned.ok, true);
  assert.equal(pruned.data.tornDropped, malformed.length);
  assert.equal(pruned.data.archivedEvents, 2);
  assert.equal(pruned.data.open, 1);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(sparse) + "\n");
  const after = dataOf(await run({ action: "doctor" }));
  assert.equal(after.data.healthy, true);
  assert.equal(after.data.checked_lines, 1);
});

test("invalid UTF-8 records are torn, not silently repaired into healthy cuts", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "invalid-utf8.jsonl");
  const valid = { kind: "cut", id: "pc_aaaaaaaaaaaa", text: "Literal replacement \uFFFD and emoji 😀", severity: "major" };

  const invalid = Buffer.concat([
    Buffer.from('{"kind":"cut","id":"pc_bbbbbbbbbbbb","text":"bad '),
    Buffer.from([0xff]),
    Buffer.from(' byte"}\n'),
  ]);

  const following = { kind: "cut", id: "pc_cccccccccccc", text: "Valid neighbor after corrupt bytes", severity: "minor" };
  const raw = Buffer.concat([Buffer.from(JSON.stringify(valid) + "\n"), invalid, Buffer.from(JSON.stringify(following))]);
  fs.writeFileSync(file, raw);
  const run = params => tool.execute("invalid-utf8", { ...params, file }, undefined, undefined, { cwd: repo });
  const diagnosis = dataOf(await run({ action: "doctor" }));
  assert.equal(diagnosis.data.healthy, false, "invalid UTF-8 is not a valid JSONL record");
  assert.equal(diagnosis.data.checked_lines, 2);
  const listed = dataOf(await run({ action: "list" }));
  assert.deepEqual(listed.data.items.map(item => [item.id, item.text]), [[valid.id, valid.text], [following.id, following.text]]);
  assert.deepEqual(fs.readFileSync(file), raw, "reads must preserve the malformed bytes");
  const pruned = dataOf(await run({ action: "prune" }));
  assert.equal(pruned.data.tornDropped, 1);
  assert.equal(pruned.data.open, 2);
  assert.equal(fs.readFileSync(file, "utf8"), [valid, following].map(record => JSON.stringify(record)).join("\n") + "\n");
});

test("sparse legacy timestamps cannot hide newer cuts in limited lists", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "sparse-time.jsonl");

  const records = [
    { kind: "cut", id: "pc_aaaaaaaaaaaa", severity: "major", ts: "2026-01-01T00:00:00.000Z", text: "oldest" },
    { kind: "cut", id: "pc_bbbbbbbbbbbb", severity: "major", text: "undated legacy cut" },
    { kind: "cut", id: "pc_cccccccccccc", severity: "major", ts: "2026-02-01T00:00:00.000Z", text: "newest" },
  ];

  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const before = fs.readFileSync(file, "utf8");
  const limited = await tool.execute("sparse-time-limit", { action: "list", file, limit: 1 });
  assert.equal(limited.isError, false);
  assert.equal(limited.structuredContent.data.total, 3, "sparse legacy cuts remain readable");
  assert.deepEqual(limited.structuredContent.data.items.map(item => item.id), [records[2].id]);
  const all = await tool.execute("sparse-time-all", { action: "list", file });
  assert.deepEqual(all.structuredContent.data.items.map(item => item.id), [records[2].id, records[0].id, records[1].id]);
  assert.equal(fs.readFileSync(file, "utf8"), before, "ordering must not rewrite legacy records");
});

test("limited lists order RFC3339 timestamps by instant rather than spelling", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, "timestamp-formats.jsonl");

  const records = [
    { kind: "cut", id: "pc_aaaaaaaaaaaa", severity: "major", ts: "2026-01-01T00:00:00Z", text: "whole second" },
    { kind: "cut", id: "pc_bbbbbbbbbbbb", severity: "major", ts: "2026-01-01T00:00:00.500Z", text: "half a second newer" },
    { kind: "cut", id: "pc_cccccccccccc", severity: "major", ts: "2026-01-01T01:00:00+02:00", text: "one hour older in UTC" },
    { kind: "cut", id: "pc_dddddddddddd", severity: "major", text: "undated legacy cut" },
  ];

  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const before = fs.readFileSync(file, "utf8");
  const limited = await tool.execute("timestamp-limit", { action: "list", file, limit: 1 });
  assert.equal(limited.isError, false);
  assert.deepEqual(limited.structuredContent.data.items.map(item => item.id), [records[1].id]);
  const all = await tool.execute("timestamp-all", { action: "list", file });
  assert.deepEqual(all.structuredContent.data.items.map(item => item.id), [records[1].id, records[0].id, records[2].id, records[3].id]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("prune of a torn-only log does not claim nothing to prune", async () => {
  const tool = captureTool(), repo = tmpRepo(), file = path.join(repo, ".papercuts.jsonl");
  fs.writeFileSync(file, "{\"bad\"\n");
  const doctor = dataOf(await tool.execute("torn-doctor", { action: "doctor" }, undefined, undefined, { cwd: repo }));
  assert.equal(doctor.data.healthy, false);
  const pruned = await tool.execute("torn-prune", { action: "prune" }, undefined, undefined, { cwd: repo });
  const payload = dataOf(pruned);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.tornDropped, 1);
  assert.equal(payload.data.archivedEvents, 0);
  const human = pruned.content[0].text.split("\n")[0];
  assert.match(human, /torn/i);
  assert.doesNotMatch(human, /nothing to prune/);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("prune TUI shows the receipt instead of a generic success", async () => {
  const tool = captureTool(), repo = tmpRepo(), ctx = { cwd: repo };
  const args = { action: "prune" };
  const view = result => rendered(tool.renderResult(result, { expanded: false }, plainTheme, { args }));
  const added = dataOf(await tool.execute("prune-tui-add", { action: "add", text: "archive me" }, undefined, undefined, ctx));
  await tool.execute("prune-tui-resolve", { action: "resolve", ids: [added.data.record.id] }, undefined, undefined, ctx);
  const pruned = await tool.execute("prune-tui", args, undefined, undefined, ctx);
  const compact = view(pruned);
  assert.match(compact, /Pruned 1 resolved papercut/);
  assert.doesNotMatch(compact, /action complete/);
  const expanded = rendered(tool.renderResult(pruned, { expanded: true }, plainTheme, { args, expanded: true }));
  assert.match(expanded, /archive:/);
  const tornRepo = tmpRepo();
  fs.writeFileSync(path.join(tornRepo, ".papercuts.jsonl"), "{\"bad\"\n");
  const torn = view(await tool.execute("prune-tui-torn", args, undefined, undefined, { cwd: tornRepo }));
  assert.match(torn, /torn/i);
  assert.doesNotMatch(torn, /action complete|Nothing to prune/);
  const idle = view(await tool.execute("prune-tui-idle", args, undefined, undefined, { cwd: tmpRepo() }));
  assert.match(idle, /Nothing to prune/);
});
