import assert from "node:assert/strict";
import test from "node:test";
import { rankCapabilities } from "../catalog.js";
import { createDeferredController, SPINE_NAMES } from "../engine.js";

function mockPi(extraTools = []) {
  const tools = [
    { name: "read", description: "Read files" },
    { name: "bash", description: "Run shell" },
    { name: "search_tools", description: "Search tools" },
    { name: "list_capabilities", description: "List tools" },
    { name: "promote_tools", description: "Promote tools" },
    { name: "demote_tools", description: "Demote tools" },
    ...extraTools,
  ];
  let active = tools.map((tool) => tool.name);
  const calls = [];
  return {
    calls,
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
      calls.push([...names]);
    },
    register: (tool) => {
      tools.push(tool);
      active.push(tool.name);
    },
  };
}

/** Bare-bones public defaults: loaders + core file/shell always active */
const config = {
  enabled: true,
  alwaysActive: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  neverDefer: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  deferByDefault: true,
  deferredNames: [],
  deferredPrefixes: ["mcp_"],
};

test("defers long-tail tools while preserving the search spine and configured core tools", () => {
  const pi = mockPi([{ name: "weather_lookup", description: "Look up city weather" }]);
  const controller = createDeferredController(pi, config);
  controller.synchronize({ resetPromotions: true });
  const active = pi.getActiveTools().sort();
  for (const name of SPINE_NAMES) assert.ok(active.includes(name), name);
  assert.ok(active.includes("read"));
  assert.ok(active.includes("bash"));
  assert.ok(!active.includes("weather_lookup"));
  const deferred = controller.catalog({ state: "deferred" }).map((row) => row.name);
  for (const name of ["weather_lookup", "list_capabilities", "promote_tools", "demote_tools"]) {
    assert.ok(deferred.includes(name), name);
  }
});

test("native tools remain discoverable as crash-path fallbacks when deferred", () => {
  const pi = mockPi([{ name: "optional_tool", description: "Optional" }]);
  // Force-defer read via config for this test only
  const c = {
    ...config,
    alwaysActive: [],
    neverDefer: [],
    deferredNames: ["read"],
  };
  const controller = createDeferredController(pi, c);
  controller.synchronize({ resetPromotions: true });
  // DCE-D5: sole ranking path is rankCapabilities (controller.search deleted)
  const inactive = pi.getAllTools().filter((t) => !pi.getActiveTools().includes(t.name) && !SPINE_NAMES.has(t.name));
  assert.deepEqual(
    rankCapabilities("read files", inactive, [], 1).map((m) => m.name),
    ["read"],
  );
  assert.deepEqual(controller.promote(["read"]).added, ["read"]);
  assert.ok(pi.getActiveTools().includes("read"));
});

test("DCE-D9 cascade: rankCapabilities requires positive limit (no dual default 3)", () => {
  const tools = [{ name: "read", description: "read files" }];
  assert.throws(() => rankCapabilities("read", tools, []), /positive integer limit/);
  assert.throws(() => rankCapabilities("read", tools, [], 0), /positive integer limit/);
  assert.throws(() => rankCapabilities("read", tools, [], -1), /positive integer limit/);
  assert.deepEqual(rankCapabilities("read", tools, [], 1).map((m) => m.name), ["read"]);
});

test("search promotes additively and promotion survives synchronization", () => {
  const pi = mockPi([
    { name: "weather_lookup", description: "Look up city weather" },
    { name: "issue_tracker", description: "Search project issues" },
  ]);
  const controller = createDeferredController(pi, config);
  controller.synchronize({ resetPromotions: true });
  // DCE-D5: rankCapabilities is the sole discovery scorer (index search_tools uses it)
  const inactive = pi.getAllTools().filter((t) => !pi.getActiveTools().includes(t.name) && !SPINE_NAMES.has(t.name));
  const matches = rankCapabilities("city weather", inactive, [], 5).map((m) => m.name);
  assert.deepEqual(matches, ["weather_lookup"]);
  const before = pi.getActiveTools();
  assert.deepEqual(controller.promote(matches).added, ["weather_lookup"]);
  assert.deepEqual(pi.calls.at(-1), [...before, "weather_lookup"]);
  controller.synchronize();
  assert.ok(pi.getActiveTools().includes("weather_lookup"));
  assert.ok(pi.getActiveTools().includes("read"));
});

