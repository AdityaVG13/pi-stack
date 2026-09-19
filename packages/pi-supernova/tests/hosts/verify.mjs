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

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

await fs.writeFile(path.join(root, "pixel.png"), Buffer.from(png, "base64"));

const sourceBody = "export function hostToken() {\n  return 1;\n}\n";

await fs.writeFile(path.join(root, "auth.js"), sourceBody);

const code = `
  await write("state.txt", "before");
  const checkpoint = await edit(async () => { await write("state.txt", "candidate"); throw Error("reject"); }).catch(error => ({ok:false,error:error.message}));
  await edit({path:"state.txt", edits:[{oldText:"before",newText:"after"}]});
  const a = read("state.txt"), b = read("state.txt");
  const text = await Promise.all([a,b]);
  const shell = await bash("printf smoke");
  const argv = await bash({command:"printf",args:["%s","literal $HOME"]});
  const source = await read({query:"hostToken",resolve:true});
  if (source.status !== "found") throw Error("source handoff failed");
  await write("caller.js","hostToken();");
  const edited = await edit(source.path,"return 1","return 2");
  const warning = await write("invalid.json","{");
  const diagnostic = await bash("printf auth.js:2; exit 1").catch(error => error.message);
  return {text,shell,argv,source,edited,warning,diagnostic,rawSource:await read("hostToken"),rejected:!checkpoint.ok,alias:typeof nova,image:await read("pixel.png")};
`;

await fs.writeFile(path.join(root, "program.js"), code);

function verify(result) {
  assert.equal(result.details.ok, true, result.details.error);
  assert.deepEqual(result.details.result.text, ["after", "after"]);
  assert.equal(result.details.result.shell, "smoke");
  assert.equal(result.details.result.argv, "literal $HOME");
  assert.equal(result.details.result.rejected, true);
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

assert.equal(child.status, 0, child.stderr + child.stdout);

verify(JSON.parse(await fs.readFile(path.join(root, "omp-result.json"), "utf8")));

console.log(JSON.stringify({ pi: "actual loader + CodeMode execution + TUI smoke passed", omp: "actual executable + session registry + CodeMode execution passed", network: "OMP denied network access", fixture: root }));
