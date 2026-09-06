import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runGuestProgram, warmGuestWorker } from "../../src/runtime/runtime.js";
import { engineFixture, limits } from "../helpers/engine.mjs";

it("a prewarmed worker never inherits a previous program's global mutations", async t => {
  const f = await engineFixture(t);
  await f.execute('globalThis.supernovaPollution = "bad"; return true;');
  await warmGuestWorker(limits);
  const result = await f.execute('return typeof globalThis.supernovaPollution;');
  assert.equal(result.details.result, "undefined");
});

it("a non-yielding program is terminated at its deadline", async () => {
  const result = await runGuestProgram({ code: "while (true) {}", nova: {}, config: { ...limits, timeoutMs: 100 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out|aborted/);
});

it("explicit external reads do not grant writes through an external symlink", async t => {
  const f = await engineFixture(t);
  const outside = await fs.mkdtemp(path.join(path.dirname(f.root), "supernova-outside-"));
  const target = path.join(outside, "external.txt");
  await fs.writeFile(target, "external");
  await fs.symlink(target, path.join(f.root, "alias.txt"));
  const result = await f.execute('return await read("alias.txt");');
  assert.equal(result.details.result, "external");
  await assert.rejects(f.execute('await write("alias.txt", "forbidden");'), /escapes workspace/);
  assert.equal(await fs.readFile(target, "utf8"), "external");
});

it("shell timeouts retain the output produced before termination", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.execute('return await bash({command:"printf timeout-diagnostic; sleep 10",timeoutMs:100});'), /timeout-diagnostic/);
});

it("shell session environment comes from the current execution context", async t => {
  const f = await engineFixture(t);
  const result = await f.tool.execute("environment", {
    code: `return await bash('printf "%s|%s|%s" "$PI_SESSION_ID" "$PI_MODEL" "$PI_REASONING_LEVEL"');`,
  }, undefined, undefined, {
    cwd: f.root,
    sessionManager: { getSessionId: () => "fixture-session", getSessionFile: () => undefined },
    model: { provider: "fixture-provider", id: "fixture-model" },
    thinkingLevel: "high",
  });
  assert.equal(result.details.result, "fixture-session|fixture-model|high");
});
