import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { runCommand } from "../workspace.js";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import piSupernova from "../index.js";
import { createHostBridge } from "../host-bridge.js";
import { packageDefaults } from "../config.js";
import { runGuestProgram } from "../runtime.js";
import { CausalVfs } from "../vfs.js";
import { applyPatchToText } from "../patch.js";
import { packageHostResult } from "../bottleneck.js";
import { SeenLedger } from "../ledger.js";
import { renderSupernovaResult } from "../render.js";
import { measureWidth as visibleWidth, hardTruncate } from "../render-measure.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => ({ content: [{ type: "text", text: value }] });
const config = { ...packageDefaults(), timeoutMs: 2000, seenWindow: 0 };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-regression-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    registerCommand() {},
    on() {},
  };
  const bridge = createHostBridge({ pi, config, getCwd: () => root });
  return { root, pi, bridge };
}
function plugin(pi, root) {
  let tool;
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (definition) => {
    if (definition.name === "supernova") tool = definition;
    return register(definition);
  };
  piSupernova(pi);
  return (code, signal) => tool.execute("regression", { code, timeoutMs: 2000 }, signal, undefined, { cwd: root });
}

it("isolates concurrent transactions, traces, and rollback", async (t) => {
  const { root, pi } = await fixture(t);
  const run = plugin(pi, root);
  let entered, release;
  const started = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  pi.registerTool({
    name: "hold",
    parameters: {},
    annotations: { readOnlyHint: true },
    async execute() {
      entered();
      await gate;
      return text("released");
    },
  });
  const first = run('await write("a.txt","A"); await nova.call("hold",{}); return "A";');
  await started;
  const failed = await run('await write("b.txt","B"); throw new Error("reject B");');
  release();
  const success = await first;
  assert.equal(success.details.ok, true);
  assert.equal(failed.details.ok, false);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "A");
  await assert.rejects(fs.access(path.join(root, "b.txt")), { code: "ENOENT" });
  assert.deepEqual(
    success.details.trace.map((r) => r.name),
    ["write", "hold"],
  );
  assert.deepEqual(
    failed.details.trace.map((r) => r.name),
    ["write"],
  );
});
it("settles unawaited native writes before rollback", async (t) => {
  const { root, pi } = await fixture(t);
  const run = plugin(pi, root);
  const failed = await run('write("late.txt","late"); throw new Error("rollback");');
  assert.equal(failed.details.ok, false);
  await sleep(40);
  await assert.rejects(fs.access(path.join(root, "late.txt")), { code: "ENOENT" });
  const next = await run('write("kept.txt","kept"); return "done";');
  assert.equal(next.details.ok, true);
  assert.equal(await fs.readFile(path.join(root, "kept.txt"), "utf8"), "kept");
});
it("rejects unfinished speculation instead of silently losing staged writes", async (t) => {
  const { root, pi } = await fixture(t);
  const run = plugin(pi, root);
  const result = await run(
    'nova.speculate(async()=>{await new Promise(r=>setTimeout(r,100));await write("nested.txt","lost");}); await new Promise(r=>setTimeout(r,20)); return "done";',
  );
  assert.equal(result.details.ok, false);
  await assert.rejects(fs.access(path.join(root, "nested.txt")), { code: "ENOENT" });
});
it("honors public cancellation during worker startup", async (t) => {
  const { root, pi } = await fixture(t);
  const run = plugin(pi, root);
  const abort = new AbortController();
  const result = run('await write("cancelled.txt","bad");return 42;', abort.signal);
  abort.abort();
  assert.equal((await result).details.ok, false);
  await assert.rejects(fs.access(path.join(root, "cancelled.txt")), { code: "ENOENT" });
});
it("bounds preparation that never supplies tool names", async () => {
  const start = performance.now();
  const result = await runGuestProgram({
    code: "return 42;",
    nova: { names: () => new Promise(() => {}) },
    config: { ...config, timeoutMs: 100 },
  });
  assert.equal(result.ok, false);
  assert.ok(performance.now() - start < 1500);
});
it("contains late guest errors and callbacks in a separate process", async (t) => {
  const { root } = await fixture(t);
  const moduleUrl = new URL("../runtime.js", import.meta.url).href;
  const source =
    "import {runGuestProgram} from " +
    JSON.stringify(moduleUrl) +
    ";" +
    'const config={timeoutMs:1000};let calls=0;const nova={call:()=>{calls++;return {ok:true,value:"bad"}}};' +
    'const a=await runGuestProgram({code:\'globalThis.leak=42;setTimeout(()=>{throw Error("late")},10);setTimeout(()=>nova.call("bad",{}),5);return 1;\',config,nova});' +
    "await new Promise(r=>setTimeout(r,40));" +
    "const b=await runGuestProgram({code:'await new Promise(r=>setTimeout(r,40));return typeof globalThis.leak;',config,nova});" +
    "console.log(JSON.stringify({a:a.result,b:b.result,calls}));";
  const script = path.join(root, "child.mjs");
  await fs.writeFile(script, source);
  const child = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { a: 1, b: "undefined", calls: 0 });
});
it("restores already replaced files after a later commit interruption", async (t) => {
  const { root } = await fixture(t);
  const a = path.join(root, "a.txt"),
    b = path.join(root, "b.txt");
  await fs.writeFile(a, "original A");
  await fs.writeFile(b, "original B");
  await fs.chmod(a, 0o640);
  const vfs = new CausalVfs();
  vfs.begin();
  await vfs.write(a, "new A");
  await vfs.write(b, "new B");
  const controller = new AbortController();
  let installed = false;
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  t.mock.method(controller.signal, "throwIfAborted", () => {
    if (readFileSync(a, "utf8") === "new A") {
      installed = true;
      controller.abort();
    }
    check();
  });
  vfs.signal = controller.signal;
  await assert.rejects(vfs.commit(), { name: "AbortError" });
  assert.equal(installed, true);
  assert.equal(await fs.readFile(a, "utf8"), "original A");
  assert.equal(await fs.readFile(b, "utf8"), "original B");
  assert.equal((await fs.stat(a)).mode & 0o777, 0o640);
  assert.deepEqual((await fs.readdir(root)).sort(), ["a.txt", "b.txt"]);
});
it("rejects missing write data and overlapping edit matches without changing files", async (t) => {
  const { root, bridge } = await fixture(t);
  const file = path.join(root, "data.txt");
  await fs.writeFile(file, "aaa");
  await assert.rejects(bridge.call("write", { path: "data.txt" }), /content/);
  await assert.rejects(bridge.call("edit", { path: "data.txt", oldText: "aa", newText: "x" }), /unique/);
  assert.equal(await fs.readFile(file, "utf8"), "aaa");
});
it("reads external replacements and includes newly staged evidence", async (t) => {
  const { root, bridge } = await fixture(t);
  const file = path.join(root, "source.js");
  await fs.writeFile(file, "export function value() {return 1;}");
  await bridge.call("read", { path: "source.js" });
  await fs.writeFile(file, "export function value() {return 2;}");
  assert.match((await bridge.call("read", { path: "source.js" })).value, /return 2/);
  bridge.beginSpeculation();
  await bridge.call("write", {
    path: "pending.js",
    content: 'export function uniquePendingAnswer() {\n return "staged";\n}\n',
  });
  const answer = JSON.parse((await bridge.call("evidence", { query: "uniquePendingAnswer", k: 2 })).value);
  assert.ok(answer.spans.some((span) => span.path === "pending.js" && span.text.includes("staged")));
  bridge.rollbackSpeculation();
});
it("keeps batch line windows and captured string-only reads usable", async (t) => {
  const { root, bridge, pi } = await fixture(t);
  await fs.writeFile(path.join(root, "data.txt"), "zero\none\ntwo");
  assert.deepEqual((await bridge.call("read", { path: ["data.txt"], offset: 2, limit: 1 })).items, ["one"]);
  pi.registerTool({
    name: "read",
    parameters: {},
    async execute(_id, args) {
      return text((await fs.readFile(path.join(root, args.path), "utf8")).split("\n")[args.offset - 1]);
    },
  });
  const run = plugin(pi, root);
  const result = await run('return await read(["data.txt","data.txt"],2,1);');
  assert.equal(result.details.ok, true);
  assert.deepEqual(result.details.result, ["one", "one"]);
});
it("invalidates indexed content after captured mutations", async (t) => {
  const { root, bridge, pi } = await fixture(t);
  const file = path.join(root, "source.js");
  await fs.writeFile(file, "export function before() {}");
  await bridge.call("surface", { path: "source.js" });
  pi.registerTool({
    name: "ast_edit",
    async execute() {
      await fs.writeFile(file, "export function after() {}");
      return text("changed");
    },
  });
  await bridge.call("ast_edit", {});
  const result = await bridge.call("surface", { path: "source.js" });
  assert.match(result.value, /after/);
  assert.doesNotMatch(result.value, /before/);
});
it("serializes unknown tools and mutating LSP actions", async (t) => {
  const { bridge, pi } = await fixture(t);
  for (const [name, args] of [
    ["ast_edit", {}],
    ["lsp", { action: "rename", apply: true }],
  ]) {
    let value = 0;
    pi.registerTool({
      name,
      async execute() {
        const before = value;
        await sleep(5);
        value = before + 1;
        return text(String(value));
      },
    });
    await bridge.callMany([
      { name, args },
      { name, args },
    ]);
    assert.equal(value, 2);
  }
});
it("waits for started read calls before returning a wave error", async (t) => {
  const { bridge, pi } = await fixture(t);
  let settled = false;
  pi.registerTool({
    name: "slow",
    annotations: { readOnlyHint: true },
    async execute() {
      await sleep(30);
      settled = true;
      return text("done");
    },
  });
  pi.registerTool({
    name: "fail",
    annotations: { readOnlyHint: true },
    async execute() {
      throw Error("failure");
    },
  });
  await assert.rejects(bridge.callMany([{ name: "fail" }, { name: "slow" }]), /failure/);
  assert.equal(settled, true);
});
it("throws failed convenience calls and marks their trace as failed", async (t) => {
  const { root, pi } = await fixture(t);
  const run = plugin(pi, root);
  pi.registerTool({
    name: "read",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "denied" }], details: { ok: false } };
    },
  });
  const failed = await run('return await read("denied.txt");');
  assert.equal(failed.details.ok, false);
  assert.equal(failed.details.trace[0].ok, false);
});
it("rejects inherited tool names and malformed collection inputs", async (t) => {
  const { bridge } = await fixture(t);
  for (const name of ["constructor", "toString", "__proto__"])
    await assert.rejects(bridge.call(name, {}), /unknown tool/);
  await assert.rejects(bridge.callMany({}), /array/);
  for (const code of [
    "return await parallel({});",
    "return await pipeline({},x=>x);",
    "return await pipeline([1],42);",
  ]) {
    const result = await runGuestProgram({ code, config });
    assert.equal(result.ok, false);
  }
});
it("parses callable expressions and function-leading bodies", async () => {
  for (const code of [
    "async()=>42;",
    "(async()=>42);",
    "async function answer(){return 42;}",
    "function answer(){return 42;} return answer();",
  ]) {
    const result = await runGuestProgram({ code, config });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, 42);
  }
  const result = await runGuestProgram({ code: "// return is only a comment\nconst answer=42;", config });
  assert.equal(result.undefinedReturn, true);
});
it("preserves DataView ranges and own __proto__ values", async () => {
  const result = await runGuestProgram({
    code: "return {bytes:new DataView(new Uint8Array([9,1,2,3,8]).buffer,1,3),object:JSON.parse('{\"__proto__\":42}')};",
    config,
  });
  assert.deepEqual(result.result.bytes, [1, 2, 3]);
  assert.equal(Object.hasOwn(result.result.object, "__proto__"), true);
  assert.equal(result.result.object.__proto__, 42);
});
it("bounds aggregate batch text and reports raw object truncation with valid details", () => {
  const result = packageHostResult({ details: { batch: true, items: Array(128).fill("x".repeat(65536)) } }, config);
  assert.equal(result.value, "");
  assert.ok(result.items.reduce((n, s) => n + s.length, 0) <= config.maxCallResultChars);
  assert.equal(result.truncated, true);
  const raw = packageHostResult({ payload: "x".repeat(5000) }, { maxCallResultChars: 101 });
  assert.equal(raw.truncated, true);
  assert.ok(raw.value.length <= 101);
  assert.equal(raw.originalChars, 5014);
  const failed = packageHostResult({ details: { message: "x".repeat(5000), exitCode: 7 } }, config);
  assert.equal(failed.ok, false);
  assert.equal(JSON.parse(failed.details).exitCode, 7);
  assert.ok(failed.details.length <= 2000);
});
it("reports dropped log lines and clipped log characters", async () => {
  for (const code of ['console.log("x".repeat(500));return 42;', "for(let i=0;i<10;i++)console.log(i);return 42;"]) {
    const result = await runGuestProgram({ code, config: { ...config, maxLogLines: 2, maxLogLineChars: 100 } });
    assert.equal(result.logTruncated, true);
    assert.ok(result.logs.length <= 2);
    assert.ok(result.logs.every((s) => s.length <= 100));
  }
});
it("applies zero-context coordinates, newline transitions, empty files, and CRLF", () => {
  const cases = [
    ["a\nb\n", "@@ -1,0 +2 @@\n+X", "a\nX\nb\n"],
    ["a\nb\n", "@@ -1,0 +1 @@\n+X", "X\na\nb\n"],
    ["a\n", "@@ -1 +0,0 @@\n-a", ""],
    ["a", "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a", "a\n"],
    ["a\n", "@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file", "a"],
    ["a\r\nb\r\n", "@@ -1 +1 @@\n-a\n+A", "A\r\nb\r\n"],
  ];
  for (const [before, patch, after] of cases) assert.equal(applyPatchToText(before, patch).resultText, after);
});
it("does not collapse hash collisions or explicitly pinned aliases", () => {
  const ledger = new SeenLedger();
  const a = Array(6).fill("payload-5ydav6-24ja").join("\n");
  const b = Array(6).fill("payload-2k7vru-3hym").join("\n");
  ledger.beginProgram(1);
  ledger.dedupe(a, 1);
  ledger.beginProgram(2);
  assert.equal(ledger.dedupe(b, 2), b);
  ledger.beginProgram(3);
  ledger.recordOrigin("a.txt", 1, b.split("\n"), true);
  ledger.recordOrigin("b.txt", 1, b.split("\n"));
  assert.equal(ledger.dedupe(b, 3), b);
});
it("expires old results and disables deduplication with a zero window", () => {
  const text = Array.from({ length: 6 }, (_, i) => "substantive source " + i).join("\n");
  const ledger = new SeenLedger({ window: 1 });
  ledger.beginProgram(1);
  ledger.dedupe(text, 1);
  ledger.beginProgram(2);
  ledger.dedupe("different result", 2);
  ledger.beginProgram(3);
  assert.equal(ledger.dedupe(text, 3), text);
  const disabled = new SeenLedger({ window: 0 });
  for (let call = 1; call <= 3; call++) {
    disabled.beginProgram(call);
    assert.equal(disabled.dedupe(text, call), text);
  }
});
it("fits Unicode and custom ellipses within terminal columns", () => {
  for (const value of ["👩‍👩‍👦", "🇺🇸", "1️⃣", "界", "🫨", "é"]) {
    assert.ok(visibleWidth(value) > 0);
    for (let width = 0; width < 12; width++)
      assert.ok(visibleWidth(hardTruncate(value.repeat(12), width, "界界界")) <= width);
  }
});
it("shows every result and log line in the expanded card", () => {
  const theme = { fg: (_color, s) => s, bold: (s) => s };
  const result = Array.from({ length: 50 }, (_, i) => "result-" + String(i).padStart(2, "0")).join("\n");
  const long = "abcdefghijklmnopqrstuvwxyz".repeat(8);
  const logs = [long, "last log"];
  const card = renderSupernovaResult({ details: { ok: true, result, logs, trace: [] } }, { expanded: true }, theme, {});
  const rendered = card.render(40);
  const output = rendered.join("\n");
  for (const line of result.split("\n")) assert.ok(output.includes(line));
  assert.ok(output.includes("last log"));
  assert.ok(rendered.every((line) => visibleWidth(line) <= 40));
  const body = rendered.map((line) => line.replace(/^│ /, "").replace(/\s*│$/, "")).join("");
  assert.ok(body.includes(long));
});