test("synchronizes tools registered after session start", () => {
  const pi = mockPi([]);
  const controller = createDeferredController(pi, config);
  controller.synchronize({ resetPromotions: true });
  pi.register({ name: "mcp_late_tool", description: "Late MCP capability" });
  controller.synchronize();
  assert.ok(!pi.getActiveTools().includes("mcp_late_tool"));
  assert.equal(controller.catalog({ filter: "mcp_late" })[0].state, "deferred");
});

test("manual demotion persists until the tool is promoted", () => {
  const pi = mockPi([{ name: "optional_tool", description: "Optional" }]);
  const controller = createDeferredController(pi, { ...config, deferByDefault: false });
  controller.synchronize({ resetPromotions: true });
  assert.deepEqual(controller.demote(["optional_tool"]).removed, ["optional_tool"]);
  controller.synchronize();
  assert.equal(controller.catalog({ filter: "optional_tool" })[0].state, "deferred");
  controller.promote(["optional_tool"]);
  controller.synchronize();
  assert.ok(pi.getActiveTools().includes("optional_tool"));
});

test("refuses to demote hard spine loader tools", () => {
  const pi = mockPi([{ name: "weather_lookup", description: "Weather" }]);
  const controller = createDeferredController(pi, config);
  controller.synchronize({ resetPromotions: true });
  controller.promote(["weather_lookup"]);
  const value = controller.demote(["search_tools", "read", "weather_lookup", "missing"]);
  // search_tools is hard spine; read is neverDefer via config so also protected
  assert.ok(value.protected.includes("search_tools"));
  assert.ok(value.protected.includes("read"));
  assert.deepEqual(value.removed, ["weather_lookup"]);
  assert.deepEqual(value.unknown, ["missing"]);
  assert.ok(pi.getActiveTools().includes("search_tools"));
  assert.ok(pi.getActiveTools().includes("read"));
});

test("SPINE_NAMES contains only discovery (no admin or third-party hardcodes)", async () => {
  const { SPINE_NAMES } = await import("../engine.js");
  assert.ok(SPINE_NAMES.has("search_tools"));
  assert.ok(!SPINE_NAMES.has("critical_tool"));
  assert.ok(!SPINE_NAMES.has("backend_status"));
  assert.ok(!SPINE_NAMES.has("list_capabilities"));
});

test("alwaysActive pin vs neverDefer demote-guard are distinct", () => {
  const pi = mockPi([
    { name: "pinned_only", description: "Pin only" },
    { name: "guard_only", description: "Guard only" },
    { name: "both_roles", description: "Both" },
    { name: "weather_lookup", description: "Weather" },
  ]);
  const c = {
    enabled: true,
    deferByDefault: true,
    alwaysActive: ["pinned_only", "both_roles"],
    neverDefer: ["guard_only", "both_roles"],
    deferredNames: [],
    deferredPrefixes: [],
  };
  const controller = createDeferredController(pi, c);
  controller.synchronize({ resetPromotions: true });

  // Pins forced active; guard_only is not pinned so stays inactive under deferByDefault
  // (neverDefer alone = never auto-defer if active, but does not force-activate).
  // Actually: shouldDefer(guard_only) is false, so guard_only is NOT added to deferred.
  // next = activeNames().filter(!deferred) — mock starts all active, so guard_only stays.
  assert.ok(pi.getActiveTools().includes("pinned_only"), "pin forced active");
  assert.ok(pi.getActiveTools().includes("both_roles"), "both roles active");
  assert.ok(pi.getActiveTools().includes("guard_only"), "guard stays if already active");
  assert.ok(!pi.getActiveTools().includes("weather_lookup"), "unlisted deferred");

  // Demote: pin-only allowed; neverDefer refused; both_roles refused (guard wins)
  const demote = controller.demote(["pinned_only", "guard_only", "both_roles", "search_tools"]);
  assert.deepEqual(demote.removed, ["pinned_only"]);
  assert.ok(demote.protected.includes("guard_only"));
  assert.ok(demote.protected.includes("both_roles"));
  assert.ok(demote.protected.includes("search_tools"));
  assert.ok(!pi.getActiveTools().includes("pinned_only"), "pin-only demotable");
  assert.ok(pi.getActiveTools().includes("guard_only"));
  assert.ok(pi.getActiveTools().includes("both_roles"));

  // Next synchronize re-pins alwaysActive (clears manual demote for pins)
  controller.synchronize();
  assert.ok(pi.getActiveTools().includes("pinned_only"), "pin re-forced after demote on sync");
});

