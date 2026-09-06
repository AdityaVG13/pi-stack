// Actual-host checks are explicit: missing prerequisites fail, never skip.
// macOS sandbox-exec denies network access to the disposable OMP process.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const piRoot = process.env.PI_SUPERNOVA_PI_ROOT;
const omp = process.env.PI_SUPERNOVA_OMP;
assert.ok(piRoot && omp, "Set PI_SUPERNOVA_PI_ROOT to the installed Pi package and PI_SUPERNOVA_OMP to the OMP executable");
assert.equal(process.platform, "darwin", "This actual-host runner currently requires macOS network sandboxing");
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-hosts-"));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
await fs.writeFile(path.join(root, "pixel.png"), Buffer.from(png, "base64"));
const code = `
  await write("state.txt", "before");
  const checkpoint = await edit(async () => { await write("state.txt", "candidate"); throw Error("reject"); });
  await edit({path:"state.txt", edits:[{oldText:"before",newText:"after"}]});
  const a = read("state.txt"), b = read("state.txt");
  const text = await Promise.all([a,b]);
  const shell = await bash("printf smoke");
  return {text,shell,rejected:!checkpoint.ok,alias:typeof nova,image:await read("pixel.png")};
`;
await fs.writeFile(path.join(root, "program.js"), code);
function verify(result) {
  assert.equal(result.details.ok, true, result.details.error);
  assert.deepEqual(result.details.result.text, ["after", "after"]);
  assert.equal(result.details.result.shell, "smoke");
  assert.equal(result.details.result.rejected, true);
  assert.equal(result.details.result.alias, "undefined");
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
const result = await tools[0].execute("pi-contract", { code }, undefined, undefined, runner.createContext());
verify(result);
await assert.rejects(tools[0].execute("pi-failure", { code: 'throw Error("host-failure-sentinel");' }, undefined, undefined, runner.createContext()), /host-failure-sentinel/);
const { visibleWidth } = await importPi("node_modules/@earendil-works/pi-tui/dist/index.js");
const { initTheme } = await importPi("dist/modes/interactive/theme/theme.js");
const { ToolExecutionComponent } = await importPi("dist/modes/interactive/components/tool-execution.js");
initTheme("dark");
const row = new ToolExecutionComponent("supernova", "pi-contract", { code }, {}, tools[0], { requestRender() {} }, root);
row.markExecutionStarted(); row.setArgsComplete(); row.updateResult(result, false);
for (const expanded of [false, true]) {
  row.setExpanded(expanded);
  for (const width of [40, 80, 120, 240]) {
    const lines = row.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `Pi row exceeds ${width} columns`);
  }
}
const child = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", omp,
  "--cwd", root, "--mode", "rpc", "--tools", "read,edit,write,bash", "--no-lsp", "--no-pty", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-session",
  "-e", path.join(packageRoot, "index.js"), "-e", path.join(packageRoot, "tests/hosts/omp-smoke.ts")], {
  encoding: "utf8", timeout: 20000,
  env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "omp-config"), PI_SUPERNOVA_CONFIG: path.join(packageRoot, "src/config/config.default.json"), SUPERNOVA_HOST_PROGRAM: path.join(root, "program.js"), SUPERNOVA_HOST_OUTPUT: path.join(root, "omp-result.json") },
});
assert.equal(child.status, 0, child.stderr || String(child.error));
verify(JSON.parse(await fs.readFile(path.join(root, "omp-result.json"), "utf8")));
console.log(JSON.stringify({ pi: "actual loader + CodeMode execution + TUI smoke passed", omp: "actual executable + session registry + CodeMode execution passed", network: "OMP denied network access", fixture: root }));
