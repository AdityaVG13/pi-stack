// Local engine measurements, not provider-token or total-task benchmarks.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { packageFinalReturn } from "../../src/output/bottleneck.js";
import { createHostBridge } from "../../src/bridge/host-bridge.js";
import { runGuestProgram, warmGuestWorker, stopWarmGuestWorker } from "../../src/runtime/runtime.js";
import { packageDefaults } from "../../src/config/config.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import {programParameters} from "../../src/contract/program.js";
import { registerCodeMode } from "../../index.js";

async function legacyMeasurements() {

const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-engine-measure-"));

const config = { ...packageDefaults(), seenWindow: 0 };

const body = "unchanged source content\n".repeat(80);

await Promise.all(Array.from({ length: 8 }, (_, i) => fs.writeFile(path.join(root, `file${i}.txt`), body)));

const code = 'const jobs = [0,1,2,3,4,5,6,7].map(i => read("file"+i+".txt")); return (await Promise.all(jobs)).map(text => text.length);';

const measuredWaves = Number(process.env.SUPERNOVA_MEASURE_SAMPLES || 200);

assert.ok(Number.isSafeInteger(measuredWaves) && measuredWaves >= 20 && measuredWaves <= 10000, "SUPERNOVA_MEASURE_SAMPLES must be an integer from 20 to 10000");

const results = {};

for (const [name, batchRead, warm] of [["unbatchedCodeModeCold", false, false], ["coalescedCodeModeCold", true, false], ["coalescedCodeModePristineWarm", true, true]]) {
  const bridge = createHostBridge({ pi: null, config, getCwd: () => root });
  const samples = [];
  let bridgeCalls = 0;
  let resultChars = 0;

  for (let i = 0; i < measuredWaves + 10; i++) {
    bridge.resetCallBudget();
    bridge.ledger.beginProgram(i);
    bridgeCalls = 0;

    if (warm) await warmGuestWorker(config);
    else await stopWarmGuestWorker();
    const start = performance.now();

    const result = await runGuestProgram({ code, config, nova: { batchRead, call: (...args) => { bridgeCalls++;

 return bridge.call(...args); } } });

    const elapsed = performance.now() - start;
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, Array(8).fill(body.length));
    assert.equal(bridgeCalls, batchRead ? 1 : 8);
    assert.ok(!result.resultText.includes(body));
    resultChars = result.resultText.length;

    if (i >= 10) samples.push(elapsed);
  }

  samples.sort((a, b) => a - b);
  const percentile = p => samples[Math.ceil(samples.length * p) - 1];
  results[name] = { p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), p999Ms: percentile(.999), maxMs: samples.at(-1), samples, bridgeCalls, resultChars };
}

await stopWarmGuestWorker();

// Pure result packaging, measured separately from worker/filesystem latency.
// Hash the full typed value AND emitted text: speed must not shorten either.
const packaging = {};

const source = 'export const text = "λ😀\\path";\r\n'.repeat(120);

const payloads = {
  report: Array.from({length:200}, (_, i) => ({path:"src/unit-"+i+".js",line:i+1,ok:true,count:i})),
  source: {path:"src/unit.js",text:source,copy:source,complete:true},
};

for (const [name, value] of Object.entries(payloads)) {
  const packed = packageFinalReturn(value, [], config);
  assert.equal(packed.returnTruncated, false);
  assert.deepEqual(packed.returnValue, value);
  const samples = [];
  const iterations = 100;

  for (let wave = 0; wave < 110; wave++) {
    const start = performance.now();

    for (let i = 0; i < iterations; i++) packageFinalReturn(value, [], config);

    if (wave >= 10) samples.push((performance.now() - start) / iterations);
  }

  samples.sort((a,b) => a-b);
  packaging[name] = {p50Ms:samples[49],p95Ms:samples[94],iterations:samples.length*iterations,
    chars:packed.returnText.length,sha256:createHash("sha256").update(JSON.stringify(packed)).digest("hex")};
}

assert.ok(results.coalescedCodeModePristineWarm.p95Ms < results.unbatchedCodeModeCold.p95Ms, "Pristine-ready worker execution should beat cold startup for this fixture");

