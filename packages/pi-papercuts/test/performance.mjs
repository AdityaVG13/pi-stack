// Local profiling only: real Pi tool components and terminal diffing, with a byte sink.
// PERF_HOST points to an installed Pi package; no model/provider/network calls are made.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";

const root = process.env.PERF_OUTPUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "papercuts-perf-"));

const pkg = path.resolve(process.env.PERF_PACKAGE ?? new URL("..", import.meta.url).pathname);

const host = process.env.PERF_HOST ?? path.join(os.homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent");

fs.mkdirSync(root, { recursive: true });

const fixture = process.env.PERF_FIXTURE ?? path.join(root, "workload");

fs.mkdirSync(fixture, { recursive: true });

const load = (file) => import(pathToFileURL(file).href);

const { loadExtensions } = await load(path.join(host, "dist/core/extensions/loader.js"));

const { wrapRegisteredTool } = await load(path.join(host, "dist/core/extensions/wrapper.js"));

const loaded = await loadExtensions([path.join(pkg, "index.js")], fixture);

if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));

const registered = loaded.extensions[0].tools.get("papercuts");

const { ToolExecutionComponent } = await load(path.join(host, "dist/modes/interactive/components/tool-execution.js"));

const { TuiMainScreen, TuiAltScreen, Text: HostText } = await load(path.join(host, "node_modules/@earendil-works/pi-tui/dist/index.js"));

const { initTheme } = await load(path.join(host, "dist/modes/interactive/theme/theme.js"));

initTheme("dark");

const tool = registered.definition;

const usesHostText = tool.renderCall({}, { fg: (_color, text) => text, bold: text => text }, {}) instanceof HostText;

const file = path.join(fixture, "work.jsonl"), ctx = { cwd: fixture };

const agentTool = wrapRegisteredTool(registered, { createToolContext: () => ctx });

process.env.PAPERCUTS_NOW = "2026-01-01T00:00:00.000Z";

const records = Array.from({ length: 10_000 }, (_, i) => ({ kind: "cut", id: "pc_" + i.toString(16).padStart(12, "0"), ts: "2025-01-01T00:00:00.000Z", agent: "pi", text: `Reason ${i} 中文 😀 é \u001b[31m` + " wrapping and rendering".repeat(12), tags: ["tooling"], severity: ["minor", "major", "blocker"][i % 3], cwd: fixture, repo: fixture }));

const serialized = records.map((record) => JSON.stringify(record) + "\n");

const spans = new Map();

if (process.env.PERF_TRACE_FS === "1") {
  for (const name of ["readFileSync", "openSync", "closeSync", "fsyncSync", "appendFileSync", "statSync", "fstatSync", "lstatSync", "realpathSync"]) {
    const original = fs[name];
    fs[name] = function (...args) {
      const start = performance.now();

      try { return original.apply(this, args); }
      finally {
        const span = spans.get(name) ?? { count: 0, ms: 0 };
        span.count++; span.ms += performance.now() - start; spans.set(name, span);
      }
    };
  }

  syncBuiltinESMExports();
}

const normalize = (value) => JSON.stringify(value).split(fixture).join("<fixture>").split(root).join("<artifacts>");

const hash = (value) => createHash("sha256").update(value).digest("hex");

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

const summaries = [], goldens = {};

const runs = Number(process.env.PERF_RUNS ?? 20);

const bulkOnly = process.env.PERF_SECTION === "bulk";

const uiOnly = process.env.PERF_SECTION === "ui-paths";

const responsiveness = process.env.PERF_SECTION === "responsiveness";

let coldCall;

async function measure(name, operation, iterations, setup = () => {}) {
  const samples = [], batches = [], synchronous = [];
  let outputBytes = 0, sampledHeapHigh = 0;
  const cpuStart = process.cpuUsage(), wallStart = performance.now();

  for (let run = -3; run < runs; run++) {
    await setup();
    const batch = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const pending = operation(i);
      const syncMs = performance.now() - start;
      const value = await pending;
      const elapsed = performance.now() - start;

      if (run >= 0) {
        samples.push(elapsed);
        synchronous.push(syncMs);

        batch.push(elapsed);

        for (const block of value?.content ?? []) if (block.type === "text") outputBytes += Buffer.byteLength(block.text);
      }
    }

    if (run >= 0) batches.push(quantile(batch.sort((a, b) => a - b), 0.95));
    sampledHeapHigh = Math.max(sampledHeapHigh, process.memoryUsage().heapUsed);
  }

  samples.sort((a, b) => a - b);
  synchronous.sort((a, b) => a - b);
  const total = samples.reduce((sum, ms) => sum + ms, 0);
  const cpu = process.cpuUsage(cpuStart);
  const row = { name, main_thread_p95_ms: quantile(synchronous, 0.95), sampled_heap_high: sampledHeapHigh, cpu_pct: (cpu.user + cpu.system) / ((performance.now() - wallStart) * 10), text_bytes_sec: outputBytes / total * 1000, conservative_extreme_tails: samples.length < 1000, samples: samples.length, p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), p99: quantile(samples, 0.99), p999: quantile(samples, 0.999), p9999: quantile(samples, 0.9999), max: samples.at(-1), ops_sec: samples.length / total * 1000, batch_p95: batches };
  summaries.push(row);
  console.log(`${name}: p95=${row.p95.toFixed(3)}ms p99=${row.p99.toFixed(3)}ms`);
}

