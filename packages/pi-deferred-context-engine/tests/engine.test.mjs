import assert from "node:assert/strict";
import test from "node:test";
import { rankCapabilities } from "../lib/catalog.js";
import { createDeferredController, orderByPriority, SPINE_NAMES } from "../lib/engine.js";

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

test("awaits Promise-returning setActiveTools (OMP host)", async () => {
  const tools = [
    { name: "search_tools", description: "Search" },
    { name: "read", description: "Read" },
    { name: "weather_lookup", description: "Weather" },
  ];

  let active = tools.map((t) => t.name);

  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: async (names) => {
      await new Promise((r) => setTimeout(r, 1));
      active = [...names];
    },
  };

  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: ["read"],
    neverDefer: ["read"],
  });

  await Promise.resolve(controller.synchronize({ resetPromotions: true }));
  assert.ok(!active.includes("weather_lookup"));
  const promotion = await Promise.resolve(controller.promote(["weather_lookup"]));
  assert.deepEqual(promotion.added, ["weather_lookup"]);
  assert.ok(active.includes("weather_lookup"));
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
  const { SPINE_NAMES } = await import("../lib/engine.js");
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
  // next = activeNames().filter(!deferred) -- mock starts all active, so guard_only stays.
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

test("manual demote does not haunt a tool name after it leaves the registry", () => {
  const extra = { name: "optional_tool", description: "Optional" };
  const pi = mockPi([extra]);
  const controller = createDeferredController(pi, { ...config, deferByDefault: false });
  controller.synchronize({ resetPromotions: true });
  assert.deepEqual(controller.demote(["optional_tool"]).removed, ["optional_tool"]);

  const tools = pi.getAllTools();
  tools.splice(tools.indexOf(extra), 1);
  controller.synchronize();

  pi.register(extra);
  controller.synchronize();
  assert.ok(
    pi.getActiveTools().includes("optional_tool"),
    "stale manual demote must not defer a name that unregistered and returned",
  );
});

test("toolPriority orders prioritized tools first and keeps the rest in registration order", () => {
  const pi = mockPi([{ name: "preferred_reader", description: "Preferred file reader" }]);

  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: [...config.alwaysActive, "preferred_reader"],
    neverDefer: [...config.neverDefer, "preferred_reader"],
    toolPriority: ["preferred_reader", "read"],
  });

  controller.synchronize({ resetPromotions: true });
  const active = pi.getActiveTools();
  assert.equal(active[0], "preferred_reader");
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

test("toolPriority applies immediately when a deferred tool is promoted", () => {
  const pi = mockPi([{ name: "preferred_reader", description: "Preferred file reader" }]);

  const controller = createDeferredController(pi, {
    ...config,
    toolPriority: ["preferred_reader", "bash"],
  });

  controller.synchronize({ resetPromotions: true });
  const before = pi.getActiveTools();
  assert.equal(before[0], "bash");
  assert.ok(!before.includes("preferred_reader"));

  assert.deepEqual(controller.promote(["preferred_reader"]).added, ["preferred_reader"]);
  const after = pi.getActiveTools();
  assert.deepEqual(after.slice(0, 2), ["preferred_reader", "bash"]);
  assert.deepEqual(new Set(after), new Set([...before, "preferred_reader"]), "promotion remains additive");
  assert.deepEqual(
    after.filter((name) => name !== "preferred_reader" && name !== "bash"),
    before.filter((name) => name !== "bash"),
    "unlisted active tools keep their relative order",
  );
});

test("disabled DCE restores registration order without applying toolPriority", () => {
  const pi = mockPi();
  const registered = pi.getAllTools().map((tool) => tool.name);

  const controller = createDeferredController(pi, {
    ...config,
    enabled: false,
    toolPriority: ["bash", "search_tools"],
  });

  const state = controller.synchronize({ resetPromotions: true });
  assert.deepEqual(state.active, registered);
  assert.deepEqual(pi.getActiveTools(), registered);
});

