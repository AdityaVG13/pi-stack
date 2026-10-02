// Actual-host checks are explicit: missing prerequisites fail, never skip.
// macOS sandbox-exec denies network access to the disposable OMP process.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const piRoot = process.env.PI_SUPERNOVA_PI_ROOT;

const omp = process.env.PI_SUPERNOVA_OMP;

assert.ok(piRoot && omp, "Set PI_SUPERNOVA_PI_ROOT to the installed Pi package and PI_SUPERNOVA_OMP to the OMP executable");

assert.equal(process.platform, "darwin", "This actual-host runner currently requires macOS network sandboxing");

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-hosts-"));

const hostVersion = JSON.parse(await fs.readFile(path.join(piRoot, "package.json"), "utf8")).version;

const [hostMajor, hostMinor] = hostVersion.split(".").map(Number);

const modernHost = hostMajor > 0 || hostMinor >= 99;

process.env.PI_SUPERNOVA_CONFIG = path.join(packageRoot, "src/config/config.default.json");

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

await fs.writeFile(path.join(root, "pixel.png"), Buffer.from(png, "base64"));

const sourceBody = "export function hostToken() {\n  return 1;\n}\n";

await fs.writeFile(path.join(root, "auth.js"), sourceBody);

await fs.writeFile(path.join(root,"large.txt"),"x".repeat(80000));

await fs.writeFile(path.join(root,"large.json"),JSON.stringify({rows:Array.from({length:2000},(_,id)=>({id,active:id%2===0,padding:"x".repeat(64)}))}));

const code = `
  await write("state.txt", "before");
  const checkpoint = await edit(async () => { await write("state.txt", "candidate"); throw Error("reject"); }).catch(error => ({ok:false,error:error.message}));
  await edit({path:"state.txt", edits:[{oldText:"before",newText:"after"}]});
  const a = read("state.txt"), b = read("state.txt");
  const text = await Promise.all([a,b]);
  const shell = await bash("printf smoke");
  const stagedCwd = "staged-cwd-" + process.pid;
  await write(stagedCwd + "/input.txt", "staged");
  const cwdResult = await bash({command:"cat",args:["input.txt"],cwd:stagedCwd});
  const argv = await bash({command:"printf",args:["%s","literal $HOME"]});
  const largeData = {lengths:(await read(["large.txt","large.txt"],{complete:true})).map(text=>text.length),
    active:(await read({path:"large.json",json:".rows"})).filter(row=>row.active).length};
  const source = await read({query:"hostToken",resolve:true});
  if (source.status !== "found") throw Error("source handoff failed");
  await write("caller.js","hostToken();");
  const edited = await edit(source.path,"return 1","return 2");
  const warning = await write("invalid.json","{");
  const diagnostic = await bash("printf auth.js:2; exit 1").catch(error => error.message);
  return {text,shell,cwdResult,argv,source,edited,warning,diagnostic,largeData,rawSource:await read("hostToken"),rejected:!checkpoint.ok,alias:typeof nova,image:await read("pixel.png")};
`;

await fs.writeFile(path.join(root, "program.js"), code);

await fs.writeFile(path.join(root, "diagnostic.js"), "// caller source\n\nasync () => {\n  return await read('missing-diagnostic.txt');\n}");

function verify(result) {
  assert.equal(result.details.ok, true, result.details.error);
  assert.deepEqual(result.details.result.text, ["after", "after"]);
  assert.equal(result.details.result.shell, "smoke");
  assert.equal(result.details.result.cwdResult, "staged");
  assert.equal(result.details.result.argv, "literal $HOME");
  assert.equal(result.details.result.rejected, true);
  assert.deepEqual(result.details.result.largeData,{lengths:[80000,80000],active:1000});
  assert.equal(result.details.result.alias, "undefined");
  assert.equal(result.details.result.source.path, "auth.js");
  assert.equal(result.details.result.source.text, sourceBody);
  assert.match(result.details.result.edited, /hostToken also referenced in .*caller\.js:1/);
  assert.match(result.details.result.warning, /check:/);
  assert.match(result.details.result.diagnostic, /return 2/);
  assert.equal(result.details.result.rawSource.path, "auth.js");
  assert.ok(result.details.result.rawSource.text.includes(sourceBody.replace("return 1", "return 2")));
  assert.equal(result.content.find(block => block.type === "image")?.data, png);
  assert.ok(result.details.trace.some(call => Array.isArray(call.args.path)), "Actual host must retain automatic read coalescing");
}

