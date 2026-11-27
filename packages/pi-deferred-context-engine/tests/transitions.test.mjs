import test from "node:test";
import assert from "node:assert/strict";
import { createToolTransitions } from "../lib/transitions.js";

test("host presentation reorder is not a set-active error", async () => {
  let active = ["a", "b"];
  const pi = {
    getActiveTools: () => [...active],
    // OMP reorders by presentation; the set is what the policy asked for.
    setActiveTools: names => { active = [...names].reverse(); return Promise.resolve(); },
  };
  const transitions = createToolTransitions(pi, names => [...new Set(names)]);
  await transitions.write(["a", "b"]);
  assert.equal(transitions.error, null);
});

test("a host that drops a requested tool still reports the error", async () => {
  let active = ["a"];
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools: () => { active = ["a"]; return Promise.resolve(); },
  };
  const transitions = createToolTransitions(pi, names => [...new Set(names)]);
  await transitions.write(["a", "b"]);
  assert.match(transitions.error, /did not apply/);
});
