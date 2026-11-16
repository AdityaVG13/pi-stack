/** Hostile edge cases: every test asserts the exact refusal or stored shape. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, test } from "node:test";
import { MAX_EVIDENCE_FIELD_BYTES } from "../lib/vocab.js";
import { captureTool, dataOf, drainShutdowns, tmpRepo } from "./helpers.mjs";

afterEach(drainShutdowns);

test("list rejects negative limits instead of applying slice end-semantics", async () => {
  const tool = captureTool();
  const repo = tmpRepo();

  for (let i = 0; i < 5; i++) {
    process.env.PAPERCUTS_NOW = `2026-07-01T00:00:0${i}.000Z`;
    await tool.execute("x", { action: "add", text: `item-${i}` }, undefined, { cwd: repo });
  }

  delete process.env.PAPERCUTS_NOW;

  for (const limit of [-1, -3]) {
    const res = dataOf(await tool.execute("x", { action: "list", limit }, undefined, { cwd: repo }));

    assert.equal(res.ok, false, `limit ${limit} must be rejected`);
    assert.equal(res.error.code, "usage");
  }
});

test("add and list refuse a character device instead of dropping data", async () => {
  if (process.platform === "win32" || !fs.existsSync("/dev/null")) return;

  const tool = captureTool();
  const repo = tmpRepo();
  const ctx = { cwd: repo };
  const add = dataOf(await tool.execute("x", { action: "add", text: "should not vanish", file: "/dev/null" }, undefined, ctx));
  const list = dataOf(await tool.execute("x", { action: "list", file: "/dev/null", status: "all" }, undefined, ctx));

  assert.equal(add.ok, false);
  assert.equal(add.error.code, "usage");
  assert.equal(list.ok, false);
  assert.equal(list.error.code, "usage");
});

test("evidence.cmd is byte-capped (parity with stderr MAX_EVIDENCE_FIELD_BYTES)", async () => {
  const tool = captureTool();
  const repo = tmpRepo();
  const cap = MAX_EVIDENCE_FIELD_BYTES;
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