const importPi = relative => import(pathToFileURL(path.join(piRoot, relative)).href);

const { loadExtensions } = await importPi("dist/core/extensions/loader.js");

const loaded = await loadExtensions([path.join(packageRoot, "index.js")], root);

assert.deepEqual(loaded.errors, []);

const tools = [...loaded.extensions[0].tools.values()].map(tool => tool.definition);

assert.deepEqual(tools.map(tool => tool.name), ["supernova"]);

const { ExtensionRunner } = await importPi("dist/core/extensions/runner.js");

const { SessionManager } = await importPi("dist/core/session-manager.js");

const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, SessionManager.inMemory(root), undefined);

// Supply the registry callbacks that AgentSession normally binds after loading.
// This verifies the actual runner context, not provider or third-party hooks.
runner.bindCore({
  getAllTools: () => tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  getActiveTools: () => ["supernova"], getThinkingLevel: () => undefined,
}, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined });

const { validateToolArguments } = await importPi("node_modules/@earendil-works/pi-ai/dist/utils/validation.js");

const fileArgs = validateToolArguments(tools[0], {name:"supernova",arguments:{file:"program.js"}});

assert.deepEqual(fileArgs,{file:"program.js"});

const result = await tools[0].execute("pi-contract", fileArgs, undefined, undefined, runner.createContext());

verify(result);

await assert.rejects(tools[0].execute("pi-location", { file: "diagnostic.js" }, undefined, undefined, runner.createContext()), /no such file.*\(line 4:10\)/);

const projected = await tools[0].execute("pi-json-data", { code: 'await write("report.json",JSON.stringify(data)); return await read({path:"report.json",json:".answer"});', data: { answer: "literal `backticks` ${braces}" } }, undefined, undefined, runner.createContext());

assert.equal(projected.details.result, "literal `backticks` ${braces}");

const batchArgs = validateToolArguments(tools[0],{name:"supernova",arguments:{programs:[{code:"return data;",data:false},{code:"return 42;"}]}});

const batched = await tools[0].execute("pi-batch",batchArgs,undefined,undefined,runner.createContext());

assert.deepEqual(batched.details.result,[false,42]);

const sharedArgs = validateToolArguments(tools[0],{name:"supernova",arguments:{
  code:'data.seen++; return data;',data:{seen:0,literal:"shared λ😀\r\n"},mergeData:true,
  programs:[{data:{job:1}},{data:{job:2}}],
}});

const sharedBatch = await tools[0].execute("pi-shared-batch",sharedArgs,undefined,undefined,runner.createContext());

assert.equal(sharedBatch.details.ok,true);

assert.deepEqual(sharedBatch.details.result,[{seen:1,literal:"shared λ😀\r\n",job:1},{seen:1,literal:"shared λ😀\r\n",job:2}]);

assert.equal(sharedArgs.data.seen,0,"actual host inputs must not be mutated");

const stoppedBatch = await tools[0].execute("pi-batch-stop",{programs:[{code:'return await read("pixel.png");'},{code:'throw Error("batch-stop");'},{code:"return 9;"}]},undefined,undefined,runner.createContext());

assert.equal(stoppedBatch.details.ok,false);

 assert.equal(stoppedBatch.isError,true);

assert.equal(stoppedBatch.details.attempted,2);

assert.equal(stoppedBatch.content.find(block=>block.type==="image")?.data,png);

// A direct execute() call misses Pi's result-status projection. Drive the real
// AgentSession tool loop with a deterministic local stream, without a provider.
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } = await importPi("dist/index.js");

const { AssistantMessageEventStream } = await importPi("node_modules/@earendil-works/pi-ai/dist/index.js");

const { registerCodeMode } = await import(pathToFileURL(path.join(packageRoot, "index.js")).href);

const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "fixture-auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });

modelRuntime.registerProvider("fixture", { api: "openai-responses", baseUrl: "https://fixture.invalid", apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });

const settings = SettingsManager.inMemory({ defaultTools:["supernova"], compaction: { enabled: false }, retry: { enabled: false } });

let nestedApi, beginNestedRead, nestedAborted = false;

const remoteExecutions = [];