test("orderByPriority ignores unknown and duplicate entries in one stable pass", () => {
  const names = ["read", "bash", "search_tools", "custom_tool"];
  assert.deepEqual(
    orderByPriority(names, ["custom_tool", "ghost_tool", "custom_tool", "read"]),
    ["custom_tool", "read", "bash", "search_tools"],
  );
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
    alwaysActive: [...config.alwaysActive, "preferred_reader"],
  });

  const state = controller.synchronize({ resetPromotions: true });
  assert.deepEqual(state.missingPins, ["edit", "find", "grep", "ls", "preferred_reader", "write"]);
  assert.ok(controller.status().missingPins.includes("preferred_reader"));
  // Registering the pinned tool clears the report on the next synchronize.
  pi.register({ name: "preferred_reader", description: "Preferred file reader" });
  const healed = controller.synchronize();
  assert.ok(!(healed.missingPins || []).includes("preferred_reader"));
});

test("blocked tools stay inactive, refuse promote, catalog state blocked", () => {
  const pi = mockPi([{ name: "grep", description: "Stock grep" }, { name: "asgrep", description: "AST grep" }]);

  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: ["read", "bash", "asgrep", "grep"],
    neverDefer: ["read", "bash", "asgrep"],
    blockedTools: ["grep"],
    blockedPrefixes: [],
  });

  controller.synchronize({ resetPromotions: true });
  assert.ok(!pi.getActiveTools().includes("grep"));
  assert.ok(pi.getActiveTools().includes("asgrep"));
  assert.ok(pi.getActiveTools().includes("search_tools"));
  const blockedRows = controller.catalog({ state: "blocked" }).map((r) => r.name);
  assert.ok(blockedRows.includes("grep"));
  const promotion = controller.promote(["grep", "weather_lookup"]);
  assert.deepEqual(promotion.blocked, ["grep"]);
  assert.ok(!pi.getActiveTools().includes("grep"));
});

test("sessionUnblock restores promotability until setConfig clears", () => {
  const pi = mockPi([{ name: "grep", description: "Stock grep" }]);

  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: ["read"],
    neverDefer: ["read"],
    blockedTools: ["grep"],
    blockedPrefixes: [],
  });

  controller.synchronize({ resetPromotions: true });
  assert.deepEqual(controller.promote(["grep"]).blocked, ["grep"]);
  const session = controller.sessionUnblock(["grep"], { activate: true });
  assert.ok(session.unblocked.includes("grep"));
  assert.ok(pi.getActiveTools().includes("grep"));
  assert.equal(controller.isNameBlocked("grep"), false);
  controller.setConfig({
    ...config,
    alwaysActive: ["read"],
    neverDefer: ["read"],
    blockedTools: ["grep"],
    blockedPrefixes: [],
  }, { clearSessionUnblocks: true });
  assert.equal(controller.isNameBlocked("grep"), true);
  assert.ok(!pi.getActiveTools().includes("grep"));
});

test("sessionUnblock does not activate a tool that was never blocked", () => {
  const pi = mockPi([{ name: "weather_lookup", description: "Weather" }]);
  const controller = createDeferredController(pi, config);
  controller.synchronize({ resetPromotions: true });
  assert.ok(!pi.getActiveTools().includes("weather_lookup"));
  const session = controller.sessionUnblock(["weather_lookup"], { activate: true });
  assert.deepEqual(session.notBlocked, ["weather_lookup"]);
  assert.deepEqual(session.unblocked, []);
  assert.deepEqual(session.promotion.added, []);
  assert.ok(
    !pi.getActiveTools().includes("weather_lookup"),
    "unblock must not promote a merely deferred tool",
  );
});

test("blockedPrefixes deny without listing every name", () => {
  const pi = mockPi([{ name: "mcp_bad_delete", description: "Danger" }]);

  const controller = createDeferredController(pi, {
    ...config,
    alwaysActive: ["read"],
    neverDefer: ["read"],
    blockedTools: [],
    blockedPrefixes: ["mcp_bad_"],
  });

  controller.synchronize({ resetPromotions: true });
  assert.ok(controller.configuredBlockedNames().includes("mcp_bad_delete"));
  assert.deepEqual(controller.promote(["mcp_bad_delete"]).blocked, ["mcp_bad_delete"]);
});

