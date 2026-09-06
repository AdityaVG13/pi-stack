import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";

it("edit callbacks retain filesystem checkpoints without exposing a speculate command", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "original");
  const result = await f.execute(`
    const rejected = await edit(async () => {
      await write("state.txt", "candidate");
      throw Error("candidate rejected");
    });
    const restored = await read("state.txt");
    const accepted = await edit(async () => {
      await write("state.txt", "accepted");
      return "validated";
    });
    return {rejected, restored, accepted, final: await read("state.txt")};
  `);
  assert.equal(result.details.result.rejected.ok, false);
  assert.match(result.details.result.rejected.error, /candidate rejected/);
  assert.equal(result.details.result.restored, "original");
  assert.deepEqual(result.details.result.accepted, { ok: true, committed: true, value: "validated" });
  assert.equal(result.details.result.final, "accepted");
});
