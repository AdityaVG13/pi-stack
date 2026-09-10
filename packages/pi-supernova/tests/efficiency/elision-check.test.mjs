import { it } from "node:test";
import assert from "node:assert/strict";
import { assertElisionOnly } from "./workflow.mjs";

// Self-tests for the fidelity guard used by the observed-host gate. A checker that
// cannot reject anything makes every gate that relies on it vacuous, so each case
// below fails if the checker is weakened. Neutering assertElisionOnly turns this
// file red, which is the point.
const SOURCE = [
  "const alpha = compute(1);",
  "const bravo = compute(2);",
  "const charlie = compute(3);",
  "const delta = compute(4);",
  "const echo = compute(5);",
  "const foxtrot = compute(6);",
  "const golf = compute(7);",
  "const hotel = compute(8);",
].join("\n");

const citation = n => "⋯ " + n + " lines same as #3 ⋯";

const head = SOURCE.split("\n")[0];

const tail = SOURCE.split("\n")[7];

it("accepts an accurate elision, and reports that it checked one", () => {
  assert.equal(assertElisionOnly(SOURCE, [head, citation(6), tail].join("\n"), "t"), 1);
  assert.equal(assertElisionOnly(SOURCE, SOURCE, "t"), 0, "an empty elision is faithful but checks nothing");
});

it("rejects a line that vanished without a citation", () => {
  const dropped = SOURCE.split("\n").filter((_, index) => index !== 3).join("\n");
  assert.throws(() => assertElisionOnly(SOURCE, dropped, "t"), /neither the original nor a citation/);
});

it("rejects a citation that claims more lines than the result had", () => {
  assert.throws(() => assertElisionOnly(SOURCE, [head, citation(80)].join("\n"), "t"), /claims more lines than the result had/);
});

it("rejects a citation that covers too few lines to be a real run", () => {
  assert.throws(() => assertElisionOnly(SOURCE, [head, citation(3), tail].join("\n"), "t"), /a citation must cover a real run/);
});

it("rejects a citation that swallows fewer lines than it claims", () => {
  // Claims six, but leaves six lines of the source unaccounted for.
  assert.throws(() => assertElisionOnly(SOURCE, [head, citation(6)].join("\n"), "t"), /lost or invented trailing lines/);
});

it("rejects output that invents a line", () => {
  assert.throws(() => assertElisionOnly(SOURCE, SOURCE + "\nconst invented = compute(9);", "t"), /neither the original nor a citation/);
});

it("rejects an elision that reorders surviving lines", () => {
  const lines = SOURCE.split("\n");
  const reordered = [lines[1], lines[0], citation(6), tail].join("\n");
  assert.throws(() => assertElisionOnly(SOURCE, reordered, "t"));
});