test("hasDeferred matches catalog deferred rows across the lifecycle", () => {
  const pi = mockPi([{ name: "weather_lookup", description: "Look up city weather" }]);
  const controller = createDeferredController(pi, config);

  const parity = () =>
    assert.equal(controller.hasDeferred(), controller.catalog({ state: "deferred" }).length > 0);

  controller.synchronize({ resetPromotions: true });
  assert.equal(controller.hasDeferred(), true);
  parity();
  // Promote every deferred tool: nothing deferred, parity holds at false.
  const deferred = controller.catalog({ state: "deferred" }).map((row) => row.name);

  assert.ok(deferred.length > 0);
  controller.promote(deferred);
  assert.equal(controller.hasDeferred(), false);
  parity();
  // Demote one back: deferred again.
  controller.demote([deferred[0]]);
  assert.equal(controller.hasDeferred(), true);
  parity();
});

test("hasDeferred honors catalog precedence, not the raw deferred set", () => {
  // Blocked names never surface as deferred rows: with every long-tail tool
  // blocked, both the catalog and hasDeferred report none.
  const pi = mockPi();

  const controller = createDeferredController(pi, {
    ...config,
    blockedTools: ["list_capabilities", "promote_tools", "demote_tools"],
    blockedPrefixes: [],
  });

  controller.synchronize({ resetPromotions: true });
  assert.deepEqual(controller.catalog({ state: "deferred" }), []);
  assert.equal(controller.hasDeferred(), false);
});

test("hasDeferred ignores deferred names the host kept active", () => {
  // Silent host refusal is reported, not committed to deferred bookkeeping.
  const pi = mockPi();

  pi.setActiveTools = () => {};

  const controller = createDeferredController(pi, config);

  const result = controller.demote(["list_capabilities"]);

  assert.deepEqual(result.rejected, ["list_capabilities"]);
  assert.ok(pi.getActiveTools().includes("list_capabilities"));
  assert.equal(controller.status().deferred, 0);
  assert.deepEqual(controller.catalog({ state: "deferred" }), []);
  assert.equal(controller.hasDeferred(), false);
});


test("host refusals never report promotions or demotions that did not land", async () => {
  for (const reject of [() => { throw new Error("refused"); }, () => Promise.reject(new Error("refused")), () => {}]) {
    const pi = mockPi([{ name: "alpha", description: "A" }]);
    const c = createDeferredController(pi, config);
    c.synchronize();
    const set = pi.setActiveTools;
    pi.setActiveTools = reject;
    const failed = await c.promote(["alpha"]);
    assert.deepEqual(failed.added, []);
    assert.deepEqual(failed.rejected, ["alpha"]);
    assert.deepEqual(c.promotedNames(), []);
    pi.setActiveTools = set;
    await c.promote(["alpha"]);
    pi.setActiveTools = reject;
    const demotion = await c.demote(["alpha"]);
    assert.deepEqual(demotion.removed, []);
    assert.deepEqual(demotion.rejected, ["alpha"]);
    assert.deepEqual(c.promotedNames(), ["alpha"]);
    const sync = await c.synchronize({ resetPromotions: true });
    assert.ok(!sync.deferred.includes("alpha"));
    assert.equal(c.status().deferred, c.catalog({ state: "deferred" }).length);
  }
});

test("overlapping async transitions preserve earlier promotions and demotions", async () => {
  const pi = mockPi([{ name: "alpha" }, { name: "beta" }]);
  const c = createDeferredController(pi, config);
  c.synchronize();
  const apply = pi.setActiveTools;
  const pending = [];
  pi.setActiveTools = names => new Promise(resolve => pending.push(() => { apply(names); resolve(); }));
  const tick = () => new Promise(resolve => setImmediate(resolve));

  async function settle(...operations) {
    for (let step = 0; step < 12; step++) {
      await tick();
      pending.pop()?.();
    }

    return Promise.all(operations);
  }

  await settle(c.promote(["alpha"]), c.promote(["beta"]));
  assert.ok(pi.getActiveTools().includes("alpha"));
  assert.ok(pi.getActiveTools().includes("beta"));
  await settle(c.demote(["alpha"]), c.synchronize());
  assert.ok(!pi.getActiveTools().includes("alpha"));
  assert.ok(pi.getActiveTools().includes("beta"));
  assert.deepEqual(c.promotedNames(), ["beta"]);
});

