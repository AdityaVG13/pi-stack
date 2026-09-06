import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runGuestProgram } from "../../src/runtime/runtime.js";
import { engineFixture, limits } from "../helpers/engine.mjs";

it("the guest exposes exactly four command bindings, without legacy helpers or dispatch escape hatches", async () => {
  const names = ["read", "edit", "write", "bash", "nova", "exec", "patch", "snap", "surface", "evidence", "speculate", "parallel", "pipeline"];
  const code = `return {${names.map(name => `${name}: typeof ${name}`).join(",")}};`;
  const result = await runGuestProgram({ code, nova: {}, config: limits });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.entries(result.result).filter(([, type]) => type !== "undefined").map(([name]) => name), ["read", "edit", "write", "bash"]);
});

it("read accepts familiar object arguments inside CodeMode and honors the requested line window", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("lines.txt", "one\ntwo\nthree\nfour\n");
  const result = await fixture.execute('return await read({path: "lines.txt", offset: 2, limit: 2});');
  assert.equal(result.details.ok, true, result.details.error);
  assert.match(result.details.result, /two\nthree/);
  assert.doesNotMatch(result.details.result, /one|four/);
});

it("one edit command applies a related edit set and returns only after all replacements are visible", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("pair.txt", "left=old\nright=old\n");
  const result = await fixture.execute(`
    await edit({path: "pair.txt", edits: [
      {oldText: "left=old", newText: "left=new"},
      {oldText: "right=old", newText: "right=new"}
    ]});
    return await read("pair.txt");
  `);
  assert.equal(result.details.ok, true, result.details.error);
  assert.equal(await fs.readFile(path.join(fixture.root, "pair.txt"), "utf8"), "left=new\nright=new\n");
  assert.match(result.details.result, /left=new\nright=new/);
});

it("an uncaught program failure is a host-visible failed tool execution, not a successful error-shaped result", async t => {
  const fixture = await engineFixture(t);
  await assert.rejects(fixture.execute('throw new Error("hard-failure-sentinel");'), /hard-failure-sentinel/);
});
