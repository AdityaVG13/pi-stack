import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPatchToText } from "../patch.js";
import { truncateChars } from "../format.js";

function generator(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

describe("deterministic property checks", () => {
  it("applies generated replacement hunks and preserves unrelated prefixes", () => {
    const next = generator();
    for (let run = 0; run < 250; run++) {
      const count = 1 + (next() % 20);
      const lines = Array.from({ length: count }, (_, i) => `line-${run}-${i}-${next()}`);
      const index = next() % count;
      const replacement = `replacement-${next()}`;
      const marker = index === count - 1 ? "\n\\ No newline at end of file" : "";
      const patch = `@@ -${index + 1},1 +${index + 1},1 @@\n-${lines[index]}${marker}\n+${replacement}${marker}`;
      const expected = lines.with(index, replacement).join("\n");
      assert.equal(applyPatchToText(lines.join("\n"), patch).resultText, expected);

      const prefixed = ["unrelated", ...lines];
      const shifted = patch.replace(`@@ -${index + 1},1 +${index + 1},1 @@`, `@@ -${index + 2},1 +${index + 2},1 @@`);
      assert.equal(applyPatchToText(prefixed.join("\n"), shifted).resultText, `unrelated\n${expected}`);
      assert.equal(applyPatchToText(lines.join("\r\n"), patch.replaceAll("\n", "\r\n")).resultText, expected.replaceAll("\n", "\r\n"));
    }
  });

  it("keeps truncation inside every generated bound", () => {
    const next = generator(0xc0ffee);
    for (let run = 0; run < 1000; run++) {
      const source = "x".repeat(next() % 5000);
      const limit = next() % 6000;
      const result = truncateChars(source, limit, "property");
      assert.ok(result.text.length <= limit);
      assert.equal(result.truncated, source.length > limit);
      if (!result.truncated) assert.equal(result.text, source);
    }
    assert.equal(truncateChars("small", 2 ** 31).text, "small");
    assert.equal(truncateChars("small", -1).text, "");
  });
});
