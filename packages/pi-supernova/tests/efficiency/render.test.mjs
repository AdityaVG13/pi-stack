import test from "node:test";
import assert from "node:assert/strict";
import { renderSupernovaResult, measureWidth } from "../../src/ui/render.js";
import { progressEmitter } from "../../index.js";

import stringWidth from "string-width";

test("width memoization preserves the oracle through eviction and mutable inputs", () => {
  const fragments = ["ascii", "\t", "😀", "👩‍💻", "e\u0301", "가", "中", "\x1b[31mred\x1b[0m", "\x1b]8;;https://example.test\x07link\x1b]8;;\x07", "\u200d", "\ud800", "\r\n"];
  for (let i = 0; i < 10_000; i++) {
    const text = i + fragments[i % fragments.length] + fragments[(i * 7) % fragments.length];
    assert.equal(measureWidth(text), stringWidth(text.replace(/\t/g, "   ")));
  }
  const chrome = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ...Array.from({ length: 128 }, (_, i) => String.fromCharCode(0x2500 + i)), "·×…✓✗"];
  for (const glyph of chrome) {
    for (const sgr of ["", "\x1b[m", "\x1b[31m", "\x1b[38;2;10;20;30m", "\x1b[999m", "\x1b[38:2::1:2:3m"]) {
      const text = sgr + glyph + " ascii " + glyph + "\x1b[0m";
      assert.equal(measureWidth(text), stringWidth(text));
    }
  }
  let value = "a";
  const changing = { toString: () => value };
  assert.equal(measureWidth(changing), 1);
  value = "😀\t";
  assert.equal(measureWidth(changing), 5);
  assert.equal(measureWidth(null), 0);
  const huge = "😀".repeat(5000);
  assert.equal(measureWidth(huge), stringWidth(huge));
});

const theme = { fg: (_, text) => text, bg: (_, text) => text, bold: text => text };
const render = (trace, options = {}, context = { state: {} }) => renderSupernovaResult(
  { details: { ok: true, trace } }, options, theme, context,
);

test("live cards do not inspect invisible history and show the latest eight calls", () => {
  const trace = Array.from({ length: 32 }, (_, i) => ({ name: "edit", args: { path: "file" + i + ".js" }, ok: true }));
  for (const item of trace.slice(0, 24)) Object.defineProperty(item, "diff", { get() { return assert.fail("invisible diff inspected"); } });
  const text = render(trace, { isPartial: true }).render(120).join("\n");
  assert.ok(text.includes("file24.js") && text.includes("file31.js"));
  assert.ok(!text.includes("file23.js"));
  assert.ok(text.includes("24 earlier calls"));
});

test("diff summaries and bounded previews remain fresh across repaint, mutation and resize", () => {
  const item = { name: "edit", args: { path: "unicode-😀.js" }, ok: true, diff: Array.from({ length: 1000 }, (_, i) => "+" + (i + 1) + " value😀").join("\n") };
  const context = { state: {} };
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const expanded of [false, true]) {
      const card = render([item], { expanded }, context);
      for (const width of [1, 2, 40, 80, 120, 240]) {
        const lines = card.render(width);
        for (const line of lines) assert.ok(measureWidth(line) <= width);
        if (width === 120) {
          assert.ok(lines.join("\n").includes("+1000/-0"));
          assert.ok(lines.join("\n").includes((expanded ? "976" : "992") + " more lines"));
        }
      }
      card.invalidate();
      assert.ok(card.render(120).join("\n").includes("+1000/-0"));
    }
  }
  item.diff = "-1 before\n+1 after\n+2 fresh";
  const changed = render([item], {}, context).render(120).join("\n");
  assert.ok(changed.includes("+2/-1") && changed.includes("fresh"));
  assert.ok(!changed.includes("+1000/-0"));
});

test("progress bursts coalesce without mutating emitted snapshots or leaking trailing frames", async () => {
  const frames = [];
  const emit = progressEmitter(frame => frames.push(frame));
  const trace = [{ name: "read", ok: undefined }];
  emit(trace);
  trace[0].ok = true;
  for (let i = 0; i < 2500; i++) { trace.push({ name: "read", ok: true }); emit(trace); }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].details.trace.length, 1);
  assert.equal(frames[0].details.trace[0].ok, undefined);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(frames.length, 2);
  assert.equal(frames[1].details.trace.length, 2501);
  emit(trace);
  emit.flush();
  const count = frames.length;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(frames.length, count);
});