test("session unblock awaits activation and returns a settled promotion result", async () => {
  const pi = mockPi([{ name: "alpha" }]);
  const c = createDeferredController(pi, { ...config, blockedTools: ["alpha"] });
  c.synchronize();
  const apply = pi.setActiveTools;
  pi.setActiveTools = async names => { await new Promise(resolve => setImmediate(resolve)); apply(names); };

  const result = await c.sessionUnblock(["alpha"]);
  assert.deepEqual(result.promotion.added, ["alpha"]);
  assert.ok(pi.getActiveTools().includes("alpha"));
});


test("capability ranking skips nameless records without crashing on ties", () => {
  const rows = rankCapabilities("weather", [{ description: "weather" }, { description: "weather" }, { name: "forecast", description: "weather" }], [], 3);
  assert.deepEqual(rows.map(row => row.name), ["forecast"]);
});


test("partial host acceptance reports only observed promotions", async () => {
  const pi = mockPi([{ name: "alpha" }, { name: "beta" }]);
  const c = createDeferredController(pi, config);
  c.synchronize();
  const apply = pi.setActiveTools;
  pi.setActiveTools = async names => apply(names.filter(name => name !== "beta"));
  const result = await c.promote(["alpha", "beta"]);
  assert.deepEqual(result.added, ["alpha"]);
  assert.deepEqual(result.rejected, ["beta"]);
  assert.deepEqual(c.promotedNames(), ["alpha"]);
  assert.ok(result.setActiveError);
  pi.setActiveTools = apply;
  assert.deepEqual((await c.promote(["beta"])).added, ["beta"]);
  assert.equal(c.status().setActiveError, undefined);
});


test("modern exposures keep hidden tools unreachable and distinguish declarations from callability", () => {
  const tools = [
    { name: "search_tools", exposure: "model-only" },
    { name: "direct_tool", exposure: "direct" },
    { name: "model_tool", exposure: "model-only" },
    { name: "code_tool", exposure: "codemode" },
    { name: "deferred_tool", exposure: "deferred" },
    { name: "hidden_tool", exposure: "hidden" },
  ];

  let active = ["search_tools", "direct_tool", "model_tool"];

  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: names => { active = names.filter(name => tools.some(t => t.name === name && t.exposure !== "hidden")); },
  };

  const policy = { ...config, alwaysActive: ["hidden_tool"], neverDefer: [] };
  const controller = createDeferredController(pi, policy);
  const state = controller.synchronize();
  assert.equal(state.setActiveError, undefined, "do not request impossible hidden pins");
  assert.ok(!state.deferred.includes("hidden_tool"));
  assert.deepEqual(state.missingPins, ["hidden_tool"]);
  const rows = () => Object.fromEntries(controller.catalog().map(row => [row.name, row]));
  assert.equal(rows().hidden_tool.state, "hidden");
  assert.equal(rows().direct_tool.callable, false);
  assert.equal(rows().model_tool.callable, false);
  assert.equal(rows().code_tool.callable, true);
  assert.equal(rows().deferred_tool.callable, true);
  assert.equal(rows().code_tool.exposure, "codemode");
  const hidden = controller.promote(["hidden_tool"]);
  assert.deepEqual(hidden.hidden, ["hidden_tool"]);
  assert.deepEqual(hidden.added, []);
  assert.equal(hidden.setActiveError, undefined);
  controller.demote(["hidden_tool"]);
  assert.equal(controller.status().deferred, 4);
  controller.promote(["direct_tool", "model_tool", "code_tool"]);
  assert.equal(rows().direct_tool.callable, true);
  assert.equal(rows().model_tool.state, "active");
  assert.equal(rows().model_tool.callable, false);
  controller.demote(["code_tool"]);
  assert.equal(rows().code_tool.state, "deferred");
  assert.equal(rows().code_tool.callable, true, "demotion is not a hard block on codemode tools");
  controller.setConfig({ ...policy, blockedTools: ["code_tool"] });
  assert.equal(rows().code_tool.state, "blocked");
  assert.equal(rows().code_tool.callable, false);
  controller.sessionUnblock(["code_tool"], { activate: false });
  assert.equal(rows().code_tool.callable, true);
  controller.promote(["deferred_tool"]);
  const restored = controller.setConfig({ ...policy, enabled: false });
  assert.equal(restored.setActiveError, undefined);
  assert.deepEqual(new Set(active), new Set(["search_tools", "direct_tool", "model_tool", "deferred_tool"]));
  assert.equal(controller.status().hidden, 1);
});


