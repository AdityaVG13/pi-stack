import assert from "node:assert/strict";
import test from "node:test";
import { pruneSchemaInPlace, restorePrunedSchema, truncateProse } from "../lib/compact.js";
import { createDeferredController } from "../lib/engine.js";

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

test("schema compaction preserves named parameters and data while visiting union schemas", () => {
  const payload = { examples: ["payload"], $comment: "data", description: LONG };

  const schema = {
    type: "object",
    description: LONG,
    examples: [payload],
    $comment: "documentation",
    default: payload,
    const: payload,
    enum: [payload],
    properties: {
      examples: { type: "string", description: LONG },
      $comment: { type: "string", description: LONG },
      choice: { anyOf: [{ type: "string", description: LONG }, { allOf: [{ description: LONG }] }] },
    },
    $defs: { examples: { description: LONG } },
    dependentSchemas: { $comment: { description: LONG } },
    items: [{ description: LONG }],
    prefixItems: [{ description: LONG }],
    required: ["examples", "$comment"],
  };

  const original = JSON.stringify(schema);
  const undo = pruneSchemaInPlace(schema, { maxChars: 40 });

  assert.ok(schema.required.every((key) => Object.hasOwn(schema.properties, key)));
  assert.ok(schema.properties.examples.description.length <= 40);
  assert.ok(schema.properties.choice.anyOf[0].description.length <= 40);
  assert.ok(schema.properties.choice.anyOf[1].allOf[0].description.length <= 40);
  assert.ok(schema.$defs.examples.description.length <= 40);
  assert.ok(schema.dependentSchemas.$comment.description.length <= 40);
  assert.ok(schema.items[0].description.length <= 40);
  assert.ok(schema.prefixItems[0].description.length <= 40);
  assert.equal(payload.description, LONG);
  assert.deepEqual(payload.examples, ["payload"]);
  assert.equal(payload.$comment, "data");
  assert.equal(Object.hasOwn(schema, "examples"), false);
  restorePrunedSchema(undo);
  assert.equal(JSON.stringify(schema), original);
});

test("prose caps include the suffix and do not split surrogate pairs", () => {
  for (const cap of [0, 1, 2, 3, 20, 40, 160]) {
    for (const text of ["x".repeat(220), "x".repeat(Math.max(0, cap - 1)) + "😀tail", "x".repeat(Math.max(0, cap - 3)) + "😀tail", LONG]) {
      const out = truncateProse(text, cap);

      assert.ok(out.length <= cap, `output exceeds cap ${cap}`);
      assert.ok(out.isWellFormed());
    }
  }
});

test("frozen nested schemas cannot leave untracked partial compaction", () => {
  const schema = {
    description: LONG,
    properties: { nested: Object.freeze({ examples: ["x"], description: LONG, type: "string" }) },
  };

  const original = JSON.stringify(schema);
  const tools = [{ name: "search_tools", parameters: {} }, { name: "large", parameters: schema }];
  let active = tools.map((tool) => tool.name);

  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names) => { active = [...names]; },
  };

  const config = {
    enabled: true, deferByDefault: false, alwaysActive: [], neverDefer: [], deferredNames: [], deferredPrefixes: [],
    compactSchemas: { enabled: true, maxParamDescriptionChars: 40, keepFull: [] },
  };

  const controller = createDeferredController(pi, config);
  controller.synchronize();

  assert.equal(JSON.stringify(schema), original);
  assert.equal(controller.compactionStats().compactedTools, 0);
  controller.promote(["large"]);
  assert.equal(JSON.stringify(schema), original);
});

test("controller rolls back if measuring the compacted schema fails", () => {
  const schema = { description: LONG, examples: ["a"], type: "object" };
  Object.defineProperty(schema, "toJSON", {
    configurable: true, writable: true,
    value() {
      if (!Object.hasOwn(this, "examples")) throw new Error("cannot measure compacted schema");

      return { description: this.description, examples: this.examples, type: this.type };
    },
  });
  const original = JSON.stringify(schema);
  const tools = [{ name: "large", parameters: schema }];
  const pi = { getAllTools: () => tools, getActiveTools: () => ["large"], setActiveTools: () => {} };

  const controller = createDeferredController(pi, {
    enabled: true, deferByDefault: false, alwaysActive: [], neverDefer: [], deferredNames: [], deferredPrefixes: [],
    compactSchemas: { enabled: true, maxParamDescriptionChars: 40, keepFull: [] },
  });

  controller.synchronize();

  assert.equal(JSON.stringify(schema), original);
  assert.equal(controller.compactionStats().compactedTools, 0);
});

test("shared schema and literal objects are never pruned through another position", () => {
  const shared = { description: LONG, examples: ["literal"], type: "string" };
  const schema = { properties: { q: shared }, const: shared, description: LONG };
  const before = JSON.stringify(schema);
  const undo = pruneSchemaInPlace(schema, { maxChars: 40 });

  assert.equal(shared.description, LONG);
  assert.deepEqual(shared.examples, ["literal"]);
  assert.ok(schema.description.length <= 40);
  restorePrunedSchema(undo);
  assert.equal(JSON.stringify(schema), before);
});

