/**
 * Hostile edge cases found in audit. Several asserts document known residual risks;
 * the ones expected to fail pre-fix are marked with TODO comments matching RESIDUAL-RISKS.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, mergeConfig } from "../config.js";
import { createDeferredController } from "../engine.js";
import { formatSkillIndex, optimizeSystemPrompt, readSkill } from "../context.js";

function mockPi(toolNames) {
  const tools = toolNames.map((name) => ({ name, description: name }));
  let active = toolNames.slice();
  return {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
  };
}

test("fixed: enabled:false must restore previously deferred tools to active", () => {
  const pi = mockPi(["read", "weather", "search_tools"]);
  const cfg = {
    enabled: true,
    deferByDefault: true,
    alwaysActive: ["read"],
    neverDefer: ["read"],
    deferredNames: [],
    deferredPrefixes: [],
  };
  const controller = createDeferredController(pi, cfg);
  controller.synchronize({ resetPromotions: true });
  assert.ok(!pi.getActiveTools().includes("weather"), "weather deferred while enabled");

  controller.setConfig({ ...cfg, enabled: false }, { resetPromotions: true });
  // When the engine is disabled, the host should see the full tool set again.
  assert.ok(
    pi.getActiveTools().includes("weather"),
    "expected weather re-activated after enabled:false; got active=" + JSON.stringify(pi.getActiveTools()),
  );
  assert.equal(controller.status().deferred, 0);
});

test("fixed: /deferred reload to enabled:false leaves stripped active set", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-hostile-disable-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      deferByDefault: true,
      replaceAlwaysActive: true,
      replaceNeverDefer: true,
      alwaysActive: ["read"],
      neverDefer: ["read"],
    }),
    "utf8",
  );
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;
  try {
    const { default: extension } = await import(`../index.js?hostile-disable=${Date.now()}`);
    const tools = [
      { name: "read", description: "Read", parameters: {} },
      { name: "weather", description: "Weather", parameters: {} },
    ];
    let active = tools.map((t) => t.name);
    const handlers = new Map();
    const commands = new Map();
    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        active = [...new Set(names)];
      },
      registerTool: (tool) => {
        tools.push(tool);
        active.push(tool.name);
      },
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
    };
    extension(pi);
    await handlers.get("session_start")();
    assert.ok(!active.includes("weather"));

    fs.writeFileSync(configPath, JSON.stringify({ enabled: false }), "utf8");
    await commands.get("deferred").handler("reload", {
      ui: { notify() {} },
      getSystemPrompt: () => "",
      getSystemPromptOptions: () => ({}),
    });
    assert.ok(
      active.includes("weather"),
      "reload enabled:false should restore weather; active=" + JSON.stringify(active),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed: non-object JSON config is accepted without schema guard", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-hostile-array-"));
  const configPath = path.join(directory, "arr.json");
  fs.writeFileSync(configPath, JSON.stringify([{ enabled: false }]), "utf8");
  try {
    assert.throws(
      () => loadConfig(configPath, { strict: true }),
      /Invalid deferred-tools config|must be a JSON object/,
      "strict load of array config should throw",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed: setActiveTools throw escapes synchronize", () => {
  const tools = [
    { name: "read", description: "R" },
    { name: "search_tools", description: "S" },
    { name: "weather", description: "W" },
  ];
  let active = tools.map((t) => t.name);
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: () => {
      throw new Error("host refused setActiveTools");
    },
  };
  const controller = createDeferredController(pi, {
    enabled: true,
    deferByDefault: true,
    alwaysActive: ["read"],
    neverDefer: ["read"],
    deferredNames: [],
    deferredPrefixes: [],
  });
  // Prefer: synchronize should not throw; degrade gracefully.
  assert.doesNotThrow(() => controller.synchronize({ resetPromotions: true }));
});

test("document: skill strip is exact-match (CRLF does not strip)", () => {
  const skills = [{ name: "alpha", description: "A", filePath: "/r/alpha/SKILL.md" }];
  const exact = formatSkillIndex(skills);
  const crlf = "base" + exact.replace(/\n/g, "\r\n") + "\nend";
  const optimized = optimizeSystemPrompt(crlf, { skills }, { deferSkills: true });
  // Current behavior: strip fails on CRLF — residual risk for Windows hosts.
  assert.match(optimized.systemPrompt, /available_skills/, "documents current exact-match limitation");
  assert.equal(optimized.stats.deferredSkillChars, 0);
});

test("document: replaceAlwaysActive [] soft-locks to spine only", () => {
  const defaults = loadConfig(path.join(os.tmpdir(), `pi-deferred-missing-${Date.now()}.json`));
  const cfg = mergeConfig(defaults, {
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: [],
    neverDefer: [],
    deferByDefault: true,
  });
  const pi = mockPi(["read", "bash", "search_tools", "weather"]);
  const controller = createDeferredController(pi, cfg);
  controller.synchronize({ resetPromotions: true });
  assert.deepEqual(pi.getActiveTools().sort(), ["search_tools"]);
  // Recovery path still works via promote.
  assert.deepEqual(controller.promote(["weather"]).added, ["weather"]);
  assert.ok(pi.getActiveTools().includes("weather"));
});

test("document: readSkill follows symlinks (skill paths are trusted)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-hostile-link-"));
  const outside = path.join(os.tmpdir(), `pi-deferred-secret-${Date.now()}.txt`);
  fs.writeFileSync(outside, "SECRET", "utf8");
  const link = path.join(directory, "SKILL.md");
  fs.symlinkSync(outside, link);
  try {
    assert.equal(readSkill({ name: "escape", filePath: link }, 1024), "SECRET");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("document: blocked tools are NOT recoverable via promote (harder than empty-pin soft-lock)", () => {
  const defaults = loadConfig(path.join(os.tmpdir(), `pi-deferred-missing-${Date.now()}.json`));
  const cfg = mergeConfig(defaults, {
    replaceAlwaysActive: true,
    alwaysActive: ["read"],
    neverDefer: ["read"],
    blockedTools: ["weather"],
    blockedPrefixes: [],
  });
  const pi = mockPi(["read", "search_tools", "weather"]);
  const controller = createDeferredController(pi, cfg);
  controller.synchronize({ resetPromotions: true });
  assert.ok(!pi.getActiveTools().includes("weather"));
  // Contrast empty-pin soft-lock: promote cannot resurrect a blocked tool.
  const promotion = controller.promote(["weather"]);
  assert.deepEqual(promotion.blocked, ["weather"]);
  assert.deepEqual(promotion.added, []);
  assert.ok(!pi.getActiveTools().includes("weather"));
  // Human break-glass can.
  const session = controller.sessionUnblock(["weather"], { activate: true });
  assert.ok(session.unblocked.includes("weather"));
  assert.ok(pi.getActiveTools().includes("weather"));
});
