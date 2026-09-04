import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { createHostBridge } from "../host-bridge.js";

describe("host bridge and adapters", () => {
  const config = {
    timeoutMs: 5000,
    maxBridgeCalls: 50,
    maxCallResultChars: 10000,
  };

  it("fails closed on missing path for read and write", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    try {
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      await assert.rejects(() => bridge.call("read", {}), /read requires path/);
      await assert.rejects(() => bridge.call("write", {}), /write requires path/);
      await assert.rejects(() => bridge.call("read", { path: "" }), /read requires path/);
      await assert.rejects(() => bridge.call("read", { path: "   " }), /read requires path/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("blocks directory reads and path escapes", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    try {
      const subDir = path.join(tmpDir, "subdir");
      await fs.mkdir(subDir);
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      await assert.rejects(() => bridge.call("read", { path: "../../etc/passwd" }), /read path escapes workspace/);
      await assert.rejects(() => bridge.call("read", { path: "." }), /read path cannot be the workspace root directory/);
      await assert.rejects(() => bridge.call("read", { path: "subdir" }), /read path is a directory, not a file/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("read supports offset and limit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    try {
      const filePath = path.join(tmpDir, "lines.txt");
      await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      const res = await bridge.call("read", { path: "lines.txt", offset: 2, limit: 2 });
      assert.equal(res.ok, true);
      assert.equal(res.value, "line2\nline3");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports write, edit, and ls adapters", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    try {
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      const wRes = await bridge.call("write", { path: "hello.txt", content: "hello world" });
      assert.equal(wRes.ok, true);

      const eRes = await bridge.call("edit", { path: "hello.txt", oldText: "world", newText: "pi" });
      assert.equal(eRes.ok, true);

      const rRes = await bridge.call("read", { path: "hello.txt" });
      assert.equal(rRes.value, "hello pi");

      const lsRes = await bridge.call("ls", { path: "." });
      assert.equal(lsRes.ok, true);
      assert.match(lsRes.value, /hello\.txt/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts the advertised multi-edit schema", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-multi-edit-"));
    try {
      await fs.writeFile(path.join(tmpDir, "multi.txt"), "alpha beta gamma");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const result = await bridge.call("edit", {
        path: "multi.txt",
        edits: [
          { oldText: "alpha", newText: "one" },
          { oldText: "gamma", newText: "three" },
        ],
      });
      assert.equal(await fs.readFile(path.join(tmpDir, "multi.txt"), "utf8"), "one beta three");
      const diff = JSON.parse(result.details).diff;
      assert.equal(diff.added, 2);
      assert.equal(diff.removed, 2);
      assert.ok(diff.lines.length < 8);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves quoted bash arguments and bounds captured output", async () => {
    const bridge = createHostBridge({
      pi: null,
      config: { ...config, maxCallResultChars: 64 },
      getCwd: () => process.cwd(),
    });

    const quoted = await bridge.call("bash", { command: "printf '%s\n' 'hello world'" });
    assert.equal(quoted.value, "hello world\n");

    const large = await bridge.call("bash", {
      command: "node -e \"process.stdout.write('x'.repeat(10000))\"",
    });
    assert.equal(large.truncated, true);
    assert.equal(large.value.length, 64);
  });

  it("invalidates cached reads after shell commands mutate the workspace", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    try {
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      await bridge.call("write", { path: "cached.txt", content: "before" });
      assert.equal((await bridge.call("read", { path: "cached.txt" })).value, "before");
      await bridge.call("bash", { command: "printf after > cached.txt" });
      assert.equal((await bridge.call("read", { path: "cached.txt" })).value, "after");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not evaluate shell syntax embedded in glob patterns", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-glob-test-"));
    try {
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      await bridge.call("glob", { pattern: "$(printf injected > marker)" });
      await assert.rejects(() => fs.access(path.join(tmpDir, "marker")));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("callMany handles empty calls array correctly", async () => {
    const bridge = createHostBridge({
      pi: null,
      config,
      getCwd: () => process.cwd(),
    });

    const wave = await bridge.callMany([]);
    assert.deepEqual(wave.results, []);
    assert.equal(wave.mode, "serial");
    assert.equal(wave.reason, "empty");
  });

  it("tracks trace of executed calls", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    try {
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      await bridge.call("write", { path: "a.txt", content: "1" });
      await bridge.call("read", { path: "a.txt" });

      const trace = bridge.getTrace();
      assert.equal(trace.length, 2);
      assert.equal(trace[0].name, "write");
      assert.equal(trace[1].name, "read");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports apply_patch adapter with unified diff and path extraction", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-patch-test-"));
    try {
      const filePath = path.join(tmpDir, "sample.txt");
      await fs.writeFile(filePath, "line1\nline2\nline3\nline4\n");
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      const diff1 = `--- a/sample.txt
+++ b/sample.txt
@@ -2,3 +2,4 @@
 line2
-line3
+line3_modified
+line3_new
 line4`;

      const res1 = await bridge.call("apply_patch", { path: "sample.txt", patch: `${diff1}\n` });
      assert.equal(res1.ok, true);
      const patchDetails = JSON.parse(res1.details);
      assert.equal(patchDetails.diff.added, 2);
      assert.equal(patchDetails.diff.removed, 1);
      const read1 = await bridge.call("read", { path: "sample.txt" });
      assert.equal(read1.value, "line1\nline2\nline3_modified\nline3_new\nline4\n");

      const diff2 = `--- a/sample.txt
+++ b/sample.txt
@@ -1,2 +1,2 @@
-line1
+line1_updated
 line2`;

      const res2 = await bridge.call("apply_patch", { patch: diff2 });
      assert.equal(res2.ok, true);
      const read2 = await bridge.call("read", { path: "sample.txt" });
      assert.equal(read2.value, "line1_updated\nline2\nline3_modified\nline3_new\nline4\n");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed and ambiguous edits", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-edit-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "repeated.txt"), "same\nsame\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });

      await assert.rejects(
        () => bridge.call("edit", { path: "repeated.txt", oldText: "", newText: "x" }),
        /non-empty oldText/,
      );
      await assert.rejects(
        () => bridge.call("edit", { path: "repeated.txt", oldText: "same", newText: "x" }),
        /not unique/,
      );
      await assert.rejects(
        () => bridge.call("apply_patch", {
          path: "repeated.txt",
          patch: "@@ -1,2 +1,1 @@\n-same\n+x",
        }),
        /length does not match/,
      );
      assert.equal(await fs.readFile(path.join(tmpDir, "repeated.txt"), "utf8"), "same\nsame\n");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats extension-bearing names as file paths", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-path-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "entry.ts"), "export const value = 1;\n");
      const bridge = createHostBridge({ pi: null, config, getCwd: () => tmpDir });
      const result = await bridge.call("read", { path: "entry.ts" });
      assert.equal(result.value, "export const value = 1;\n");
      assert.equal(JSON.parse(result.details).isSnap, undefined);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports polymorphic read with path arrays and auto-snap concept queries", async () => {
    const bridge = createHostBridge({
      pi: null,
      config,
      getCwd: () => process.cwd(),
    });

    const batchRes = await bridge.call("read", { target: ["package.json", "README.md"] });
    assert.equal(batchRes.ok, true);
    const bDetails = JSON.parse(batchRes.details);
    assert.equal(bDetails.batch, true);
    assert.equal(bDetails.count, 2);

    const snapReadRes = await bridge.call("read", { path: "causal vfs cache" });
    assert.equal(snapReadRes.ok, true);
    const sDetails = JSON.parse(snapReadRes.details);
    assert.equal(sDetails.isSnap, true);
    assert.match(sDetails.path, /host-bridge\.js$/);
  });

  it("supports polymorphic edit with unified diff patch directly", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-poly-edit-"));
    try {
      const filePath = path.join(tmpDir, "poly.txt");
      await fs.writeFile(filePath, "hello old world\n", "utf8");
      const bridge = createHostBridge({
        pi: null,
        config,
        getCwd: () => tmpDir,
      });

      const patchDiff = `--- a/poly.txt
+++ b/poly.txt
@@ -1,1 +1,1 @@
-hello old world
+hello polymorphic world`;

      const editRes = await bridge.call("edit", { path: "poly.txt", oldText: patchDiff });
      assert.equal(editRes.ok, true);
      const readRes = await bridge.call("read", { path: "poly.txt" });
      assert.equal(readRes.value, "hello polymorphic world\n");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

});
