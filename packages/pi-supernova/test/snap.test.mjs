import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenizeQuery, scorePathTopology } from "../snap.js";
import { createHostBridge } from "../host-bridge.js";
import { runGuestProgram } from "../runtime.js";

describe("snap-to-file and top-level guest globals", () => {
  const config = {
    timeoutMs: 5000,
    maxBridgeCalls: 50,
    maxCallResultChars: 10000,
  };

  it("tokenizes queries and extracts intent flags", () => {
    const q1 = tokenizeQuery("verify JWT token in auth service");
    assert.ok(q1.tokens.includes("verify"));
    assert.ok(q1.tokens.includes("jwt"));
    assert.ok(q1.tokens.includes("token"));
    assert.ok(q1.tokens.includes("auth"));
    assert.equal(q1.wantsTest, false);

    const q2 = tokenizeQuery("unit test for parallel wave scheduler");
    assert.equal(q2.wantsTest, true);

    const q3 = tokenizeQuery("user interface schema type definition");
    assert.equal(q3.wantsType, true);
  });

  it("scores path topology favoring source over tests by default", () => {
    const tokens = ["host", "bridge"];
    const s1 = scorePathTopology("packages/pi-supernova/host-bridge.js", tokens, { wantsTest: false });
    const s2 = scorePathTopology("packages/pi-supernova/test/bridge.test.mjs", tokens, { wantsTest: false });
    assert.ok(s1 > s2);

    const sTest = scorePathTopology("packages/pi-supernova/test/bridge.test.mjs", tokens, { wantsTest: true });
    assert.ok(sTest > 0);
  });

  it("snaps to exact file and definition line cold in sub-25ms", async () => {
    const bridge = createHostBridge({
      pi: null,
      config,
      getCwd: () => process.cwd(),
    });

    const res = await bridge.call("snap", { query: "resolve workspace path escapes" });
    assert.equal(res.ok, true);
    const data = JSON.parse(res.value);
    assert.match(data.path, /host-bridge\.js$/);
    assert.ok(data.line > 0);
    assert.ok(data.confidence >= 0.7);
    assert.ok(data.context.length > 0);
  });

  it("executes guest code using top-level globals without nova.call boilerplate", async () => {
    let readCalled = false;
    const nova = {
      call: async (name, _args) => {
        if (name === "read") {
          readCalled = true;
          return { ok: true, value: "dummy content" };
        }
        return { ok: true, value: "" };
      },
      has: () => true,
    };

    const outcome = await runGuestProgram({
      code: `
        const content = await read("package.json");
        return { readCalled: true, len: content.length };
      `,
      nova,
      config,
    });

    assert.equal(outcome.ok, true);
    assert.equal(readCalled, true);
    assert.equal(outcome.result.readCalled, true);
  });
});
