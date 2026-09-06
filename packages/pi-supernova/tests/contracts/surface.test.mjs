import { it } from "node:test";
import assert from "node:assert/strict";
import extension, { registerCodeMode } from "../../index.js";
import { registrationHost } from "../helpers/engine.mjs";

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

it("CodeMode guidance advertises the four commands, not optional command families", () => {
  const { pi, tools } = registrationHost();
  registerCodeMode(pi);
  const tool = tools.get("supernova");
  const guidance = [tool.description, ...(tool.promptGuidelines || [])].join("\n");
  for (const name of ["read", "edit", "write", "bash"]) assert.ok(guidance.includes(name));
  for (const alias of ["nova.call", "nova.search", "nova.describe", "parallel(", "pipeline("]) {
    assert.equal(guidance.includes(alias), false, `Additional command surface leaked into model guidance: ${alias}`);
  }
});
