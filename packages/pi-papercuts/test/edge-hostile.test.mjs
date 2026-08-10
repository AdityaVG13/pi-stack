/**
 * Hostile edge-case regressions discovered in pre-0.1.0 audit.
 * These assert desired safe behavior and are regressions for store/tool harden.
 * Keep assertions tight.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerPapercuts from "../index.js";
import * as store from "../store.js";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papercuts-hostile-"));
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /tmp/fake\n");
  return dir;
}

function captureTool() {
  let tool;
  registerPapercuts({ registerTool: (t) => { tool = t; } });
  assert.ok(tool);
  return tool;
}

function dataOf(result) {
  if (result.details && typeof result.details === "object") return result.details;
  const text = result.content[0].text;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

test("list limit < 0 must not apply Array.prototype.slice end-semantics", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  for (let i = 0; i < 5; i++) {
    process.env.PAPERCUTS_NOW = `2026-07-01T00:00:0${i}.000Z`;
    await tool.execute("x", { action: "add", text: `item-${i}` }, undefined, { cwd: repo });
  }
  delete process.env.PAPERCUTS_NOW;

  const res = dataOf(await tool.execute("x", { action: "list", limit: -1 }, undefined, { cwd: repo }));

  // BUG (pre-fix): limit=-1 → items.slice(0, -1) → 4 of 5 items, silently drops the last.
  // Safe behaviors: usage error, clamp to 0 (empty page), or clamp to default/all — never n-1.
  if (res.ok) {
    assert.notEqual(
      res.data.count,
      res.data.total - 1,
      "negative limit must not mean slice(0, -1); got count=total-1",
    );
    assert.ok(
      res.data.count === 0 || res.data.count === res.data.total,
      `negative limit accepted but count=${res.data.count} total=${res.data.total} is neither empty nor full`,
    );
  } else {
    assert.equal(res.error.code, "usage");
  }
});

test("list limit=-3 must not return first total+limit items via slice", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  for (let i = 0; i < 5; i++) {
    process.env.PAPERCUTS_NOW = `2026-07-02T00:00:0${i}.000Z`;
    await tool.execute("x", { action: "add", text: `n-${i}` }, undefined, { cwd: repo });
  }
  delete process.env.PAPERCUTS_NOW;

  const res = dataOf(await tool.execute("x", { action: "list", limit: -3 }, undefined, { cwd: repo }));
  // BUG: slice(0, -3) on 5 items → 2 items (i4, i3 in severity/newest order).
  if (res.ok) {
    assert.notEqual(res.data.count, 2, "limit=-3 must not yield slice(0,-3) length");
  } else {
    assert.equal(res.error.code, "usage");
  }
});

test("add to /dev/null must not report success with permanent silent data loss", async () => {
  if (process.platform === "win32" || !fs.existsSync("/dev/null")) {
    return; // platform N/A
  }
  const tool = captureTool();
  const repo = tmpRepo();
  const add = dataOf(
    await tool.execute("x", { action: "add", text: "should not vanish", file: "/dev/null" }, undefined, { cwd: repo }),
  );
  const list = dataOf(
    await tool.execute("x", { action: "list", file: "/dev/null", status: "all" }, undefined, { cwd: repo }),
  );

  // BUG (pre-fix): appendFileSync(/dev/null) succeeds; read always empty → changed:true + count:0.
  if (add.ok && add.data?.changed) {
    assert.ok(
      list.data.total >= 1,
      "add claimed changed=true on /dev/null but list is empty (silent data loss)",
    );
  }
  // Alternative acceptable fix: add fails with internal/usage for non-regular files.
});

test("evidence.cmd is byte-capped (parity with stderr MAX_EVIDENCE_FIELD_BYTES)", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const cap = store.MAX_EVIDENCE_FIELD_BYTES;
  const huge = "C".repeat(50_000);
  const res = dataOf(
    await tool.execute(
      "x",
      { action: "add", text: "tool failure", cmd: huge, stderr: "e".repeat(100) },
      undefined,
      { cwd: repo },
    ),
  );
  assert.equal(res.ok, true);
  const cmd = res.data.record.evidence?.cmd ?? "";
  // Cap sole source: store.MAX_EVIDENCE_FIELD_BYTES (parse-edge truncate)
  assert.ok(
    Buffer.byteLength(cmd, "utf-8") <= cap,
    `cmd stored at ${Buffer.byteLength(cmd, "utf-8")} bytes; expect ≤${cap} like stderr`,
  );
});

test("tags are capped to a small finite count", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const tags = Array.from({ length: 10_000 }, (_, i) => `t${i}`);
  const res = dataOf(
    await tool.execute("x", { action: "add", text: "tag flood", tags }, undefined, { cwd: repo }),
  );
  assert.equal(res.ok, true);
  const n = res.data.record.tags.length;
  // BUG (pre-fix): all 10k tags stored (~80KB JSONL line). Cap should be modest (e.g. ≤32 or ≤64).
  assert.ok(n <= 64, `stored ${n} tags; expect a hard cap ≤64`);
});
