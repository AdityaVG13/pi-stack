import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { programParameters } from "../../src/contract/program.js";
import extension, { registerCodeMode } from "../../index.js";
import { registrationHost, registerExperimentalLedger, engineFixture } from "../helpers/engine.mjs";

it("the public extension registers one CodeMode tool, never four ordinary tool overrides", () => {
  const { pi, host, tools } = registrationHost();
  extension(pi, host);
  assert.deepEqual([...tools.keys()], ["supernova"], "The model must submit one CodeMode invocation, not ordinary native calls");
  assert.ok(tools.get("supernova").parameters.properties.code);
});

it("the shared extension initializes through the ordinary host API without injected Pi SDK factories", () => {
  const { pi, tools } = registrationHost();
  assert.doesNotThrow(() => extension(pi), "Pi-specific factory injection must not be the shared runtime contract");
  assert.deepEqual([...tools.keys()], ["supernova"]);
});

it("shipping defaults do not subscribe a context observer", () => {
  const { pi, handlers } = registrationHost();
  registerCodeMode(pi);
  assert.equal((handlers.get("context") ?? []).length, 0, "seenWindow 0 must not walk provider context");
});

it("an explicit retention window subscribes the context observer", () => {
  const { pi, handlers } = registrationHost();
  registerExperimentalLedger(pi);
  assert.ok((handlers.get("context") ?? []).length > 0, "opt-in ledger must observe context");
});

it("CodeMode guidance advertises the four commands, not optional command families", () => {
  const { pi, tools } = registrationHost();
  registerCodeMode(pi);
  const tool = tools.get("supernova");
  const guidance = [tool.description, ...(tool.promptGuidelines || [])].join("\n");

  for (const name of ["read", "edit", "write", "bash"]) assert.ok(guidance.includes(name));

  for (const needle of ["complete:true", "resolve:true", "append:true", "programs:", "json:", "args", "numbered window", "edit(view,text)", "edit(view,old,new)", "view.text is a span", 'read("symbol or question") = read({query,resolve:true})', "Values retain their types"]) {
    assert.ok(guidance.includes(needle), `standing reference dropped ${needle}`);
  }

  assert.equal(guidance.includes("Found opens a file"), false, "standing reference still teaches snap-to-file");

  for (const alias of ["nova.call", "nova.search", "nova.describe", "parallel(", "pipeline("]) {
    assert.equal(guidance.includes(alias), false, `Additional command surface leaked into model guidance: ${alias}`);
  }
});


it("external outlines follow read-only path semantics without granting mutations", async t => {
  const f = await engineFixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-reference-"));
  const file = path.join(external, "reference.js");
  const source = "export function referenceSentinel() { return 42; }\n";

  await fs.writeFile(file, source);
  await fs.symlink(file, path.join(f.root, "alias.js"));

  const result = await f.tool.execute("external-outline", {
    code: 'return {raw:await read(data.file),external:await read({path:data.file,outline:true}),alias:await read({path:"alias.js",outline:true})};',
    data: { file },
  }, undefined, undefined, { cwd: f.root });

  assert.equal(result.details.result.raw, source);
  assert.ok(result.details.result.external.items.some(item => item.name === "referenceSentinel"));
  assert.deepEqual(result.details.result.alias, result.details.result.external);

  await assert.rejects(f.tool.execute("external-edit-denied", {
    code: 'await write("pending.txt","pending"); await read({path:data.file,outline:true}); await edit(data.file,"42","99");',
    data: { file },
  }, undefined, undefined, { cwd: f.root }), /escapes workspace/);
  await assert.rejects(fs.stat(path.join(f.root, "pending.txt")), { code: "ENOENT" });
  await assert.rejects(f.tool.execute("external-write-denied", {
    code: 'await write(data.file,"must not overwrite reference");', data: { file },
  }, undefined, undefined, { cwd: f.root }), /escapes workspace/);
  assert.equal(await fs.readFile(file, "utf8"), source);
});


it("optional TypeBox availability does not change public validation or standing schema bytes", async t => {
  const load = Module._load;

  const blocked = t.mock.method(Module, "_load", function(name, ...args) {
    if (name === "typebox") throw Object.assign(new Error("optional peer unavailable"), { code: "MODULE_NOT_FOUND" });

    return load.call(this, name, ...args);
  });

  let fallback;

  try {
    ({ programParameters: fallback } = await import("../../src/contract/program.js?without-typebox"));
  } finally { blocked.mock.restore(); }

  const expected = JSON.parse(JSON.stringify(programParameters({ maxCodeChars: 1024 })));
  const actual = JSON.parse(JSON.stringify(fallback({ maxCodeChars: 1024 })));
  assert.equal(Object.hasOwn(expected, "additionalProperties"), false, "the public top-level contract must not depend on an optional peer");
  assert.deepEqual(actual, expected, "the fallback must preserve host validation and serialized standing definition costs");
  assert.equal(actual.properties.programs.items.additionalProperties, false, "individual program entries still reject unknown fields");
});
