import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { createHostBridge } from "../host-bridge.js";

const root = path.resolve(import.meta.dirname, "..");

function bridge() {
  const b = createHostBridge({
    pi: { registerTool() {} },
    config: { maxBridgeCalls: 32, maxCallResultChars: 8000 },
    getCwd: () => root,
  });
  b.bindCallContext({}, undefined);
  b.resetCallBudget();
  return b;
}

describe("workspace jail", () => {
  it("rejects bash cwd outside workspace", async () => {
    const b = bridge();
    await assert.rejects(
      () => b.call("bash", { command: "pwd", cwd: "/tmp" }),
      /escapes workspace/,
    );
  });

  it("rejects grep path outside workspace", async () => {
    const b = bridge();
    await assert.rejects(
      () => b.call("grep", { pattern: "root", path: "/etc/passwd" }),
      /escapes workspace/,
    );
  });

  it("rejects read path escape via ..", async () => {
    const b = bridge();
    await assert.rejects(
      () => b.call("read", { path: "../../../../etc/passwd" }),
      /escapes workspace/,
    );
  });

  it("rejects reads and writes through symlinks that escape the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-jail-"));
    const workspace = path.join(tmp, "workspace");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(workspace, "escape"));
    const b = createHostBridge({
      pi: null,
      config: { maxBridgeCalls: 32, maxCallResultChars: 8000 },
      getCwd: () => workspace,
    });

    try {
      await assert.rejects(
        () => b.call("read", { path: "escape/secret.txt" }),
        /escapes workspace through symlink/,
      );
      await assert.rejects(
        () => b.call("write", { path: "escape/new.txt", content: "nope" }),
        /escapes workspace through symlink/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("allows read of package.json under cwd", async () => {
    const b = bridge();
    const r = await b.call("read", { path: "package.json" });
    assert.equal(r.ok, true);
    assert.match(r.value, /pi-supernova/);
  });
});