function nestedFixture(pi) {
  nestedApi = pi;
  pi.on("tool_call", event => {
    if (event.toolName === "read" && event.input.path === "blocked") return {block:true,reason:"permission-denied-sentinel"};
  });
  pi.on("tool_result", event => {
    if (event.toolName === "read" && event.input.path === "redact") return {content:[{type:"text",text:"masked-by-host"}]};
  });
}

const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [registerCodeMode,nestedFixture], systemPrompt: "Offline host regression." });

await loader.reload();

assert.deepEqual(loader.getExtensions().errors, []);

const sessionOptions = { cwd: root, agentDir: root, modelRuntime, model: modelRuntime.getModel("fixture", "fixture"), settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader: loader };

if (!modernHost) sessionOptions.tools = ["supernova"];

const { session } = await createAgentSession(sessionOptions);

await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });

let requests = 0, completed, nextCall;

const nestedEvents = [];

session.subscribe(event => {
  if (event.type === "tool_execution_end") {
    completed = event;

    if (event.parentToolCallId) nestedEvents.push(event);
  }
});

session.agent.streamFunction = async model => {
  const content = requests++ % 2 === 0 ? [{ type: "toolCall", id: "batch-status-" + requests, name: "supernova", arguments: nextCall ?? { programs: [
    { code: 'await write("kept-host.txt", "committed"); return {sentinel:"prior-result",image:await read("pixel.png")};' },
    { code: 'throw Error("host-batch-sentinel");' },
    { code: 'await write("never-host.txt", "bad");' },
  ] } }] : [{ type: "text", text: "DONE" }];

  const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason: requests % 2 === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end();

  return stream;
};

try {
  await session.prompt("Run the offline batch.");
  assert.equal(completed?.isError, true, "the host must not turn a failed batch green");
  assert.equal(completed.result.details.attempted, 2);
  assert.equal(completed.result.details.programs[0].details.result.sentinel, "prior-result");
  assert.equal(completed.result.content.find(block => block.type === "image")?.data, png);
  assert.equal(await fs.readFile(path.join(root, "kept-host.txt"), "utf8"), "committed");
  await assert.rejects(fs.stat(path.join(root, "never-host.txt")), { code: "ENOENT" });

  for (const parallel of [false,true]) {
    nextCall = {parallel,programs:[
      {code:'console.log("x".repeat(50000)); return 1;'},
      {code:`await write("logged-host-${parallel}.txt","committed"); return 2;`},
    ]};
    completed = undefined;
    await session.prompt("Run the clipped-log batch.");
    assert.equal(completed?.isError,false,"log clipping must not turn a completed batch red");
    assert.equal(completed.result.details.logTruncated,true);
    assert.equal(completed.result.details.attempted,2);
    assert.equal(await fs.readFile(path.join(root,`logged-host-${parallel}.txt`),"utf8"),"committed");
  }

  if (modernHost) {
    nestedApi.registerTool({
      name:"read",label:"Remote read",description:"Read a remote test value",exposure:"codemode",
      parameters:{type:"object",properties:{path:{type:"string",enum:["ok","blocked","error","redact","large","wait"]}},required:["path"]},
      outputSchema:{type:"object"},annotations:{readOnlyHint:true},
      async execute(_id,args,signal) {
        remoteExecutions.push(args.path);

        if (args.path === "wait") return new Promise((resolve,reject) => {
          assert(signal);
          signal.addEventListener("abort",()=>{nestedAborted=true;reject(new Error("nested-read-aborted"));},{once:true});
          beginNestedRead();
        });

        return {content:[{type:"text",text:args.path === "error" ? "remote-error-sentinel" : "ui-only"}],
          isError:args.path === "error",structuredContent:args.path === "large" ? {text:"x".repeat(100000)} : {answer:42},
          details:args.path === "large" ? {batch:true,items:["ui-only"]} : undefined};
      },
    });
    nestedApi.setActiveTools(["supernova"]);
    assert.equal(nestedApi.getAllTools().find(tool=>tool.name === "supernova").exposure,"model-only");
    nextCall = {code:`const good=await read({path:"ok"}); const errors={};
      for (const p of ["blocked","invalid","error"]) { try { await read({path:p}); } catch(e) { errors[p]=e.message; } }
      const redacted=await read({path:"redact"}); const large=await read({path:"large"});
      return {good,errors,redacted,large:{type:typeof large,length:large.length,clipped:large.includes("truncated")}};`};
    await session.prompt("Exercise native nested-tool validation and results.");
    assert.equal(completed.isError,false,completed.result.content.filter(part=>part.type==="text").map(part=>part.text).join("\n"));
    const nestedResult = completed.result.details.result;
    assert.deepEqual(nestedResult.good,{answer:42});
    assert.match(nestedResult.errors.blocked,/permission-denied-sentinel/);
    assert.match(nestedResult.errors.invalid,/validation|allowed|enum|constant/i);
    assert.match(nestedResult.errors.error,/remote-error-sentinel/);
    assert.equal(nestedResult.redacted,"masked-by-host");
    assert.equal(nestedResult.large.type,"string");
    assert.equal(nestedResult.large.clipped,true);
    assert.ok(nestedResult.large.length<=65536);
    assert.deepEqual(remoteExecutions,["ok","error","redact","large"]);
    assert.ok(nestedEvents.length>0);
    assert.ok(nestedEvents.every(event=>event.parentToolCallId===completed.toolCallId));
    const messages = session.agent.state.messages;
    assert.ok(messages.find(message=>message.role==="toolResult" && message.toolCallId===completed.toolCallId)?.nestedCalls);
    assert.ok(nestedEvents.every(event=>!messages.some(message=>message.role==="toolResult" && message.toolCallId===event.toolCallId)));

    const waiting = new Promise(resolve=>{beginNestedRead=resolve;});
    nextCall = {code:'await write("cancelled-owned.txt","pending"); await read({path:"wait"});'};
    const pending = session.prompt("Abort the waiting nested read.");
    await waiting;
    await session.abort();
    await pending;
    assert.equal(nestedAborted,true);
    await assert.rejects(fs.stat(path.join(root,"cancelled-owned.txt")),{code:"ENOENT"});
  }
} finally { session.dispose(); }