test("synchronize re-defers a promotion removed from the host active set", () => {
  const tools = [{ name: "search_tools" }, { name: "weather", description: "Weather forecasts" }];
  let active = tools.map(tool => tool.name);

  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: names => { active = [...names]; },
  };

  const controller = createDeferredController(pi, { enabled: true, deferByDefault: true });
  controller.synchronize();
  controller.promote(["weather"]);
  pi.setActiveTools(["search_tools"]);

  const state = controller.synchronize();
  assert.deepEqual(state.promoted, []);
  assert.deepEqual(state.deferred, ["weather"], "lost activation must re-enter deferral in the same synchronization");
  assert.equal(controller.catalog().find(row => row.name === "weather").state, "deferred");
  assert.equal(controller.hasDeferred(), true, "the next turn still needs discovery guidance");
});


test("status reports live deferred declarations after host loadout and registry changes", () => {
  const hidden = { name: "hidden_later", description: "Changes exposure" };
  const activated = { name: "activated_later", description: "Changes loadout" };
  const disconnected = { name: "disconnected_later", description: "Changes registry" };
  const tools = [{ name: "search_tools" }, hidden, activated, disconnected];
  let active = tools.map(tool => tool.name);

  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: names => { active = [...names]; },
  };

  const controller = createDeferredController(pi, { enabled: true, deferByDefault: true });
  controller.synchronize();
  assert.equal(controller.status().deferred, 3);

  pi.setActiveTools([...active, activated.name]);
  assert.equal(controller.status().deferred, 2, "host activation exposes the schema immediately");
  hidden.exposure = "hidden";
  assert.equal(controller.status().deferred, 1, "owner-hidden tools are no longer deferred capabilities");
  tools.splice(tools.indexOf(disconnected), 1);
  assert.equal(controller.status().deferred, 0, "disconnected tools cannot inflate the current inventory");
  assert.equal(controller.status().deferred, controller.catalog({ state: "deferred" }).length);
  assert.deepEqual(active, ["search_tools", activated.name], "status must not change the host loadout");
});


test("hasDeferred tracks live registration, exposure, activation and block changes", () => {
  const tool = { name: "weather_lookup", description: "Look up city weather" };
  const pi = mockPi([tool]);
  const policy = { ...config, deferByDefault: false, deferredNames: [tool.name], blockedTools: [], blockedPrefixes: [] };
  const controller = createDeferredController(pi, policy);
  controller.synchronize();
  assert.equal(controller.hasDeferred(), true);

  tool.exposure = "hidden";
  assert.equal(controller.hasDeferred(), false);
  delete tool.exposure;
  assert.equal(controller.hasDeferred(), true);

  const inactive = pi.getActiveTools();
  pi.setActiveTools([...inactive, tool.name]);
  assert.equal(controller.hasDeferred(), false);
  pi.setActiveTools(inactive);

  const registered = pi.getAllTools;
  pi.getAllTools = () => registered().filter(item => item !== tool);
  assert.equal(controller.hasDeferred(), false);
  pi.getAllTools = registered;
  assert.equal(controller.hasDeferred(), true);

  policy.blockedTools.push(tool.name);
  assert.equal(controller.hasDeferred(), false);
  policy.blockedTools.length = 0;
  policy.blockedPrefixes.push("weather_");
  assert.equal(controller.hasDeferred(), false);
  controller.sessionUnblock([tool.name], { activate: false });
  assert.equal(controller.hasDeferred(), true);
  controller.clearSessionUnblocks();
  assert.equal(controller.hasDeferred(), false);
});