test("neverDefer alone does not force-activate a previously inactive tool", () => {
  const tools = [
    { name: "read", description: "Read" },
    { name: "search_tools", description: "Search" },
    { name: "guard_only", description: "Guard only" },
  ];
  let active = ["read", "search_tools"]; // guard_only registered but inactive
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
  };
  const c = {
    enabled: true,
    deferByDefault: true,
    alwaysActive: ["read"],
    neverDefer: ["guard_only", "read"],
    deferredNames: [],
    deferredPrefixes: [],
  };
  const controller = createDeferredController(pi, c);
  controller.synchronize({ resetPromotions: true });
  assert.ok(pi.getActiveTools().includes("read"));
  assert.ok(pi.getActiveTools().includes("search_tools"));
  assert.ok(!pi.getActiveTools().includes("guard_only"), "neverDefer does not pin inactive tools");
});

test("promote and manuallyDeferred are exclusive per name", () => {
  const pi = mockPi([{ name: "optional_tool", description: "Optional" }]);
  const controller = createDeferredController(pi, { ...config, deferByDefault: false });
  controller.synchronize({ resetPromotions: true });
  assert.deepEqual(controller.demote(["optional_tool"]).removed, ["optional_tool"]);
  // promote clears manual demote
  assert.deepEqual(controller.promote(["optional_tool"]).added, ["optional_tool"]);
  controller.synchronize();
  assert.ok(pi.getActiveTools().includes("optional_tool"), "manual demote cleared by promote");
  // demote clears promotion
  assert.deepEqual(controller.demote(["optional_tool"]).removed, ["optional_tool"]);
  controller.synchronize();
  assert.ok(!pi.getActiveTools().includes("optional_tool"), "promotion cleared by demote");
});

test("toolPriority orders prioritized tools first and keeps the rest in registration order", () => {
  const pi = mockPi([{ name: "zero", description: "ZeroStack native execute" }]);
  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: [...config.alwaysActive, "zero"],
    neverDefer: [...config.neverDefer, "zero"],
    toolPriority: ["zero", "read"],
  });
  controller.synchronize({ resetPromotions: true });
  const active = pi.getActiveTools();
  assert.equal(active[0], "zero");
  assert.equal(active[1], "read");
  // Non-prioritized actives keep relative order after the prioritized block.
  const rest = active.slice(2);
  assert.ok(rest.includes("bash"));
  assert.ok(rest.indexOf("bash") < rest.indexOf("search_tools"));
});

test("toolPriority names missing from the registry are ignored, not invented", () => {
  const pi = mockPi();
  const controller = createDeferredController(pi, { ...config, toolPriority: ["ghost_tool", "bash"] });
  controller.synchronize({ resetPromotions: true });
  const active = pi.getActiveTools();
  assert.equal(active[0], "bash");
  assert.ok(!active.includes("ghost_tool"));
});

test("order-only drift is re-applied on synchronize", () => {
  const pi = mockPi();
  const controller = createDeferredController(pi, { ...config, toolPriority: ["bash"] });
  controller.synchronize({ resetPromotions: true });
  const before = pi.calls.length;
  // Simulate the host restoring a resumed session with a different order.
  pi.setActiveTools([...pi.getActiveTools()].reverse());
  controller.synchronize();
  assert.ok(pi.calls.length > before + 1, "synchronize must restore priority order");
  assert.equal(pi.getActiveTools()[0], "bash");
});

test("missing alwaysActive pins are reported by synchronize and status", () => {
  const pi = mockPi();
  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: [...config.alwaysActive, "zero"],
  });
  const state = controller.synchronize({ resetPromotions: true });
  assert.deepEqual(state.missingPins, ["edit", "find", "grep", "ls", "write", "zero"]);
  assert.ok(controller.status().missingPins.includes("zero"));
  // Registering the pinned tool clears the report on the next synchronize.
  pi.register({ name: "zero", description: "ZeroStack native execute" });
  const healed = controller.synchronize();
  assert.ok(!(healed.missingPins || []).includes("zero"));
});