const hostFailure = await tools[0].execute("pi-failure", { code: 'throw Error("host-failure-sentinel");' }, undefined, undefined, runner.createContext()).then(() => assert.fail("must reject"), error => error);

assert.match(hostFailure.message, /host-failure-sentinel/);

const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/index.js");

const { initTheme } = await importPi("dist/modes/interactive/theme/theme.js");

const { ToolExecutionComponent } = await importPi("dist/modes/interactive/components/tool-execution.js");

initTheme("dark");

const row = new ToolExecutionComponent("supernova", "pi-contract", { file:"program.js" }, {}, tools[0], { requestRender() {} }, root);

row.markExecutionStarted();

 row.setArgsComplete();

 row.updateResult(result, false);

for (const expanded of [false, true]) {
  row.setExpanded(expanded);

  for (const width of [40, 80, 120, 240]) {
    const lines = row.render(width);
    assert.ok(lines.length > 0);

    for (const line of lines) assert.ok(visibleWidth(line) <= width, `Pi row exceeds ${width} columns`);
  }
}

// Drive the real self-render shell through progress, completion, expansion,
// resize and invalidation, using a registered program and committed artifacts.
const liveFrames = [];

const uiResult = await tools[0].execute("pi-live-ui",{code:'for(let i=1;i<=14;i++)await write("ui-"+i+".txt","change "+i+"\\n");await new Promise(r=>setTimeout(r,120));return "checks passed";'},undefined,frame=>liveFrames.push(frame),runner.createContext());

const liveFrame = liveFrames.findLast(frame=>frame.details.trace.length===14);

assert.ok(liveFrame,"Actual execution must provide the settled live trace before completion");

const liveRow = new ToolExecutionComponent("supernova","pi-live-ui",{code:"write batch"},{},tools[0],{requestRender(){}},root);

liveRow.markExecutionStarted();

liveRow.setArgsComplete();

liveRow.updateResult(liveFrame,true);

const liveText = liveRow.render(120).join("\n");

const retainedCard = liveRow.resultRendererComponent;

liveRow.updateResult(uiResult,false);

assert.equal(liveRow.resultRendererComponent,retainedCard,"Host updates should reuse one lifecycle card");

const completeText = liveRow.render(120).join("\n");

const uiPaths = text=>[...new Set(text.match(/ui-\d+\.txt/g))];

assert.deepEqual(uiPaths(liveText),Array.from({length:8},(_,i)=>"ui-"+(i+7)+".txt"));