test("catalog aliases, promotion and schema replacement restore full shared documentation", () => {
  const shared = { description: LONG, type: "object", properties: { q: { description: LONG, type: "string" } } };
  const alpha = { name: "alpha", parameters: shared };
  const tools = [alpha];
  let active = ["alpha"];
  const pi = { getAllTools: () => tools, getActiveTools: () => active, setActiveTools: names => { active = [...names]; } };

  const config = {
    enabled: true, deferByDefault: false, alwaysActive: [], neverDefer: [], deferredNames: [], deferredPrefixes: [],
    compactSchemas: { enabled: true, maxParamDescriptionChars: 40, keepFull: [] },
  };

  const controller = createDeferredController(pi, config);
  controller.synchronize();
  assert.ok(shared.description.length <= 40);

  tools.push({ name: "beta", parameters: shared });
  controller.promote(["beta"]);
  assert.equal(shared.description, LONG);
  assert.equal(shared.properties.q.description, LONG);

  const fresh = { description: LONG, type: "object" };
  alpha.parameters = fresh;
  controller.synchronize();
  assert.ok(fresh.description.length <= 40);
  assert.equal(shared.description, LONG);
  controller.promote(["alpha"]);
  assert.equal(fresh.description, LONG);
});


test("compaction byte statistics measure UTF-8 and reset after promotion", () => {
  const schema = { type: "object", description: "界😀".repeat(120) };
  const original = JSON.stringify(schema);
  const tools = [{ name: "search_tools", parameters: {} }, { name: "unicode", parameters: schema }];
  let active = tools.map(tool => tool.name);
  const pi = { getAllTools: () => tools, getActiveTools: () => active, setActiveTools: names => { active = [...names]; } };

  const controller = createDeferredController(pi, {
    enabled: true, deferByDefault: false, compactSchemas: { enabled: true, maxParamDescriptionChars: 20 },
  });

  controller.synchronize();
  assert.equal(controller.compactionStats().compactedTools, 1);
  assert.equal(controller.compactionStats().savedBytes, Buffer.byteLength(original) - Buffer.byteLength(JSON.stringify(schema)));
  controller.promote(["unicode"]);
  assert.equal(JSON.stringify(schema), original);
  assert.equal(controller.compactionStats().savedBytes, 0);
});


test("compactor undo retains newer owner annotations and deletions", () => {
  for (const action of ["promote", "disable"]) {
    const schema = { examples: ["old"], description: LONG, $comment: "old comment", type: "object",
      properties: { value: { type: "string", description: LONG } } };

    const tools = [{ name: "search_tools", parameters: {} }, { name: "dynamic", parameters: schema }];
    let active = ["search_tools"];
    const pi = { getAllTools: () => tools, getActiveTools: () => active, setActiveTools: names => { active = [...names]; } };

    const config = { enabled: true, deferByDefault: false, compactSchemas: { enabled: true, maxParamDescriptionChars: 40 } };
    const controller = createDeferredController(pi, config);
    controller.synchronize();
    schema.description = "Updated owner instructions. ".repeat(15);
    schema.examples = ["new"];
    schema.$comment = "new comment";
    delete schema.properties.value.description;
    schema.required = ["value"];
    const expected = structuredClone(schema);
    controller.synchronize();

    if (action === "promote") assert.deepEqual(controller.promote(["dynamic"]).added, ["dynamic"]);
    else controller.setConfig({ ...config, enabled: false });

    assert.deepEqual(schema, expected, action + " must retain the owner's latest schema");
    assert.equal(controller.compactionStats().compactedTools, 0);
  }
});

test("compactor undo respects owner descriptor locks without breaking promotion", () => {
  const locked = { examples: ["keep"], type: "object", description: LONG };
  const frozen = { examples: ["keep"], description: LONG, type: "object" };
  const tools = [{ name: "search_tools", parameters: {} }, { name: "locked", parameters: locked }, { name: "frozen", parameters: frozen }];
  let active = ["search_tools"];
  const pi = { getAllTools: () => tools, getActiveTools: () => active, setActiveTools: names => { active = [...names]; } };

  const controller = createDeferredController(pi, {
    enabled: true, deferByDefault: false, compactSchemas: { enabled: true, maxParamDescriptionChars: 40 },
  });

  controller.synchronize();
  Object.defineProperty(locked, "type", { configurable: false });
  Object.freeze(frozen);
  const ownerSnapshot = JSON.stringify(frozen);
  assert.deepEqual(controller.promote(["locked", "frozen"]).added, ["locked", "frozen"]);
  assert.deepEqual(locked, { examples: ["keep"], type: "object", description: LONG });
  assert.equal(Object.getOwnPropertyDescriptor(locked, "type").configurable, false);
  assert.equal(JSON.stringify(frozen), ownerSnapshot);
  assert.ok(Object.isFrozen(frozen));
});
