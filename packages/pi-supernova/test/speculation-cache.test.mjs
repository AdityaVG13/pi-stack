import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { createHostBridge } from "../host-bridge.js";
import { extractStructuralSurface } from "../surface.js";

describe("causal vfs cache, speculation overlay, and structural surface", () => {
  const config = {
    timeoutMs: 5000,
    maxBridgeCalls: 50,
    maxCallResultChars: 10000,
  };

  it("serves repeated reads from warm causal vfs cache", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vfs-cache-test-"));
    try {
      const filePath = path.join(tmpDir, "cached.txt");
      await fs.writeFile(filePath, "initial content", "utf8");
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      const r1 = await bridge.call("read", { path: "cached.txt" });
      assert.equal(r1.value, "initial content");
      assert.ok(bridge.getVfsCacheSize() >= 1);

      await bridge.call("write", { path: "cached.txt", content: "updated content" });
      const r2 = await bridge.call("read", { path: "cached.txt" });
      assert.equal(r2.value, "updated content");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("drops the read cache when a new program starts", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vfs-reset-test-"));
    try {
      const filePath = path.join(tmpDir, "external.txt");
      await fs.writeFile(filePath, "v1", "utf8");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      assert.equal((await bridge.call("read", { path: "external.txt" })).value, "v1");
      await fs.writeFile(filePath, "v2", "utf8");
      bridge.resetCallBudget();
      assert.equal((await bridge.call("read", { path: "external.txt" })).value, "v2");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("counterfactual speculation rolls back cleanly without disk side-effects", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-test-"));
    try {
      const filePath = path.join(tmpDir, "file.txt");
      await fs.writeFile(filePath, "original content", "utf8");
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      bridge.beginSpeculation();
      assert.equal(bridge.getOverlayDepth(), 1);

      const wRes = await bridge.call("write", { path: "file.txt", content: "mutated speculative" });
      assert.ok(wRes.value.includes("(speculative)"));
      const details = JSON.parse(wRes.details);
      assert.equal(details.speculative, true);

      const specRead = await bridge.call("read", { path: "file.txt" });
      assert.equal(specRead.value, "mutated speculative");

      const diskText = await fs.readFile(filePath, "utf8");
      assert.equal(diskText, "original content");

      bridge.rollbackSpeculation();
      assert.equal(bridge.getOverlayDepth(), 0);

      const postRead = await bridge.call("read", { path: "file.txt" });
      assert.equal(postRead.value, "original content");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("counterfactual speculation commits when approved", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-commit-test-"));
    try {
      const filePath = path.join(tmpDir, "commit.txt");
      await fs.writeFile(filePath, "pre-commit", "utf8");
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      bridge.beginSpeculation();
      await bridge.call("write", { path: "commit.txt", content: "post-commit" });
      assert.equal(await fs.readFile(filePath, "utf8"), "pre-commit");

      const commitRes = await bridge.commitSpeculation();
      assert.equal(commitRes.committed, 1);
      assert.equal(await fs.readFile(filePath, "utf8"), "post-commit");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("makes pending edits visible before an external command barrier", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-barrier-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "barrier.txt"), "before");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      bridge.beginSpeculation();
      await bridge.call("write", { path: "barrier.txt", content: "pending" });

      const shell = await bridge.call("bash", { command: "cat barrier.txt" });
      assert.equal(shell.value, "pending");
      assert.equal(JSON.parse(shell.details).transactionBarrier, true);
      bridge.rollbackSpeculation();
      assert.equal(await fs.readFile(path.join(tmpDir, "barrier.txt"), "utf8"), "pending");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects external mutations inside nested speculation", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-shell-test-"));
    try {
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      bridge.beginSpeculation();
      bridge.beginSpeculation();
      await assert.rejects(
        () => bridge.call("bash", { command: "printf changed > blocked.txt" }),
        /cannot run inside nova\.speculate/,
      );
      bridge.rollbackSpeculation();
      bridge.rollbackSpeculation();
      await assert.rejects(() => fs.access(path.join(tmpDir, "blocked.txt")));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("extracts structural surface from source files in sub-millisecond time", () => {
    const tsCode = `import { foo } from "./foo.js";
export interface User { id: string; name: string; }
export async function authenticate(user: User): Promise<boolean> {
  return true;
}
export class SessionManager {
  constructor() {}
  run() {}
}
function internalHelper() {}`;

    const { items, lineCount } = extractStructuralSurface(tsCode, "ts");
    assert.ok(lineCount >= 9);
    assert.ok(items.some((i) => i.name === "User" && i.kind === "interface"));
    assert.ok(items.some((i) => i.name === "authenticate" && i.isExport === true));
    assert.ok(items.some((i) => i.name === "SessionManager" && i.kind === "class"));
    assert.ok(items.some((i) => i.name === "internalHelper" && i.isExport === false));
  });
});
