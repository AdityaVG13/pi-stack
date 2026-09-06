import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";

it("bash retains literal argv execution without an exec alias or argument mutation", async t => {
  const f = await engineFixture(t);
  const literal = "$(printf injected); 'quoted' $HOME";
  const args = { command: "printf", args: ["%s", literal] };
  const result = await f.execute(`
    const args = ${JSON.stringify(args)};
    const first = await bash(args);
    const second = await bash(args);
    return {first,second,args,alias:typeof exec};
  `);
  assert.deepEqual(result.details.result, { first: literal, second: literal, args, alias: "undefined" });
});