console.log(JSON.stringify({ machine: os.cpus()[0].model, platform: process.platform, node: process.version, measuredWaves, filesPerWave: 8, acceptance: "identical full per-file results; 8 to 1 bridge calls; pristine-warm p95 below unbatched cold", results, packaging, fixture: root, limits: "Local filesystem/worker benchmark; excludes prewarm time, model latency and provider tokens. Character counts are not token counts. Max is worst observed, not a real-time guarantee; extreme percentiles from small samples are conservative sentinels." }, null, 2));

}

// Opt-in research only: the candidate is NOT a shipping executor. Its command
// functions run on the host, so guest callbacks and streaming cannot cross this
// public JSON boundary. Keep those gaps visible rather than emulate parity.
async function phaseAMeasurements() {
  const {createSharedExecutor} = await import("../helpers/shared-runtime.mjs");
  const piRoot = process.env.PI_SUPERNOVA_PI_ROOT;
  assert.ok(piRoot, "Set PI_SUPERNOVA_PI_ROOT to the installed Pi 0.99+ package");
  const importPi = relative => import(pathToFileURL(path.join(piRoot, relative)).href);
  const pi = await importPi("dist/index.js");
  const { CodemodeSandbox, loadQuickJSWasm } = await importPi("node_modules/@earendil-works/pi-codemode/dist/index.js");
  const { AssistantMessageEventStream } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");
  const hostPackage = JSON.parse(await fs.readFile(path.join(piRoot, "package.json"), "utf8"));
  const runtimePackage = JSON.parse(await fs.readFile(path.join(piRoot, "node_modules/@earendil-works/pi-codemode/package.json"), "utf8"));
  const samples = Number(process.env.SUPERNOVA_MEASURE_SAMPLES || 30);
  assert.ok(Number.isSafeInteger(samples) && samples >= 20 && samples <= 10000);
  process.env.PI_SUPERNOVA_CONFIG = fileURLToPath(new URL("../../src/config/config.default.json", import.meta.url));
  const config = { ...packageDefaults(), seenWindow: 0 };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-phase-a-"));
  const body = "unchanged source λ😀\r\n".repeat(80);
  const large = "large source λ😀\r\n".repeat(60000);
  const source = "export function phaseATarget() {\n  return 41;\n}\n";
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => fs.writeFile(path.join(root, "file" + i + ".txt"), body)),
    fs.writeFile(path.join(root, "large.txt"), large),
    fs.writeFile(path.join(root, "target.js"), source),
  ]);
  const compileStart = performance.now();
  const wasm = await loadQuickJSWasm();
  const wasmCompileMs = performance.now() - compileStart;
  const toolSurface = () => session.agent.state.tools.map(({name,description,parameters}) => ({name,description,parameters}));
  const surfaceHash = () => createHash("sha256").update(JSON.stringify(toolSurface())).digest("hex");

  function candidateExtension(api) {
    for (const [name,coalesce] of [["phase_a_candidate",true],["phase_a_uncoalesced",false]]) {
      const execute = createSharedExecutor({CodemodeSandbox,wasm},{cwd:root,config,pi:{getAllTools:()=>api.getAllTools()},coalesce});
      api.registerTool({name,label:"Research candidate",description:"Offline shared-runtime pipeline probe",exposure:"model-only",
        parameters:programParameters(config),execute,
      });
    }
  }

  let blockedExecutions = 0;

  function permissionFixture(api) {
    api.registerTool({ name: "isearch", label: "Locator fixture", description: "Deterministic locator, NOT indexer timing", exposure: "codemode",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true },
      execute: async () => ({ content: [], details: { code: "OK", contexts: [{ path: "target.js", startLine: 1, endLine: 3 }] } }),
    });
    api.registerTool({ name: "phase_a_blocked", label: "Blocked fixture", description: "Must never run", exposure: "codemode",
      parameters: { type: "object", properties: {} }, execute: async () => {
        blockedExecutions++;

        return { content: [] };
      },
    });
    api.on("tool_call", event => event.toolName === "phase_a_blocked" ? { block: true, reason: "phase-a-permission" } : undefined);
  }

  const names = ["codemode", "supernova", "phase_a_candidate", "phase_a_uncoalesced", "read", "write", "edit", "bash", "grep"];
  const settings = pi.SettingsManager.inMemory({ defaultTools: names, compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await pi.ModelRuntime.create({ authPath: path.join(root, "fixture-auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerProvider("fixture", { api: "openai-responses", baseUrl: "https://fixture.invalid", apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });

  const loader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi.createCodemodeExtension({ models: false }), registerCodeMode, candidateExtension, permissionFixture], systemPrompt: "Offline Phase A." });

  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const { session } = await pi.createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: modelRuntime.getModel("fixture", "fixture"),
    settingsManager: settings, sessionManager: pi.SessionManager.inMemory(root), resourceLoader: loader });

  await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
  let request, completed, started, elapsed, prompts = 0;
  session.subscribe(event => {
    if (event.parentToolCallId) return;

    if (event.type === "tool_execution_start") started = performance.now();

    if (event.type === "tool_execution_end") { elapsed = performance.now() - started; completed = event; }
  });
  session.agent.streamFunction = async model => {
    const content = prompts++ % 2 === 0 ? [{ type: "toolCall", id: "phase-a-" + prompts, name: request.name, arguments: request.args }] : [{ type: "text", text: "DONE" }];

    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
      stopReason: prompts % 2 === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();

    return stream;
  };

  async function invoke(name, args) {
    request = { name, args };
    completed = undefined;
    // Discard earlier prompts, never accumulate benchmark-sized conversation history.
    session.agent.reset();
    await session.prompt("Run the offline fixture.");
    assert.ok(completed, "The actual AgentSession must emit the outer tool result");

    return { ...completed, elapsed };
  }

  function valueOf(event, native) {
    if (!native) return event.result.details.result;
    const text = event.result.content.slice(1).filter(block => block.type === "text").map(block => block.text).join("\n");

    try { return JSON.parse(text); }
    catch { return text; }
  }

  const paths = JSON.stringify(Array.from({ length: 8 }, (_, i) => "file" + i + ".txt"));

  const workloads = {
    noop: { code: "return 1;", native: "return 1;", expected: 1 },
    eightReads: { code: "return (await Promise.all(" + paths + ".map(p=>read(p)))).map(s=>s.length);",
      native: "return (await Promise.all(" + paths + ".map(path=>tools.read({path})))).map(s=>s.length);", expected: Array(8).fill(body.length) },
    largeRead: { code:'return (await read("large.txt",{complete:true})).length;', native:'return (await tools.read({path:"large.txt"})).length;', expected:large.length,
      nonEquivalent:true, boundary:"Native returns a truncated read including its notice; candidate/current read the entire 1.08M-character file. These timings are NOT equal-work speed comparisons." },
    twoProgramReads: {code:"return (await Promise.all(data.paths.map(p=>read(p)))).map(s=>s.length);",
      native:"return await Promise.all([0,1].map(async()=> (await Promise.all("+paths+".map(path=>tools.read({path})))).map(s=>s.length)));",
      params:{data:{paths:JSON.parse(paths)},programs:[{},{}]},expected:[Array(8).fill(body.length),Array(8).fill(body.length)],
      boundary:"Same readonly outputs; native runs one VM, Supernova/candidates use two fresh guests and two transaction boundaries. Not full semantic parity."},
    knownSource: { code: 'return (await read("target.js")).includes("phaseATarget");', native: 'return (await tools.read({path:"target.js"})).includes("phaseATarget");', expected: true },
    resolveSource: { code: 'const s=await read({query:"phaseATarget",resolve:true}); return s.status==="found" && s.text.includes("return 41");',
      native: 'const hits=await tools.grep({pattern:"phaseATarget",path:".",literal:true}); return hits.includes("target.js") && (await tools.read({path:"target.js"})).includes("return 41");', expected: true,
      boundary: "Same selected-source outcome, different retrieval contracts: native grep+read versus owned resolver." },
    editCommit: { code: 'await read("state.txt"); await edit("state.txt","before","after"); return (await read("state.txt")).trim();',
      native: 'await tools.read({path:"state.txt"}); await tools.edit({path:"state.txt",oldText:"before",newText:"after"}); return (await tools.read({path:"state.txt"})).trim();', expected: "after" },
  };

  const modes = ["native", "candidateUncoalesced", "candidate", "supernovaCold", "supernovaWarm"];
  const results = {};
  const firstCalls = {};
  const renderFixtures = {};
  const initialSurfaceHash = surfaceHash();

  try {
    for (const [workload, fixture] of Object.entries(workloads)) {
      const observations = Object.fromEntries(modes.map(mode => [mode, []]));

      for (let wave = 0; wave < samples + 3; wave++) {
        for (let slot = 0; slot < modes.length; slot++) {
          const mode = modes[(slot + wave) % modes.length];
          await new Promise(resolve => setImmediate(resolve));
          await stopWarmGuestWorker();
          const preparationStart = performance.now();

          if (mode === "supernovaWarm") await warmGuestWorker(config);
          const preparationMs = performance.now() - preparationStart;
          await fs.writeFile(path.join(root, "state.txt"), "before");
          const name = mode === "native" ? "codemode" : mode === "candidate" ? "phase_a_candidate" : mode === "candidateUncoalesced" ? "phase_a_uncoalesced" : "supernova";
          const args = mode === "native" ? {code:fixture.native} : {...fixture.params,code:fixture.code};
          const event = await invoke(name,args);
          assert.equal(event.isError, false, JSON.stringify(event.result));
          const value = valueOf(event, mode === "native");

          if (fixture.nonEquivalent && mode === "native") assert.ok(value > 0 && value < fixture.expected);
          else assert.deepEqual(value, fixture.expected, workload + ": " + mode);

          if (workload === "editCommit") assert.equal(await fs.readFile(path.join(root, "state.txt"), "utf8"), "after");
          const outputChars = event.result.content.filter(block => block.type === "text").map(block => block.text.length).reduce((a,b) => a+b, 0);
          const calls = event.result.details.calls ?? event.result.details.trace;
          const parts = event.result.details.programs;
          const research = event.result.details.research ?? (parts?.some(part=>part.details.research) ? parts.reduce((sum,part)=>({rpcCalls:sum.rpcCalls+(part.details.research?.rpcCalls??0),rpcBytes:sum.rpcBytes+(part.details.research?.rpcBytes??0),hostCallMs:sum.hostCallMs+(part.details.research?.hostCallMs??0)}),{rpcCalls:0,rpcBytes:0,hostCallMs:0}) : undefined);
          const sample = { value, ms: event.elapsed, preparationMs, outputChars, calls: calls.length, hostCalls: calls.map(call => call.durationMs ?? call.ms), research };
          firstCalls[mode] ??= sample;

          if (workload === "eightReads") renderFixtures[mode] = event.result;

          if (wave >= 3) observations[mode].push(sample);
        }
      }

      results[workload] = { boundary: fixture.boundary, modes: Object.fromEntries(modes.map(mode => {
        const rows = observations[mode];
        const sorted = rows.map(row => row.ms).sort((a,b) => a-b);

        return [mode, { p50Ms: sorted[Math.ceil(samples*.5)-1], p95Ms: sorted[Math.ceil(samples*.95)-1], maxMs: sorted.at(-1), observations: rows }];
      })) };
    }

    const probes = {};

    for (const mode of ["native", "candidate", "supernovaCold"]) {
      const native = mode === "native";
      const name = native ? "codemode" : mode === "candidate" ? "phase_a_candidate" : "supernova";
      const values = {};
      const environment = await invoke(name, { code: 'return {process:typeof process,timers:typeof setTimeout,clone:typeof structuredClone};' });
      assert.equal(environment.isError, false);
      values.environment = valueOf(environment, native);
      const bulk = await invoke(name, { code: native ? 'return (await tools.read({path:"large.txt"})).length;' : 'return (await read("large.txt",{complete:true})).length;' });
      assert.equal(bulk.isError, false);
      values.largeReadChars = valueOf(bulk, native);
      values.largeReadMs = bulk.elapsed;

      if (!native) {
        const copy = mode + "-copy.txt";
        const copied = await invoke(name,{code: 'const s=await read("large.txt",{complete:true});await write(data.copy,s);return s.length;',data:{copy}});
        assert.equal(copied.isError,false);
        assert.equal(await fs.readFile(path.join(root,copy),"utf8"),large,"Large transport must preserve every byte, including CRLF and Unicode");
      }

      if (!native) assert.equal(values.largeReadChars, large.length);
      const failed = await invoke(name, { code: native ? 'await tools.write({path:"rollback.txt",content:"candidate"}); throw Error("phase-a-rollback");' : 'await write("rollback.txt","candidate"); throw Error("phase-a-rollback");' });
      assert.equal(failed.isError, true);
      values.retainedWriteAfterFailure = await fs.readFile(path.join(root, "rollback.txt"), "utf8").catch(error => {
        assert.equal(error.code,"ENOENT");

        return null;
      });
      assert.equal(values.retainedWriteAfterFailure, native ? "candidate" : null);
      // A fresh path per mode avoids deleting the native tool's intentionally retained write.
      await fs.rename(path.join(root, "rollback.txt"), path.join(root, "native-retained.txt")).catch(error => assert.equal(error.code,"ENOENT"));

      if (!native) {
        const code = mode === "candidate" ? 'return await edit(async({write})=>{await write("checkpoint.txt","provisional");throw Error("reject");}).catch(e=>({error:e.message}));'
          : 'return await edit(async()=>{await write("checkpoint.txt","provisional");throw Error("reject");}).catch(e=>({error:e.message}));';

        const checkpoint = await invoke(name, {code});
        assert.equal(checkpoint.isError, false);
        values.checkpoint = checkpoint.result.details.result;
        assert.match(values.checkpoint.error,/^reject$/);
        await assert.rejects(fs.stat(path.join(root,"checkpoint.txt")),{code:"ENOENT"});
        const indexed = await invoke(name, { code: 'const s=await read({query:"phaseATarget",indexed:true});return s.status==="found" && s.text.includes("return 41");' });
        assert.equal(indexed.isError,false,JSON.stringify(indexed.result));
        assert.equal(valueOf(indexed,false),true);
        values.indexedLocator = "Owned source read verified using deterministic isearch metadata, not actual indexer timing.";
      } else {
        const blocked = await invoke(name, { code: 'return await tools.phase_a_blocked({}).catch(e=>e.message);' });
        assert.equal(blocked.isError,false);
        assert.match(valueOf(blocked,true),/phase-a-permission/);
      }

      probes[mode] = values;
    }

    assert.equal(blockedExecutions,0);
    const sandbox = new CodemodeSandbox({wasm,timeoutMs:2000,memoryLimitBytes:256*1048576});

    try {
      const noisy = await sandbox.execute('for(let i=0;i<200;i++)text("x".repeat(10000));return 1;');
      assert.equal(noisy.ok,true);
      assert.equal(noisy.output.map(item=>item.text.length).reduce((a,b)=>a+b,0),2000000);
      probes.sharedRuntimeOutput = { retainedChars:2000000, boundary:"Public runtime has no incremental output-budget callback; native clipping happens after collection." };
    } finally { await sandbox.close(); }

    // Completion aborts pending tool signals, but the shared runtime does not
    // wait for host callbacks that ignore them. Release manually after observing
    // the public result; no filesystem effects are involved in this probe.
    let release, pendingSignal, hostSettled = false;

    const pendingSandbox = new CodemodeSandbox({wasm,timeoutMs:2000,tools:[
      {name:"pending",execute:(_args,{signal})=>{pendingSignal=signal;

        return new Promise(resolve=>{release=()=>{hostSettled=true;resolve("released");};});}},
      {name:"gate",execute:()=>{
        assert.ok(release);

        return true;
      }},
    ]});

    try {
      const early = await pendingSandbox.execute('void tools.pending({});await tools.gate({});return 1;');
      assert.equal(early.ok,true);
      assert.equal(pendingSignal.aborted,true);
      assert.equal(hostSettled,false);
      release();
      probes.pendingHostCompletion = "Script returned after signalling abort but before host callback settled; Supernova must retain its drain.";
    } finally { release?.(); await pendingSandbox.close(); }

    const cancellation = new AbortController();
    let beginWait;
    const waiting = new Promise(resolve=>{beginWait=resolve;});

    const cancelSandbox = new CodemodeSandbox({wasm,timeoutMs:2000,tools:[{name:"wait",execute:(_args,{signal})=>new Promise((resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true});beginWait();
    })}]});

    try {
      const pending = cancelSandbox.execute('await tools.wait({});',{signal:cancellation.signal});
      await waiting;
      cancellation.abort();
      const cancelled = await pending;
      assert.equal(cancelled.ok,false);
      assert.equal(cancelled.error.kind,"aborted");
      probes.cancellation = "Public execution abort terminates VM and signals awaited tool cancellation.";
    } finally { await cancelSandbox.close(); }

    const batchData = {literal:"shared λ😀\r\n",seen:0};
    const batchCode = "data.seen++; return data;";
    const batched = await invoke("supernova",{code:batchCode,data:batchData,mergeData:true,programs:[{data:{job:1}},{data:{job:2}}]});
    assert.equal(batched.isError,false);
    const candidateBatch = await invoke("phase_a_candidate",{code:batchCode,data:batchData,mergeData:true,programs:[{data:{job:1}},{data:{job:2}}]});
    assert.equal(candidateBatch.isError,false);
    assert.deepEqual(valueOf(candidateBatch,false),batched.result.details.result);
    assert.equal(batchData.seen,0);
    probes.sharedInput = {value:valueOf(candidateBatch,false),supernovaBatchMs:batched.elapsed,candidateBatchMs:candidateBatch.elapsed,
      boundary:"Both use the existing program-batch admission/scheduling/budget runner over fresh isolated guests; candidate host lifecycle remains research-only."};

    const {executeSnap} = await import("../../src/context/snap.js");
    const {runCommand} = await import("../../src/fs/workspace.js");
    const searchSpawns = [];

    const resolved = await executeSnap({query:"phaseATarget",searchDir:root,root,run:async(args,options)=>{
      const start = performance.now();

      try {return await runCommand(args,options);}
      finally {searchSpawns.push({args,ms:performance.now()-start});}
    }});

    assert.equal(resolved.status,"found");
    probes.resolverSpawns = {searchSpawns,boundary:"One untimed diagnostic execution of the same resolver helper, not an AgentSession sample or a profiler of all stages."};

    pi.initTheme("dark");
    const rendering = {};

    for (const mode of ["native","supernovaCold"]) {
      const name = mode === "native" ? "codemode" : "supernova";
      const durations = [];

      for (let i=0;i<30;i++) {
        const start = performance.now();
        const row = new pi.ToolExecutionComponent(name,"phase-a-ui",{code:workloads.eightReads.code},{},session.getToolDefinition(name),{requestRender(){}},root);
        row.markExecutionStarted();row.setArgsComplete();row.updateResult(renderFixtures[mode],false);
        const lines = row.render(120);
        assert.ok(lines.length>0);
        durations.push(performance.now()-start);
      }

      durations.sort((a,b)=>a-b);
      rendering[mode] = {p50Ms:durations[14],p95Ms:durations[28],boundary:"Actual Pi tool component construction and first collapsed render, 120 columns; no terminal paint/provider latency."};
    }

    const surface = { before:initialSurfaceHash, after:surfaceHash(), tools:toolSurface().map(tool=>({name:tool.name,schemaChars:JSON.stringify(tool).length})) };
    assert.equal(surface.after,surface.before,"Tool schemas/descriptions must not change with invocation counters");

    const report = { surface, rendering, machine: os.cpus()[0].model, platform:process.platform,node:process.version,pi:hostPackage.version,codemode:runtimePackage.version,
      fixture:root,samples,wasmCompileMs,firstCalls,results,probes,
      limits:"Actual offline Pi AgentSession outer-tool interval, rotating modes, three warmup waves. No provider/model/network timing. WASM compiled before measurements. Warm preparation excluded and reported. Candidate reuses scoped guest commands and existing batch admission, with coalescing on/off controls; no cross-item streaming, full host lifecycle or peak-memory parity. Indexed locator is a fixture. Memory limits: native 256 MiB; candidate/current use package defaults. Not a shipping implementation or a speed guarantee." };

    const artifact = path.join(root,"phase-a.json");
    await fs.writeFile(artifact,JSON.stringify(report,null,2));
    console.log(JSON.stringify({artifact,...report},null,2));
  } finally {
    session.dispose();
    await new Promise(resolve=>setImmediate(resolve));
    await stopWarmGuestWorker();
  }
}

if (process.env.PI_SUPERNOVA_PHASE_A === "1") await phaseAMeasurements();
else await legacyMeasurements();