it("kills command descendants and reports signal termination as failure", async (t) => {
  const { root, bridge } = await fixture(t);
  await assert.rejects(
    runCommand(["sh", "-c", "(trap '' TERM; sleep 0.5; printf escaped > escaped.txt) & wait"], {
      cwd: root,
      timeoutMs: 50,
    }),
    /timed out/,
  );
  await sleep(400);
  await assert.rejects(fs.access(path.join(root, "escaped.txt")), { code: "ENOENT" });
  const result = await bridge.call("bash", { command: "kill -TERM $$" });
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.details).exitCode, 143);
  assert.equal(bridge.getTrace().at(-1).ok, false);
});
it("does not bypass disabled, denied, or replaced host sessions", async (t) => {
  const { root } = await fixture(t);
  let sessionId = "own";
  let enabled = true;
  let capturedCalls = 0;
  const tool = {
    name: "protected",
    parameters: { type: "object" },
    sourceInfo: { source: "extension" },
    async execute() {
      capturedCalls++;
      return text("bypassed");
    },
  };
  const session = {
    sessionManager: { getSessionId: () => sessionId },
    getEvalBridgeToolNames: () => (enabled ? ["protected"] : []),
    getToolForEvalBridge: () => ({
      async execute() {
        return { ...text("permission denied"), isError: true };
      },
    }),
  };
  const pi = {
    pi: { AgentRegistry: { global: () => ({ list: () => [{ session }] }) } },
    getAllTools: () => [tool],
    registerTool() {},
  };
  const bridge = createHostBridge({ pi, config, getCwd: () => root });
  bridge.bindCallContext({ sessionManager: session.sessionManager });
  bridge.refreshTools();
  assert.equal((await bridge.call("protected", {})).ok, false);
  assert.equal(capturedCalls, 0);
  enabled = false;
  await assert.rejects(bridge.call("protected", {}), /unknown tool/);
  enabled = true;
  sessionId = "replacement";
  await assert.rejects(bridge.call("protected", {}), /unknown tool/);
  assert.equal(capturedCalls, 0);
});

it("respects Pi active-tool changes for native and captured executors", async (t) => {
  const { root } = await fixture(t);
  const definitions = [];
  let active = ["read", "captured"];
  let invoked = false;
  const pi = {
    registerTool(tool) {
      definitions.push(tool);
    },
    getAllTools: () => [{ name: "read", parameters: { type: "object" } }, ...definitions],
    getActiveTools: () => active,
  };
  const bridge = createHostBridge({ pi, config, getCwd: () => root });
  pi.registerTool({
    name: "captured",
    execute() {
      invoked = true;
      return text("executed");
    },
  });
  await fs.writeFile(path.join(root, "file.txt"), "available");
  bridge.refreshTools();
  assert.equal((await bridge.call("read", { path: "file.txt" })).value, "available");
  active = [];
  await assert.rejects(bridge.call("read", { path: "file.txt" }), /unknown tool/);
  await assert.rejects(bridge.call("captured", {}), /unknown tool/);
  assert.equal(invoked, false);
  active = ["captured"];
  assert.equal((await bridge.call("captured", {})).value, "executed");
});
