import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

  it("snaps to the defining file and line, not the busiest call site", async () => {
    const bridge = createHostBridge({
      pi: null,
      config,
      getCwd: () => process.cwd(),
    });

    // host-bridge.js calls resolveWorkspacePath a dozen times; workspace.js defines it once.
    const res = await bridge.call("snap", { query: "resolve workspace path escapes" });
    assert.equal(res.ok, true);
    const data = JSON.parse(res.value);
    assert.match(data.path, /workspace\.js$/);
    assert.match(data.signature, /function resolveWorkspacePath/);
    assert.ok(data.line > 0);
    assert.ok(data.confidence >= 0.7);
    assert.ok(data.context.length > 0);
  });

  it("finds files inside an explicitly targeted hidden directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-hidden-test-"));
    try {
      await fs.mkdir(path.join(tmpDir, ".fixtures"));
      await fs.writeFile(path.join(tmpDir, ".fixtures", "hidden.js"), "export const hiddenNebulaAnchor = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const res = await bridge.call("snap", { query: "hidden nebula anchor", path: ".fixtures" });
      assert.match(JSON.parse(res.value).path, /hidden\.js$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ranks explicitly targeted hidden files by content", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-hidden-content-test-"));
    try {
      await fs.mkdir(path.join(tmpDir, ".fixtures"));
      await fs.writeFile(path.join(tmpDir, ".fixtures", "a.js"), "export const unrelatedValue = true;\n");
      await fs.writeFile(path.join(tmpDir, ".fixtures", "b.js"), "export const exactQuasarHandshake = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const res = await bridge.call("snap", { query: "quasar handshake", path: ".fixtures" });
      assert.match(JSON.parse(res.value).path, /b\.js$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses an explicitly targeted .git directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-git-metadata-test-"));
    try {
      await fs.mkdir(path.join(tmpDir, ".git"));
      await fs.writeFile(path.join(tmpDir, ".git", "config"), "privateNebulaToken = secret\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      await assert.rejects(
        () => bridge.call("snap", { query: "private nebula token", path: ".git" }),
        /cannot search Git metadata/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes nested Git metadata below an explicit hidden root", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-nested-git-test-"));
    try {
      const hiddenRoot = path.join(tmpDir, ".fixtures");
      await fs.mkdir(path.join(hiddenRoot, "nested", ".git"), { recursive: true });
      await fs.writeFile(path.join(hiddenRoot, "nested", ".git", "config"), "privateNebulaToken = secret\n");
      await fs.writeFile(path.join(hiddenRoot, "visible.js"), "export const visibleFallback = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const res = await bridge.call("snap", { query: "private nebula token", path: ".fixtures" });
      assert.match(JSON.parse(res.value).path, /visible\.js$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not infer hidden-file permission from a hidden workspace ancestor", async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-hidden-ancestor-test-"));
    const workspace = path.join(parentDir, ".workspace");
    try {
      await fs.mkdir(path.join(workspace, ".secrets"), { recursive: true });
      await fs.writeFile(path.join(workspace, ".secrets", "token.js"), "export const privateNebulaToken = true;\n");
      await fs.writeFile(path.join(workspace, "visible.js"), "export const visibleFallback = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => workspace });
      const res = await bridge.call("snap", { query: "private nebula token" });
      assert.match(JSON.parse(res.value).path, /visible\.js$/);
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });

  it("does not scan hidden files from the workspace root", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-hidden-scope-test-"));
    try {
      await fs.mkdir(path.join(tmpDir, ".secrets"));
      await fs.writeFile(path.join(tmpDir, ".secrets", "token.js"), "export const privateNebulaToken = true;\n");
      await fs.writeFile(path.join(tmpDir, "visible.js"), "export const visibleFallback = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const res = await bridge.call("snap", { query: "private nebula token" });
      assert.match(JSON.parse(res.value).path, /visible\.js$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not merge hidden pending writes into a root Snap", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-hidden-overlay-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "visible.js"), "export const visibleFallback = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      bridge.beginSpeculation();
      await bridge.call("write", { path: ".secrets/token.js", content: "export const privateNebulaToken = true;\n" });
      const res = await bridge.call("snap", { query: "private nebula token" });
      assert.match(JSON.parse(res.value).path, /visible\.js$/);
      bridge.rollbackSpeculation();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("finds a pending VFS write before the outer transaction commits", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-overlay-test-"));
    try {
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      bridge.beginSpeculation();
      await bridge.call("write", {
        path: "generated/target.js",
        content: "export function pendingNebulaAnchor() { return true; }\n",
      });
      const res = await bridge.call("snap", { query: "pending nebula anchor", path: "generated" });
      assert.match(JSON.parse(res.value).path, /target\.js$/);
      bridge.rollbackSpeculation();
      await assert.rejects(() => fs.access(path.join(tmpDir, "generated", "target.js")));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a structured object from the top-level snap helper", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-helper-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "target.js"), "export const structuredNebulaAnchor = true;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const nova = {
        call: (name, args) => bridge.call(name, args),
        snap: (query, targetPath) => bridge.call("snap", { query, path: targetPath }),
        has: () => true,
      };
      const outcome = await runGuestProgram({
        code: `const hit = await snap("structured nebula anchor"); const outline = await surface(hit.path); return { path: hit.path, line: hit.line, surfaceCount: outline.items.length };`,
        nova,
        config,
      });
      assert.equal(outcome.ok, true);
      assert.match(outcome.result.path, /target\.js$/);
      assert.ok(outcome.result.line > 0);
      assert.ok(outcome.result.surfaceCount > 0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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