const call = (args) => agentTool.execute("profile", { ...args, file }, undefined, undefined);

if (!bulkOnly && !uiOnly && !responsiveness) for (const size of [1, 100, 1000, 10_000]) {
  const original = serialized.slice(0, size).join("");
  fs.writeFileSync(file, original);
  const firstStart = performance.now();
  const firstPending = call({ action: "list", limit: 50 });
  const firstSync = performance.now() - firstStart;
  const listed = await firstPending;
  coldCall ??= { action: "list", wall_ms: performance.now() - firstStart, main_thread_ms: firstSync };
  goldens[`list-${size}`] = hash(normalize(listed));
  await measure(`list-${size}`, () => call({ action: "list", limit: 50 }), 5);
  await measure(`add-${size}`, (i) => call({ action: "add", text: `Profile add ${i}` }), 5, () => fs.writeFileSync(file, original));
  await measure(`resolve-${size}`, (i) => call({ action: "resolve", ids: [records[Math.min(i, size - 1)].id], note: "profile" }), 5, () => fs.writeFileSync(file, original));
  fs.writeFileSync(file, original);
  goldens[`add-${size}`] = hash(normalize(await call({ action: "add", text: "Golden add" })));
  goldens[`resolve-${size}`] = hash(normalize(await call({ action: "resolve", ids: [records[0].id], note: "golden" })));
}

if (bulkOnly) for (const count of [50, 500]) {
  const ids = records.slice(0, count).map(record => record.id);
  await measure(`resolve-batch-${count}`, () => call({ action: "resolve", ids, note: "bulk" }), 1, () => fs.writeFileSync(file, serialized.join("")));
  fs.writeFileSync(file, serialized.join(""));
  goldens[`resolve-batch-${count}`] = hash(normalize(await call({ action: "resolve", ids, note: "bulk" })));
}

fs.writeFileSync(file, serialized.join(""));

async function measurePaint(label, args, result, expanded, mode, iterations, expected, updates = true) {
  let bytes = 0, capture = false, firstPaint = "";

  const terminal = { columns: 120, rows: 40, write: (text) => {
    bytes += Buffer.byteLength(text);

    if (capture) firstPaint += text;
  }, hideCursor() {}, showCursor() {}, start() {}, stop() {} };

  const tui = new (mode === "main" ? TuiMainScreen : TuiAltScreen)(terminal);
  const view = new ToolExecutionComponent("papercuts", "profile", args, {}, tool, { requestRender() {} }, fixture);
  view.updateResult(result); view.setExpanded(expanded); tui.addChild(view);
  const name = `paint-${mode}-${label}-${expanded ? "expanded" : "compact"}`;
  tui.start(); capture = true;
  const start = performance.now(); tui.renderNow(); const firstMs = performance.now() - start;
  capture = false;

  if (!firstPaint.includes(expected)) throw new Error(`${name} did not paint the actual result`);
  goldens[name] = hash(normalize(view.render(120)));
  goldens[name + "-ansi"] = hash(normalize(firstPaint));
  await measure(name, () => { if (updates) view.updateResult(result); tui.renderNow(); }, iterations);
  Object.assign(summaries.at(-1), { terminal_bytes: bytes, first_paint_ms: firstMs });
  tui.stop({ preserveScreen: true });
}

if (!bulkOnly && !uiOnly && !responsiveness) for (const count of [5, 50, 1000]) {
  const result = await call({ action: "list", limit: count });

  for (const expanded of [false, true]) for (const mode of ["main", "alt"]) {
    await measurePaint(count, { action: "list", limit: count, file }, result, expanded, mode, count === 1000 && expanded ? 5 : 25, "Reason");
  }
}

