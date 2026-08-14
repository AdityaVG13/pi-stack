import assert from "node:assert/strict";
import test from "node:test";
import { pruneSchemaInPlace, restorePrunedSchema, truncateProse } from "../compact.js";
import { createDeferredController } from "../engine.js";

const LONG = "This option controls the runtime behavior of the child agent. ".repeat(8).trim();

function bigSchema() {
  return {
    type: "object",
    description: LONG,
    properties: {
      mode: { type: "string", description: LONG, examples: ["a", "b"] },
      nested: {
        type: "object",
        properties: {
          depth: { type: "integer", description: "short stays untouched" },
          prose: { type: "string", description: LONG, $comment: "internal note" },
        },
      },
      // A parameter literally named "description" must not confuse the pruner.
      description: { type: "string", description: LONG },
    },
    required: ["mode"],
  };
}

test("truncateProse prefers sentence boundaries and never grows text", () => {
  assert.equal(truncateProse("short", 160), "short");
  const cut = truncateProse(LONG, 160);
  assert.ok(cut.length <= 161);
  assert.ok(cut.endsWith(".") || cut.endsWith("…"));
});

test("prune/restore is an exact round trip and keeps structure intact", () => {
  const schema = bigSchema();
  const pristine = JSON.parse(JSON.stringify(schema));
  const undo = pruneSchemaInPlace(schema, { maxChars: 160 });
  assert.ok(undo.length >= 5, `expected prunes, got ${undo.length}`);
  // Structure survives compaction.
  assert.deepEqual(schema.required, ["mode"]);
  assert.equal(schema.properties.mode.type, "string");
  assert.equal(schema.properties.mode.examples, undefined);
  assert.equal(schema.properties.nested.properties.prose.$comment, undefined);
  assert.equal(schema.properties.nested.properties.depth.description, "short stays untouched");
  assert.ok(schema.properties.description.description.length < LONG.length);
  // Restore is byte-exact.
  restorePrunedSchema(undo);
  assert.deepEqual(schema, pristine);
});

test("controller compacts active tools and restores full schemas on promote", () => {
  const schema = bigSchema();
  const pristine = JSON.parse(JSON.stringify(schema));
  const tools = [
    { name: "search_tools", description: "Search tools", parameters: { type: "object", description: LONG } },
    { name: "megatool", description: "Big tool", parameters: schema },
  ];
  let active = tools.map((tool) => tool.name);
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
  };
  const config = {
    enabled: true,
    deferByDefault: false,
    alwaysActive: ["megatool"],
    neverDefer: [],
    deferredNames: [],
    deferredPrefixes: [],
    compactSchemas: { enabled: true, maxParamDescriptionChars: 160, keepFull: [] },
  };
  const controller = createDeferredController(pi, config);
  controller.synchronize({ resetPromotions: true });
  // megatool compacted; spine keepFull untouched.
  assert.ok(schema.description.length < LONG.length);
  assert.equal(tools[0].parameters.description, LONG);
  const stats = controller.compactionStats();
  assert.equal(stats.compactedTools, 1);
  assert.ok(stats.savedBytes > 500, `saved ${stats.savedBytes}`);
  // Promote restores byte-exact fidelity.
  controller.promote(["megatool"]);
  assert.deepEqual(schema, pristine);
  assert.equal(controller.compactionStats().compactedTools, 0);
  // Reset promotions (agent_settled) re-compacts.
  controller.synchronize({ resetPromotions: true });
  assert.ok(schema.description.length < LONG.length);
  // Disabling the engine restores everything.
  controller.setConfig({ ...config, enabled: false });
  controller.synchronize();
  assert.deepEqual(schema, pristine);
});