assert.deepEqual(uiPaths(completeText),uiPaths(liveText),"The host must not jump from latest live calls to earliest final calls");

assert.doesNotMatch(completeText,/checks passed/,"Successful call cards keep returned content behind expansion");

assert.ok(liveRow.render(80).length<=28,"Collapsed host card must remain compact after a multi-file write");

liveRow.setExpanded(true);

assert.match(liveRow.render(120).join("\n"),/ui-1\.txt/);

liveRow.invalidate();

assert.match(liveRow.render(120).join("\n"),/checks passed/);

for(const width of [1,2,40,80,120])for(const line of liveRow.render(width))assert.ok(visibleWidth(line)<=width);

assert.equal(await fs.readFile(path.join(root,"ui-14.txt"),"utf8"),"change 14\n");

const batchRow = new ToolExecutionComponent("supernova","pi-batch-stop",{programs:[{code:"return 1;"}]},{},tools[0],{requestRender(){}},root);

batchRow.markExecutionStarted();

 batchRow.setArgsComplete();

 batchRow.updateResult(stoppedBatch,false);

for (const expanded of [false,true]) {
  batchRow.setExpanded(expanded);

  for (const width of [40,80,120,240]) for (const line of batchRow.render(width)) assert.ok(visibleWidth(line)<=width);
}

// Pi strips isError from the result argument and supplies it in render context.
// Exercise that actual host handoff, not a result with a synthetic isError field.
const errorRow = new ToolExecutionComponent("supernova","pi-failure",{code:'throw Error("host-failure-sentinel");'},{},tools[0],{requestRender(){}},root);

errorRow.markExecutionStarted();

errorRow.setArgsComplete();

errorRow.updateResult({isError:true,content:[{type:"text",text:hostFailure.message}]},false);

for (const expanded of [false,true]) {
  errorRow.setExpanded(expanded);
  const text = errorRow.render(120).join("\n");
  assert.match(text,/failed/);
  assert.match(text,/host-failure-sentinel/);
  assert.doesNotMatch(text,/JavaScript-only execution|nova: complete/);

  for (const width of [40,80,120,240]) for (const line of errorRow.render(width)) assert.ok(visibleWidth(line)<=width);
}

await fs.writeFile(path.join(root, "auth.js"), sourceBody);

// Exercise OMP's real approval gate rather than disabling it. Only the known
// fixture tool is approved in this disposable, network-denied process.
function runOmp(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("OMP smoke timed out\n" + stdout + stderr)); }, 20000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      stdout += line + "\n";
      let event;

      try { event = JSON.parse(line); } catch { return; }

      if (event.type !== "extension_ui_request") return;
      const approved = event.method === "select" && event.title === "Allow tool: supernova" && event.options?.includes("Approve");
      child.stdin.write(JSON.stringify({type:"extension_ui_response",id:event.id,...(approved ? {value:"Approve"} : {cancelled:true})}) + "\n");

      if (!approved) stderr += "Unexpected approval request: " + line + "\n";
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", status => { clearTimeout(timer); lines.close(); resolve({status,stdout,stderr}); });
  });
}

const child = await runOmp("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", omp,
  "--cwd", root, "--mode", "rpc", "--tools", "read,edit,write,bash", "--no-lsp", "--no-pty", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--session", path.join(root, "session.jsonl"),
  "-e", path.join(packageRoot, "index.js"), "-e", path.join(packageRoot, "tests/hosts/omp-smoke.ts")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "omp-config"), PI_SUPERNOVA_CONFIG: path.join(packageRoot, "src/config/config.default.json"), SUPERNOVA_HOST_PROGRAM: path.join(root, "program.js"), SUPERNOVA_HOST_OUTPUT: path.join(root, "omp-result.json") },
});

const hostOutput = await fs.readFile(path.join(root,"omp-result.json"),"utf8").catch(()=>"");

assert.equal(child.status, 0, hostOutput + "\n" + child.stderr + child.stdout);

verify(JSON.parse(await fs.readFile(path.join(root, "omp-result.json"), "utf8")));

console.log(JSON.stringify({ hostVersion, modernNestedExecution:modernHost, pi: "actual loader + AgentSession success/failure projection + CodeMode execution + TUI smoke passed", omp: "actual executable + session registry + CodeMode execution passed", network: "OMP denied network access", fixture: root }));
