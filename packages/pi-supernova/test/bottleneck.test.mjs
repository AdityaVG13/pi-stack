import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { packageHostResult, packageFinalReturn } from "../bottleneck.js";
import { truncateChars, formatValue } from "../format.js";

describe("result bottleneck", () => {
  it("truncates oversized host text and marks truncated", () => {
    const config = { maxCallResultChars: 200 };
    const raw = {
      content: [{ type: "text", text: "x".repeat(500) }],
      details: { ok: true },
    };
    const packaged = packageHostResult(raw, config);
    assert.equal(packaged.truncated, true);
    assert.ok(packaged.value.length <= 400);
    assert.ok(packaged.value.includes("truncated"));
    assert.equal(packaged.spill, undefined);
  });

  it("passes through small results", () => {
    const packaged = packageHostResult(
      { content: [{ type: "text", text: "hello" }] },
      { maxCallResultChars: 1000 },
    );
    assert.equal(packaged.truncated, false);
    assert.equal(packaged.value, "hello");
    assert.equal(packaged.ok, true);
  });

  it("packageFinalReturn caps logs and return", () => {
    const out = packageFinalReturn({ a: 1 }, ["l1", "l2", "l3"], {
      maxReturnChars: 1000,
      maxLogLines: 2,
      maxLogLineChars: 100,
    });
    assert.deepEqual(out.logs, ["l1", "l2"]);
    assert.equal(out.logTruncated, true);
    assert.equal(out.returnTruncated, false);
  });

  it("truncateChars preserves head and tail", () => {
    const source = "abcdefghijklmnopqrstuvwxyz".repeat(10);
    const { text, truncated } = truncateChars(source, 200, "t");
    assert.equal(truncated, true);
    assert.ok(text.startsWith("abcdefghijklmnopqrstuvwxyz"));
    assert.ok(text.endsWith("qrstuvwxyz"));
    assert.ok(text.length <= 200);
  });

  it("truncateChars never splits a surrogate pair", () => {
    const emoji = "😀".repeat(300);
    assert.ok(truncateChars(emoji, 201, "t").text.isWellFormed());
    assert.ok(truncateChars(emoji, 51, "t").text.isWellFormed());
  });

  it("formatValue keeps small containers on one line and breaks wide ones per item", () => {
    assert.equal(formatValue({ ok: true, "x y": [1, 2], n: null, u: undefined }), '{ok:true,"x y":[1,2],n:null}');
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, text: "t".repeat(60) }));
    const lines = formatValue(rows).split("\n");
    assert.equal(lines.length, 5);
    assert.equal(lines[1], ` {id:0,text:"${"t".repeat(60)}"},`);
  });

  it("packageHostResult lifts batch items out of the details summary", () => {
    const packaged = packageHostResult(
      { content: [{ type: "text", text: "a\n---\nb" }], details: { batch: true, count: 2, items: ["a", "b"] } },
      { maxCallResultChars: 1000 },
    );
    assert.deepEqual(packaged.items, ["a", "b"]);
    assert.deepEqual(JSON.parse(packaged.details), { batch: true, count: 2 });
  });

  it("truncateChars honors tiny and invalid limits exactly", () => {
    assert.deepEqual(truncateChars("abcdef", 3, "x"), {
      text: "abc",
      truncated: true,
      originalChars: 6,
    });
    assert.equal(truncateChars("abcdef", -1, "x").text, "");
  });
});