if (!bulkOnly && !uiOnly && !responsiveness) for (const args of [{ action: "add", text: "Profile 中文 😀 " + "reason ".repeat(1000) }, { action: "resolve", ids: [records[10].id], note: "fixed" }, { action: "doctor" }, { action: "schema" }, { action: "prune" }, { action: "add", text: "" }]) {
  const result = await call(args);
  const label = result.isError ? "error" : args.action;

  for (const expanded of [false, true]) for (const mode of ["main", "alt"]) {
    await measurePaint(label, { ...args, file }, result, expanded, mode, 10, "papercuts");
  }
}

if (uiOnly) for (const mode of ["main", "alt"]) {
  const result = await call({ action: "list", limit: 50 });
  await measurePaint("steady-50", { action: "list", limit: 50, file }, result, true, mode, 25, "Reason", false);
  let bytes = 0;
  const terminal = { columns: 120, rows: 40, write: text => { bytes += Buffer.byteLength(text); }, hideCursor() {}, showCursor() {}, start() {}, stop() {} };
  const tui = new (mode === "main" ? TuiMainScreen : TuiAltScreen)(terminal);
  const body = "Streaming argument 中文 😀 " + "reason ".repeat(100);
  const args = { action: "add", text: body, file };
  const view = new ToolExecutionComponent("papercuts", "stream", args, {}, tool, { requestRender() {} }, fixture);
  tui.addChild(view); tui.start(); tui.renderNow();
  await measure(`stream-${mode}-compact-args`, i => { view.updateArgs({ ...args, text: body + " chunk".repeat(i + 1) }); tui.renderNow(); }, 50);
  summaries.at(-1).terminal_bytes = bytes;
  goldens[`stream-${mode}-compact-args`] = hash(normalize(view.render(120)));
  tui.stop({ preserveScreen: true });
}

if (responsiveness) for (const args of [{ action: "list", limit: 50 }, { action: "add", text: "responsiveness" }, { action: "resolve", ids: [records[0].id], note: "fixed" }]) {
  const delays = [];
  await measure(`responsive-${args.action}`, () => {
    const start = performance.now();
    const heartbeat = new Promise(resolve => setTimeout(() => { delays.push(performance.now() - start); resolve(); }, 0));
    const pending = call(args);

    return Promise.all([pending, heartbeat]).then(([result]) => result);
  }, 1, () => fs.writeFileSync(file, serialized.join("")));
  delays.splice(0, 3);
  delays.sort((a, b) => a - b);
  Object.assign(summaries.at(-1), { heartbeat_p95_ms: quantile(delays, 0.95), heartbeat_max_ms: delays.at(-1) });
}

fs.writeFileSync(path.join(root, "goldens.json"), JSON.stringify(goldens, null, 2));

const usage = process.resourceUsage();

fs.writeFileSync(path.join(root, "metrics.json"), JSON.stringify({ summaries, cold_call: coldCall, fs_instrumentation_scope: "calling thread only; worker I/O is not counted here", usage, memory: process.memoryUsage(), fs_spans: Object.fromEntries(spans), fingerprint: { timestamp: new Date().toISOString(), git_head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), source_hash: hash(["index.js", "contract.js", "params.js", "actions.js", "render.js", "store.js", "decode.js", "worker-client.js", "worker.js"].flatMap(name => fs.existsSync(path.join(pkg, name)) ? [fs.readFileSync(path.join(pkg, name), "utf8")] : []).join("\n")), build: "native Node ESM via Pi loader; CPU/heap profiler flags only on separately labeled profile runs", node: process.version, platform: process.platform, release: os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length, ram: os.totalmem(), free_ram: os.freemem(), fs_type: fs.statfsSync(root).type, package: JSON.parse(fs.readFileSync(path.join(pkg, "package.json"))).version, host: JSON.parse(fs.readFileSync(path.join(host, "package.json"))).version, renderer_tui: JSON.parse(fs.readFileSync(path.join(usesHostText ? host : pkg, "node_modules/@earendil-works/pi-tui/package.json"))).version, host_tui: JSON.parse(fs.readFileSync(path.join(host, "node_modules/@earendil-works/pi-tui/package.json"))).version, uses_host_text: usesHostText, extension_loading: "real Pi loadExtensions aliases and wrapRegisteredTool", runs, cache: "warm OS/JIT, three warmup batches", section: process.env.PERF_SECTION ?? "all", paint_scenario: "repeated result wrappers; ui-paths separately measures unchanged paints and growing compact args",  isolation: "shared macOS host; no OS tuning", excluded: "provider inference, AgentSession hook/permission latency, actual terminal emulator/GPU and terminal transport latency" } }, null, 2));

console.log("Artifacts: " + root);
