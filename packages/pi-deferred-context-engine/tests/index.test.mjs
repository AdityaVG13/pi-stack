import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatSkillIndex } from "../lib/context.js";

function contextBlock(file) {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

test("extension defers tools and skills for one complete agent run", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-extension-"));
  const configPath = path.join(directory, "config.json");
  const skillPath = path.join(directory, "SKILL.md");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    deferByDefault: true,
    deferSkills: true,
    deduplicateContext: true,
    promotionLifetime: "run",
    maxSearchResults: 3,
    maxSkillBytes: 4096,
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: ["critical_tool", "confirm_user", "show_plan"],
    neverDefer: ["critical_tool", "confirm_user", "show_plan"],
    toolPriority: ["weather_lookup", "show_plan", "critical_tool"],
  }), "utf8");
  fs.writeFileSync(skillPath, "# Release workflow\n\nVerify tests before publishing.\n", "utf8");

  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?test=${Date.now()}`);

    const tools = [
      { name: "critical_tool", description: "Run a critical workflow", parameters: {} },
      { name: "confirm_user", description: "Confirm with the user", parameters: {} },
      { name: "show_plan", description: "Show a plan", parameters: {} },
      { name: "weather_lookup", description: "Look up current weather forecasts", parameters: {} },
    ];

    let active = tools.map((tool) => tool.name);
    const registered = new Map();
    const handlers = new Map();
    const commands = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...new Set(names)]; },
      registerTool: (tool) => { tools.push(tool); active.push(tool.name); registered.set(tool.name, tool); },
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();
    assert.deepEqual([...active].sort(), ["confirm_user", "show_plan", "search_tools", "critical_tool"].sort());
    assert.deepEqual(active.slice(0, 2), ["show_plan", "critical_tool"]);
    assert.ok(!active.includes("list_capabilities"));

    const contexts = [
      { path: "/global/AGENTS.md", content: "same rules" },
      { path: "/fixture-b/AGENTS.md", content: "same rules" },
    ];

    const skills = [{
      name: "release-workflow",
      description: "Publish and verify a software release",
      filePath: skillPath,
      disableModelInvocation: false,
    }];

    const systemPrompt = contexts.map(contextBlock).join("") + formatSkillIndex(skills);

    const promptResult = await handlers.get("before_agent_start")({
      prompt: "prepare a release",
      systemPrompt,
      systemPromptOptions: { contextFiles: contexts, skills, selectedTools: active },
    });

    assert.doesNotMatch(promptResult.systemPrompt, /fixture-b\/AGENTS/);
    assert.doesNotMatch(promptResult.systemPrompt, /available_skills/);

    const skillResult = await registered.get("search_tools").execute("skill-1", {
      query: "release workflow",
      kind: "skill",
    });

    assert.match(skillResult.content[0].text, /Verify tests before publishing/);

    const toolResult = await registered.get("search_tools").execute("tool-1", {
      query: "current weather forecast",
      kind: "tool",
    });

    assert.match(toolResult.content[0].text, /weather_lookup/);
    assert.ok(active.includes("weather_lookup"));
    assert.deepEqual(active.slice(0, 3), ["weather_lookup", "show_plan", "critical_tool"]);

    await handlers.get("agent_settled")();
    assert.ok(!active.includes("weather_lookup"));
    assert.deepEqual([...active].sort(), ["confirm_user", "show_plan", "search_tools", "critical_tool"].sort());
    assert.deepEqual(active.slice(0, 2), ["show_plan", "critical_tool"]);
    assert.ok(commands.has("deferred"));
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enabled false skips skill strip and deferred_tools injection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-disabled-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: false, deferSkills: true, deduplicateContext: true }), "utf8");
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?disabled=${Date.now()}`);
    const tools = [{ name: "read", description: "Read", parameters: {} }];
    // A host runtime reload can retain the previous DCE-deferred active set.
    let active = [];
    const handlers = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...new Set(names)]; },
      registerTool: (tool) => { tools.push(tool); active.push(tool.name); },
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();
    assert.ok(active.includes("read"), "disabled startup must restore a previously deferred direct tool");
    const skills = [{ name: "release-workflow", description: "Ship", filePath: path.join(directory, "SKILL.md"), disableModelInvocation: false }];
    fs.writeFileSync(skills[0].filePath, "# x\n", "utf8");
    const systemPrompt = formatSkillIndex(skills);

    const result = await handlers.get("before_agent_start")({
      prompt: "hi",
      systemPrompt,
      systemPromptOptions: { skills, contextFiles: [], selectedTools: active },
    });

    assert.deepEqual(result, {});
    assert.match(systemPrompt, /available_skills/);
    assert.equal(tools.find(tool => tool.name === "search_tools").prepareLoadout({
      declared: [{ name: "hidden_tool" }], getExposure: () => "hidden",
    }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("OMP before_agent_start preserves string[] prompt blocks (no comma-join)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-omp-array-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    deferByDefault: true,
    deferSkills: true,
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: ["read"],
    neverDefer: ["read"],
  }), "utf8");
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?omp-array=${Date.now()}`);

    const tools = [
      { name: "read", description: "Read", parameters: {} },
      { name: "weather_lookup", description: "Weather forecasts for cities", parameters: {} },
    ];

    let active = tools.map((t) => t.name);
    const handlers = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...new Set(names)]; },
      registerTool: (tool) => { tools.push(tool); active.push(tool.name); },
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();
    const blocks = ["# system block A", "# system block B with AGENTS"];

    const result = await handlers.get("before_agent_start")({
      prompt: "weather",
      systemPrompt: blocks,
      // OMP often omits systemPromptOptions on the event
    }, {});

    assert.ok(Array.isArray(result.systemPrompt), "OMP return must be string[]");
    assert.equal(result.systemPrompt[0], blocks[0]);
    assert.equal(result.systemPrompt[1], blocks[1]);
    assert.match(result.systemPrompt[2] || "", /deferred_tools/);
    assert.doesNotMatch(result.systemPrompt.join("\n"), /block A,block B/);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("before_agent_start injects short deferred_tools guidance without full catalog", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-blurb-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    deferByDefault: true,
    deferSkills: true,
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: ["read"],
    neverDefer: ["read"],
  }), "utf8");
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?blurb=${Date.now()}`);

    const tools = [
      { name: "read", description: "Read", parameters: {} },
      { name: "weather_lookup", description: "Weather forecasts for cities", parameters: {} },
    ];

    let active = tools.map((t) => t.name);
    const handlers = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...new Set(names)]; },
      registerTool: (tool) => { tools.push(tool); active.push(tool.name); },
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();

    const result = await handlers.get("before_agent_start")({
      prompt: "weather",
      systemPrompt: "base",
      systemPromptOptions: { skills: [], contextFiles: [], selectedTools: active },
    });

    assert.match(result.systemPrompt, /deferred_tools/);
    assert.match(result.systemPrompt, /search_tools/);
    assert.doesNotMatch(result.systemPrompt, /weather_lookup/);
    assert.doesNotMatch(result.systemPrompt, /Weather forecasts/);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("session-lifetime promotions prompt once to keep, then pin on confirm", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-keep-flow-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    deferByDefault: true,
    promotionLifetime: "session",
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: ["critical_tool"],
    neverDefer: ["critical_tool"],
  }), "utf8");

  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?keep=${Date.now()}`);

    const tools = [
      { name: "critical_tool", description: "Run a critical workflow", parameters: {} },
      { name: "weather_lookup", description: "Look up current weather forecasts", parameters: {} },
    ];

    let active = tools.map((tool) => tool.name);
    const handlers = new Map();
    const commands = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...new Set(names)]; },
      registerTool: (tool) => { tools.push(tool); active.push(tool.name); },
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();
    assert.ok(!active.includes("weather_lookup"));

    // Promote via search_tools, as the model would.
    const searchTool = tools.find((tool) => tool.name === "search_tools");
    await searchTool.execute("call-1", { query: "weather forecast" }, undefined, { ui: { notify: () => {} } });
    assert.ok(active.includes("weather_lookup"));

    // Settle #1: confirm keeps the tool; config file gains the pin.
    const confirms = [];
    const notes = [];

    const ctx = {
      ui: {
        confirm: async (title, message) => { confirms.push({ title, message });

 return true; },
        notify: (text, kind) => notes.push({ text, kind }),
      },
    };

    await handlers.get("agent_settled")({}, ctx);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0].message, /weather_lookup/);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(raw.alwaysActive, ["critical_tool", "weather_lookup"]);
    assert.ok(active.includes("weather_lookup"));

    // Settle #2: same tool never re-asked.
    await handlers.get("agent_settled")({}, ctx);
    assert.equal(confirms.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});

test("session-lifetime promotions survive agent_settled without a UI", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-keep-noui-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    deferByDefault: true,
    promotionLifetime: "session",
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: ["critical_tool"],
    neverDefer: ["critical_tool"],
  }), "utf8");

  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?keepnoui=${Date.now()}`);

    const tools = [
      { name: "critical_tool", description: "Run a critical workflow", parameters: {} },
      { name: "weather_lookup", description: "Look up current weather forecasts", parameters: {} },
    ];

    let active = tools.map((tool) => tool.name);
    const handlers = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...new Set(names)]; },
      registerTool: (tool) => { tools.push(tool); active.push(tool.name); },
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();
    const searchTool = tools.find((tool) => tool.name === "search_tools");
    await searchTool.execute("call-1", { query: "weather forecast" }, undefined, { ui: { notify: () => {} } });
    assert.ok(active.includes("weather_lookup"));

    // Headless settle (no ctx): promotion persists, nothing is asked or reset.
    await handlers.get("agent_settled")({});
    assert.ok(active.includes("weather_lookup"));
    const ctx = { hasUI: false, ui: { confirm: async () => ctx.hasUI, notify() {} } };
    await handlers.get("agent_settled")({}, ctx);
    ctx.hasUI = true;
    await handlers.get("agent_settled")({}, ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).alwaysActive, ["critical_tool", "weather_lookup"],
      "headless UI stubs must not consume a future interactive keep prompt");
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("DCE priority survives conflicting package guidance and request-boundary drift", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-priority-"));
  const configPath = path.join(directory, "config.json");

  const config = {
    enabled: true, deferByDefault: true,
    replaceAlwaysActive: true, replaceNeverDefer: true,
    alwaysActive: ["supernova", "legacy_edit"], neverDefer: [],
    blockedTools: ["blocked_edit"], toolPriority: ["supernova", "legacy_edit"],
  };

  fs.writeFileSync(configPath, JSON.stringify(config));
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;

  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import("../index.js");

    const tools = [
      { name: "legacy_edit", description: "Always edit with legacy_edit", parameters: {} },
      { name: "supernova", description: "Read, write, edit and bash", parameters: {} },
      { name: "blocked_edit", description: "Blocked editor", parameters: {} },
      { name: "specialist", description: "A distinct deferred capability", parameters: {} },
    ];

    let active = tools.map(tool => tool.name);
    const handlers = new Map();
    const commands = new Map();

    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      async setActiveTools(names) { await Promise.resolve(); active = [...names]; },
      registerTool(tool) { tools.push(tool); active.push(tool.name); },
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
    };

    extension(pi);
    await handlers.get("session_start")();
    const conflict = "Package guidance: always use legacy_edit, never supernova. Keep paths inside the workspace.";
    const prompt = await handlers.get("before_agent_start")({ systemPrompt: conflict });

    assert.match(prompt.systemPrompt ?? conflict, /dce_tool_priority/);
    assert.ok(prompt.systemPrompt.includes("overrides package/tool routing preferences"));
    assert.ok(prompt.systemPrompt.indexOf("dce_tool_priority") > prompt.systemPrompt.indexOf(conflict));

    const system = {
      role: "system", content: [{ type: "text", text: conflict }],
      tools: [tools[0], tools[2], tools[1]], toolsAdded: [tools[0], tools[2], tools[1]],
    };

    const user = { role: "user", content: "Edit one file." };
    const messages = [system, user];
    const original = structuredClone(messages);

    // A later-loaded package reorders/reactivates tools after startup.
    active = ["legacy_edit", "blocked_edit", "supernova", "search_tools"];
    const projected = (await handlers.get("context_with_system")?.({ messages }))?.messages ?? messages;

    assert.deepEqual(active, ["supernova", "legacy_edit", "search_tools"]);
    assert.deepEqual(projected[0].tools.map(tool => tool.name), ["supernova", "legacy_edit"]);
    assert.deepEqual(projected[0].toolsAdded.map(tool => tool.name), ["supernova", "legacy_edit"]);
    assert.ok(projected[0].content.at(-1).text.includes("overrides package/tool routing preferences"));
    assert.equal(projected[1], user);
    assert.deepEqual(messages, original, "request projection never rewrites stored history");
    assert.equal(await handlers.get("context_with_system")({ messages: projected }), undefined, "projection is idempotent");
    assert.equal((await handlers.get("tool_call")?.({ toolName: "blocked_edit" }))?.block, true);
    assert.equal(await handlers.get("tool_call")({ toolName: "legacy_edit" }), undefined, "priority is capability-aware, not a blanket deny");

    const payloads = [
      { instructions: conflict, tools: [tools[0], tools[2], tools[1]] },
      { system: [{ type: "text", text: conflict, cache_control: { type: "ephemeral" } }], tools: [tools[0], tools[1]] },
      { messages: [{ role: "system", content: conflict }, { role: "user", content: "Edit" }], tools: [
        { type: "function", function: tools[0] }, { type: "function", function: tools[1] },
      ] },
      { input: [{ role: "developer", content: conflict }], tools: [tools[0], tools[1]] },
      { systemInstruction: { parts: [{ text: conflict }] }, tools: [tools[0], tools[1]] },
      { config: { systemInstruction: conflict, temperature: 0.2 }, tools: [tools[0], tools[1]] },
      { model: "gemini-2.5-pro", contents: [], config: {
        systemInstruction: conflict, temperature: 0.2,
        tools: [{ functionDeclarations: [tools[0], tools[2], tools[1]] }],
      } },
      { systemInstruction: { parts: [{ text: conflict }] }, tools: [
        { functionDeclarations: [tools[0], tools[2], tools[1]] },
      ] },
    ];

    for (const payload of payloads) {
      const snapshot = structuredClone(payload);
      const final = await handlers.get("before_provider_request")?.({ payload }) ?? payload;

      const instruction = final.instructions ?? final.system?.at(-1)?.text ?? final.messages?.[0].content ??
        final.input?.[0].content ?? final.systemInstruction?.parts[0].text ?? final.config?.systemInstruction;

      assert.ok(instruction.endsWith("</dce_tool_priority>"), "priority survives host forced-prompt projection");
      const declarations = (final.config?.tools ?? final.tools).flatMap(tool => tool.functionDeclarations ?? [tool]);
      assert.equal(declarations[0].name ?? declarations[0].function.name, "supernova");
      assert.ok(declarations.every(tool => (tool.name ?? tool.function?.name) !== "blocked_edit"));
      assert.deepEqual(payload, snapshot);

      if (payload.system) assert.deepEqual(final.system[0].cache_control, payload.system[0].cache_control);

      if (payload.config) assert.equal(final.config.temperature, payload.config.temperature);
      assert.equal(await handlers.get("before_provider_request")({ payload: final }), undefined);
    }

    fs.writeFileSync(configPath, JSON.stringify({ ...config, enabled: false }));
    await commands.get("deferred").handler("reload", { ui: { notify() {} } });
    assert.equal(await handlers.get("context_with_system")({ messages }), undefined);
    assert.equal(await handlers.get("tool_call")({ toolName: "blocked_edit" }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("human unblock reports settled activation on async hosts", async () => {
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;

  try {
    for (const suffix of ["", " --persist"]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dce-unblock-async-"));
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ enabled: true, blockedTools: ["alpha"] }));
      process.env.PI_DEFERRED_TOOLS_CONFIG = file;
      const { default: extension } = await import("../index.js");
      const tools = [{ name: "alpha", description: "Alpha", parameters: {} }];
      let active = ["alpha"];
      const handlers = new Map(), commands = new Map(), notices = [];
      extension({
        getAllTools: () => tools,
        getActiveTools: () => [...active],
        setActiveTools: async names => { await new Promise(resolve => setImmediate(resolve)); active = [...names]; },
        registerTool: tool => { tools.push(tool); active.push(tool.name); },
        registerCommand: (name, command) => commands.set(name, command),
        on: (name, handler) => handlers.set(name, handler),
      });
      await handlers.get("session_start")();
      assert.ok(!active.includes("alpha"));
      await commands.get("deferred").handler("unblock alpha" + suffix, { ui: { notify: text => notices.push(text) } });
      assert.ok(active.includes("alpha"));
      assert.match(notices.at(-1), suffix ? /"notBlocked":\["alpha"\]/ : /"unblocked":\["alpha"\]/);

      if (!suffix) assert.match(notices.at(-1), /"activated":\["alpha"\]/);
      await handlers.get("session_start")();
      const denied = handlers.get("tool_call")({ toolName: "alpha" })?.block === true;
      assert.equal(denied, !suffix, "only a persistent unblock survives a new session");

      if (!suffix) assert.ok(!active.includes("alpha"));
      const context = { ui: { notify: text => notices.push(text) } };
      const configuration = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...configuration, enabled: false }));
      await commands.get("deferred").handler("reload", context);
      await commands.get("deferred").handler("status", context);
      assert.match(notices.at(-1), /^deferred off/);
      await commands.get("deferred").handler("unblock alpha" + suffix, context);
      await commands.get("deferred").handler("blocked", context);

      // Disabled DCE has no blocked tools, so it cannot create exemptions.
      assert.doesNotMatch(notices.at(-1), /session-unblocked/);
      await handlers.get("session_start")();
      await commands.get("deferred").handler("blocked", context);
      assert.doesNotMatch(notices.at(-1), /session-unblocked/, "do not expose a past session exemption while disabled");
      fs.writeFileSync(file, JSON.stringify({ ...configuration, enabled: true }));
      await commands.get("deferred").handler("reload", context);
      assert.equal(handlers.get("tool_call")({ toolName: "alpha" })?.block === true, !suffix, "re-enabling preserves only the persistent policy change");
    }
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("declined keep-promotion prompts reset for a new session", async () => {
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dce-session-prompts-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ enabled: true, deferByDefault: true, promotionLifetime: "session", replaceAlwaysActive: true, replaceNeverDefer: true, alwaysActive: [], neverDefer: [] }));
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const tools = [{ name: "weather", description: "Weather forecasts", parameters: {} }];
    let active = ["weather"];
    const handlers = new Map(), prompts = [];
    extension({
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: names => { active = [...names]; },
      registerTool: tool => { tools.push(tool); active.push(tool.name); },
      registerCommand() {},
      on: (name, handler) => handlers.set(name, handler),
    });

    const context = { ui: { notify() {}, confirm: async (_title, message) => {
      prompts.push(message);

      return prompts.length > 1;
    } } };

    const promote = () => tools.find(tool => tool.name === "search_tools").execute("search", { query: "weather", kind: "tool" });
    await handlers.get("session_start")();
    await promote();
    await handlers.get("agent_settled")({}, context);
    await handlers.get("agent_settled")({}, context);
    assert.equal(prompts.length, 1, "do not re-ask after a decline in the same session");
    assert.ok(!JSON.parse(fs.readFileSync(file, "utf8")).alwaysActive.includes("weather"));
    await handlers.get("session_start")();
    await promote();
    await handlers.get("agent_settled")({}, context);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).alwaysActive.includes("weather"), "offer and persist the pin in the new session");
    assert.equal(prompts.length, 2);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("keep-promotion does not pin a tool that left the registry", async () => {
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dce-keep-ghost-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    enabled: true, deferByDefault: true, promotionLifetime: "session",
    replaceAlwaysActive: true, replaceNeverDefer: true, alwaysActive: [], neverDefer: [],
  }));
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const weather = { name: "weather", description: "Weather forecasts", parameters: {} };
    const tools = [weather];
    let active = ["weather"];
    const handlers = new Map(), prompts = [];
    extension({
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: names => { active = [...names]; },
      registerTool: tool => { tools.push(tool); active.push(tool.name); },
      registerCommand() {},
      on: (name, handler) => handlers.set(name, handler),
    });

    await handlers.get("session_start")();
    await tools.find(tool => tool.name === "search_tools").execute("search", { query: "weather", kind: "tool" });
    assert.ok(active.includes("weather"));

    tools.splice(tools.indexOf(weather), 1);
    active = active.filter(name => name !== "weather");

    await handlers.get("agent_settled")({}, {
      ui: { notify() {}, confirm: async (_title, message) => { prompts.push(message); return true; } },
    });

    assert.deepEqual(prompts, [], "unregistered promotions must not be offered for alwaysActive");
    assert.ok(!JSON.parse(fs.readFileSync(file, "utf8")).alwaysActive?.includes("weather"));
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("keep-promotion rechecks tools after an open confirmation dialog", async () => {
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "dce-keep-disconnect-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    promotionLifetime: "session", alwaysActive: [], neverDefer: [],
  }));
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const departing = { name: "weather_remote", description: "Weather forecasts", parameters: {} };
    const remaining = { name: "weather_local", description: "Weather forecasts", parameters: {} };
    const tools = [departing, remaining];
    let active = tools.map(tool => tool.name);
    const handlers = new Map();
    extension({
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: names => { active = [...names]; },
      registerTool: tool => { tools.push(tool); active.push(tool.name); },
      registerCommand() {},
      on: (name, handler) => handlers.set(name, handler),
    });
    await handlers.get("session_start")();
    await tools.find(tool => tool.name === "promote_tools").execute("promote", {
      names: [departing.name, remaining.name],
    });

    let accept, opened;
    const confirmation = new Promise(resolve => { accept = resolve; });
    const dialogOpened = new Promise(resolve => { opened = resolve; });

    const settled = handlers.get("agent_settled")({}, {
      ui: { notify() {}, confirm: async () => {
        opened();

        return confirmation;
      } },
    });

    await dialogOpened;
    tools.splice(tools.indexOf(departing), 1);
    active = active.filter(name => name !== departing.name);
    accept(true);
    await settled;

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.alwaysActive, [remaining.name], "only still-live promotions may become permanent pins");
    assert.ok(active.includes(remaining.name));
    assert.ok(!active.includes(departing.name));
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("modern discovery respects hidden exposure and hard blocks direct and nested calls", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-exposure-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    replaceAlwaysActive: true, replaceNeverDefer: true,
    alwaysActive: [], neverDefer: [], blockedTools: ["blocked_tool"],
  }));
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import("../index.js");

    const tools = [
      { name: "hidden_tool", description: "buried sentinel", exposure: "hidden" },
      { name: "deferred_tool", description: "weather forecast", exposure: "deferred" },
      { name: "blocked_tool", description: "blocked operation", exposure: "codemode" },
    ];

    let active = [];
    const registered = new Map();
    const handlers = new Map();
    extension({
      getAllTools: () => tools,
      getActiveTools: () => [...active],
      setActiveTools: names => { active = names.filter(name => tools.some(t => t.name === name && t.exposure !== "hidden")); },
      registerTool: tool => { tools.push(tool); active.push(tool.name); registered.set(tool.name, tool); },
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    });
    await handlers.get("session_start")();
    const search = registered.get("search_tools");
    const found = await search.execute("hidden", { query: "buried sentinel", kind: "tool" });
    assert.deepEqual(found.details.matches, [], "author-hidden tools are not discoverable");
    const promoted = await search.execute("weather", { query: "weather forecast", kind: "tool" });
    assert.deepEqual(promoted.details.added, ["deferred_tool"]);

    for (const parentToolCallId of [undefined, "outer/1"]) {
      assert.equal(handlers.get("tool_call")({ toolName: "blocked_tool", parentToolCallId }).block, true);
      assert.equal(handlers.get("tool_call")({ toolName: "deferred_tool", parentToolCallId }), undefined);
    }

    const loadout = {
      declared: tools, callable: [], registered: tools,
      getExposure: name => tools.find(t => t.name === name).exposure ?? "direct",
    };

    assert.deepEqual(new Set(search.prepareLoadout(loadout).hiddenDeclarations), new Set(["blocked_tool", "hidden_tool"]));

    for (const name of ["search_tools", "promote_tools", "demote_tools"]) {
      assert.equal(registered.get(name).exposure, "model-only", "loadout controllers cannot be nested");
    }

    const listed = await registered.get("list_capabilities").execute("list", { state: "hidden" });
    assert.deepEqual(listed.details.rows.map(row => row.name), ["hidden_tool"]);
    await handlers.get("agent_settled")();
    assert.ok(!active.includes("deferred_tool"));
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("TUI lifecycle warnings use the event context and validation failures are errors", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-tui-lifecycle-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify({ blockedTools: ["read"] }));
  t.diagnostic("Fixture retained at " + directory);
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const registered = new Map(), handlers = new Map();
    let active = ["read"];
    extension({ registerTool: tool => registered.set(tool.name, tool), registerCommand() {},
      on: (name, handler) => handlers.set(name, handler),
      getAllTools: () => [{ name: "read" }, ...registered.values()],
      getActiveTools: () => active, setActiveTools: names => { active = names; } });
    const notices = [];
    await handlers.get("session_start")({}, { ui: { notify: (text, level) => notices.push({ text, level }) } });
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /CAUTION.*read/);
    assert.equal(notices[0].level, "warning");

    for (const [name, params] of [["promote_tools", { names: [""] }], ["demote_tools", { names: [""] }], ["search_tools", { query: 1 }]]) {
      const failure = await registered.get(name).execute("bad", params);
      assert.equal(failure.isError, true, name + " must select the host error background and error semantics");
      assert.ok(failure.details.error);
    }

    const success = await registered.get("promote_tools").execute("ok", { names: ["search_tools"] });
    assert.notEqual(success.isError, true);
    const { blockedToolsCautionWarnings } = await import("../lib/config.js");
    assert.deepEqual(blockedToolsCautionWarnings({ enabled: false, blockedTools: ["read"] }), [],
      "disabled policy must not claim tools are blocked");
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});

test("TUI renderers retain layouts, refresh changed text and themes, and bound compact output", async () => {
  const { default: extension } = await import("../index.js");
  const tools = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };

  for (const name of ["list_capabilities", "search_tools", "promote_tools", "demote_tools"]) {
    const tool = tools.get(name);
    assert.equal(tool.renderShell, "self");
    const context = { state: {}, args: { query: "Unicode 中文 😀 é " + "term ".repeat(80) }, expanded: false, isPartial: true };
    const result = { content: [{ type: "text", text: "\u001b[31mfirst\u0007\n" + "Unicode 中文 😀 é row\n".repeat(100) + "last-row" }] };
    const call = () => tool.renderCall(context.args, theme, context);
    const renderResult = () => tool.renderResult(result, { expanded: context.expanded }, theme, context);
    const compact = call(); renderResult();
    const original = compact.render(120);
    assert.ok(original.length < 25);
    assert.equal(original.join("\n").includes("last-row"), false);
    assert.equal(original.join("\n").includes("\u001b"), false);
    assert.equal(original.join("\n").includes("\u0007"), false);
    assert.equal(call(), compact); renderResult();
    assert.equal(compact.render(120), original, "unchanged content retains the Box layout");
    context.expanded = true;
    const expanded = call(); renderResult();
    assert.match(expanded.render(120).join("\n"), /last-row/);
    context.expanded = false;
    assert.equal(call(), compact); renderResult();
    assert.equal(compact.render(120), original, "expansion does not discard the compact layout");
    result.content[0].text = "updated result";
    renderResult();
    assert.match(compact.render(120).join("\n"), /updated result/);
    const changedTheme = { ...theme, fg: (_color, text) => "new-theme " + text };
    tool.renderCall(context.args, changedTheme, context);
    tool.renderResult(result, { expanded: false }, changedTheme, context);
    assert.match(compact.render(120).join("\n"), /new-theme/);

    for (const width of [12, 40, 120]) assert.ok(compact.render(width).every(line => line.isWellFormed()));
    const brokenTheme = { ...theme, fg() { throw new Error("host renderer fallback"); } };
    assert.throws(() => tool.renderCall(context.args, brokenTheme, context), /host renderer fallback/);
    const fallback = tool.renderResult(result, { expanded: false }, theme, context);
    assert.match(fallback.render(120).join("\n"), /updated result/);
  }
});


test("TUI commands expose rejected host transitions instead of reporting success", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-tui-rejection-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify({ blockedTools: ["read"] }));
  t.diagnostic("Fixture retained at " + directory);
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { createDeferredController } = await import("../lib/engine.js");
    const { createDeferredCommand } = await import("../lib/commands.js");
    const { loadConfig } = await import("../lib/config.js");
    let config = loadConfig(file);

    const pi = { getAllTools: () => [{ name: "read" }, { name: "search_tools" }], getActiveTools: () => [],
      async setActiveTools() { throw new Error("host refused update"); } };

    const controller = createDeferredController(pi, config);
    const handler = createDeferredCommand(pi, controller, () => config, next => { config = next; });

    for (const command of ["apply", "reload", "status", "unblock read", "unblock read --persist"]) {
      const notices = [];
      await handler(command, { ui: { notify: (text, level) => notices.push({ text, level }) } });
      assert.equal(notices.at(-1).level, "error", command);
      assert.match(notices.at(-1).text, /host refused update/, command);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("intermediate agent_end preserves promotions until actual settlement", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-settlement-"));
  const file = path.join(directory, "config.json");
  t.diagnostic("Fixture retained at " + directory);
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");

    for (const lifetime of ["run", "session"]) for (const completion of ["settled", "idle-end", "legacy-end"]) {
      fs.writeFileSync(file, JSON.stringify({ promotionLifetime: lifetime }));
      const registered = new Map(), handlers = new Map();
      let active = ["alpha"], idle = completion === "idle-end", confirmations = 0;
      extension({ registerTool: tool => registered.set(tool.name, tool), registerCommand() {},
        on: (name, handler) => handlers.set(name, handler),
        getAllTools: () => [{ name: "alpha", parameters: {} }, ...registered.values()],
        getActiveTools: () => active, setActiveTools: names => { active = names; } });

      const ctx = { ui: { notify() {}, confirm: async () => {
        confirmations++;

        return false;
      } } };

      if (completion !== "legacy-end") ctx.isIdle = () => idle;
      await handlers.get("session_start")({}, ctx);
      await registered.get("promote_tools").execute("promote", { names: ["alpha"] });
      await handlers.get("agent_end")({}, ctx);

      if (completion === "settled") {
        assert.ok(active.includes("alpha"), "retry/continuation boundaries retain promoted tools");
        assert.equal(confirmations, 0, "do not interrupt an unfinished run with a keep-pin dialog");
        await handlers.get("before_agent_start")({ systemPrompt: "continuation" }, ctx);
        assert.ok(active.includes("alpha"));
        idle = true;
        await handlers.get("agent_settled")({}, ctx);
      }

      assert.equal(active.includes("alpha"), lifetime === "session");
      assert.equal(confirmations, lifetime === "session" ? 1 : 0);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});

test("DCE tool frames stay within one- and two-column viewport widths", async () => {
  const { deferredRenderer } = await import("../lib/render.js");
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
  const renderer = deferredRenderer("search_tools");
  const context = { state: {}, expanded: true };
  const frame = renderer.renderCall({ query: "😀中文 weather" }, theme, context);
  renderer.renderResult({ content: [{ type: "text", text: "😀 forecast" }] }, { expanded: true }, theme, context);

  for (const width of [1, 2, 3, 12]) {
    const lines = frame.render(width);
    assert.ok(lines.length > 0);
    assert.ok(lines.every(line => visibleWidth(line) <= width), "over-wide tool frames crash Pi's main-screen renderer at width " + width);
    assert.ok(lines.every(line => line.isWellFormed()));
  }
});

test("result-render failure clears old DCE output and permits recovery", async () => {
  const { deferredRenderer } = await import("../lib/render.js");
  const { renderCall, renderResult } = deferredRenderer("list_capabilities");
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };
  const context = { state: {}, args: {}, expanded: true };
  const result = { content: [{ type: "text", text: "old catalog" }] };
  const frame = renderCall({}, theme, context);
  renderResult(result, { expanded: true }, theme, context);
  const brokenTheme = { ...theme, fg() { throw new Error("render failure"); } };
  assert.throws(() => renderResult(result, { expanded: true }, brokenTheme, context));
  assert.doesNotMatch(frame.render(100).join("\n"), /old catalog/);
  renderResult(result, { expanded: true }, theme, context);
  assert.match(frame.render(100).join("\n"), /old catalog/);
});


test("keeping unrelated pins does not revoke a human session unblock", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-keep-unblock-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify({ promotionLifetime: "session", blockedTools: ["blocked"] }));
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const registered = new Map(), handlers = new Map(), commands = new Map();
    let active = ["blocked", "weather"];
    extension({ registerTool: tool => registered.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
      getAllTools: () => [{ name: "blocked", parameters: {} }, { name: "weather", parameters: {} }, ...registered.values()],
      getActiveTools: () => active, setActiveTools: async names => { active = [...names]; } });
    const ctx = { hasUI: true, ui: { notify() {}, confirm: async () => true } };
    const denied = () => handlers.get("tool_call")({ toolName: "blocked" });
    await handlers.get("session_start")({}, ctx);
    assert.equal(denied().block, true);
    await commands.get("deferred").handler("unblock blocked", ctx);
    assert.equal(denied(), undefined);
    await registered.get("demote_tools").execute("demote", { names: ["blocked"] });
    await registered.get("promote_tools").execute("promote", { names: ["weather"] });
    await handlers.get("agent_settled")({}, ctx);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.alwaysActive, ["weather"]);
    assert.deepEqual(saved.blockedTools, ["blocked"], "a session exemption must not silently become permanent");
    assert.equal(denied(), undefined, "saving an unrelated pin must retain the session exemption");
    await handlers.get("session_start")({}, ctx);
    assert.equal(denied().block, true, "a new session still clears temporary unblocks");
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});

test("keep-pin does not persist a session-unblocked name that remains config-blocked", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-keep-blocked-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify({ promotionLifetime: "session", blockedTools: ["blocked"] }));
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const registered = new Map(), handlers = new Map(), commands = new Map();
    let active = ["blocked"];
    extension({ registerTool: tool => registered.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
      getAllTools: () => [{ name: "blocked", parameters: {} }, ...registered.values()],
      getActiveTools: () => active, setActiveTools: async names => { active = [...names]; } });
    const prompts = [];
    const ctx = { hasUI: true, ui: { notify() {}, confirm: async (_title, message) => { prompts.push(message); return true; } } };
    await handlers.get("session_start")({}, ctx);
    await commands.get("deferred").handler("unblock blocked", ctx);
    assert.ok(active.includes("blocked"));
    await handlers.get("agent_settled")({}, ctx);
    assert.deepEqual(prompts, [], "session unblock is not a pin; alwaysActive cannot override blockedTools");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.alwaysActive, undefined);
    assert.deepEqual(saved.blockedTools, ["blocked"]);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("native prompt options defer resources without forcing a rendered prompt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-native-prompt-"));
  const file = path.join(directory, "config.json"), skillFile = path.join(directory, "SKILL.md");
  fs.writeFileSync(file, JSON.stringify({ alwaysActive: ["read"], activeSkills: ["keep"], toolPriority: ["read"] }));
  fs.writeFileSync(skillFile, "# Deployment workflow\n");
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  try {
    const { default: extension } = await import("../index.js");
    const registered = new Map(), handlers = new Map(), commands = new Map();
    let active = ["read", "weather"];
    extension({ registerTool: tool => registered.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => handlers.set(name, handler),
      getAllTools: () => [{ name: "read", parameters: {} }, { name: "weather", parameters: {} }, ...registered.values()],
      getActiveTools: () => active, setActiveTools: names => { active = [...names]; } });

    const original = { cwd: directory, selectedTools: ["read", "weather"],
      sections: { custom: "Operator-owned section", deferred_tools: "stale", dce_tool_priority: "stale" },
      contextFiles: [{ path: "/global/AGENTS.md", content: "Shared rule" }, { path: "/distinct/AGENTS.md", content: "Distinct rule" }, { path: "/local/AGENTS.md", content: "Shared rule" }],
      skills: [{ name: "keep", description: "Pinned skill", filePath: skillFile }, { name: "deploy", description: "Deploy releases", filePath: skillFile },
        { name: "hidden", description: "Hidden skill", filePath: skillFile, disableModelInvocation: true }] };

    const options = structuredClone(original);
    const event = { systemPrompt: "Pi owns rendering this prompt", systemPromptOptions: options };
    const result = await handlers.get("before_agent_start")(event, {});
    assert.equal(result?.systemPrompt, undefined, "native hooks must not force a flattened prompt");
    assert.equal(options.forceSystemPrompt, undefined);
    assert.deepEqual(options.contextFiles, original.contextFiles.slice(0, 2));
    assert.deepEqual(options.skills.map(skill => skill.name), ["keep"]);
    assert.deepEqual(options.selectedTools, original.selectedTools, "Pi must reconcile the active tool set after hooks");
    assert.equal(options.sections.custom, original.sections.custom);
    assert.match(options.sections.deferred_tools, /Some registered tools are deferred/);
    assert.match(options.sections.dce_tool_priority, /\["read"\]/);
    assert.doesNotMatch(options.sections.dce_tool_priority, /<dce_tool_priority>/, "Pi supplies section wrappers");
    const catalog = await registered.get("list_capabilities").execute("catalog", { kind: "skill" });
    assert.deepEqual(catalog.details.rows.map(row => row.name), ["deploy", "hidden", "keep"]);
    const found = await registered.get("search_tools").execute("skill", { query: "deploy", kind: "skill" });
    assert.equal(found.details.loadedSkill.name, "deploy");
    assert.match(found.content[0].text, /# Deployment workflow/);
    const notices = [];

    const ctx = { getSystemPrompt: () => event.systemPrompt, getSystemPromptOptions: () => original,
      ui: { notify: text => notices.push(text) } };

    await commands.get("deferred").handler("audit", ctx);
    assert.match(notices.at(-1), /context-files=3→2.*skills=2→1/);
    assert.doesNotMatch(notices.at(-1), /prompt=\d+→/, "native audit must not invent a future rendered character count");
    const opaque = { ...structuredClone(original), forceSystemPrompt: "Opaque instructions" };
    const fallback = await handlers.get("before_agent_start")({ systemPrompt: "Opaque instructions", systemPromptOptions: opaque }, {});
    assert.match(fallback.systemPrompt, /^Opaque instructions/);
    assert.deepEqual(opaque.contextFiles, original.contextFiles, "opaque prompts retain their legacy fallback");
    fs.writeFileSync(file, JSON.stringify({ deferByDefault: false, deferSkills: false, deduplicateContext: false, toolPriority: [] }));
    await commands.get("deferred").handler("reload", ctx);
    const unfiltered = structuredClone(original);
    await handlers.get("before_agent_start")({ systemPrompt: "Pi renders", systemPromptOptions: unfiltered }, {});
    assert.deepEqual(unfiltered.contextFiles, original.contextFiles);
    assert.deepEqual(unfiltered.skills.map(skill => skill.name), ["keep", "deploy"]);
    assert.equal(Object.hasOwn(unfiltered.sections, "deferred_tools"), false);
    assert.equal(Object.hasOwn(unfiltered.sections, "dce_tool_priority"), false);
    assert.equal(unfiltered.sections.custom, original.sections.custom);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  }
});


test("skill catalog visibility respects hidden pins and disabled deferral", async () => {
  const { registerDeferredTools } = await import("../lib/tools.js");
  const registered = new Map();

  const skills = [
    { name: "pinned", description: "Pinned workflow" },
    { name: "visible", description: "Unpinned workflow" },
    { name: "hidden", description: "Hidden workflow", hide: true },
    { name: "disabled", description: "Explicit invocation only", disableModelInvocation: true },
  ];

  let config = { enabled: true, deferSkills: true, activeSkills: ["pinned", "hidden", "disabled"] };
  registerDeferredTools({ registerTool: tool => registered.set(tool.name, tool) }, { catalog: () => [] }, () => config, () => skills);
  const list = params => registered.get("list_capabilities").execute("catalog", { kind: "skill", ...params });
  const initial = await list({});
  assert.deepEqual(Object.fromEntries(initial.details.rows.map(row => [row.name, row.state])), {
    disabled: "deferred", hidden: "deferred", pinned: "active", visible: "deferred",
  });

  for (const change of [{ deferSkills: false }, { enabled: false }]) {
    config = { enabled: true, deferSkills: true, activeSkills: [], ...change };
    const result = await list({ state: "active" });
    assert.deepEqual(result.details.rows.map(row => row.name), ["pinned", "visible"]);
  }
});


async function reviewRuntime(t, config, customTools = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-runtime-edges-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = file;

  t.after(() => {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
  });

  const definitions = new Map(customTools.map(tool => [tool.name, tool]));
  const registered = new Map(), handlers = new Map(), commands = new Map();
  let active = customTools.map(tool => tool.name);

  const pi = {
    getAllTools: () => [...definitions.values()], getActiveTools: () => [...active],
    setActiveTools: names => { active = [...new Set(names)]; },
    registerTool: tool => { definitions.set(tool.name, tool); registered.set(tool.name, tool); active = [...new Set([...active, tool.name])]; },
    registerCommand: (name, command) => commands.set(name, command), on: (name, handler) => handlers.set(name, handler),
  };

  const { default: extension } = await import("../index.js");
  const restart = async () => { extension(pi); await handlers.get("session_start")({}, {}); };

  await restart();

  return { file, directory, pi, registered, handlers, commands, restart };
}

test("session boundaries invalidate an open keep-promotion confirmation", async t => {
  for (const boundary of ["session_shutdown", "session_start"]) {
    await t.test(boundary, async child => {
      const schema = { type: "object", description: "Full schema documentation. ".repeat(20), examples: [{}] };
      const original = JSON.stringify(schema);

      const runtime = await reviewRuntime(child, {
        promotionLifetime: "session", compactSchemas: { enabled: true, maxParamDescriptionChars: 40 },
      }, [{ name: "read", parameters: schema }, { name: "weather", parameters: {} }]);

      const promote = () => runtime.registered.get("promote_tools").execute("p", { names: ["weather"] });
      await promote();
      let accept, opened;
      const confirmation = new Promise(resolve => { accept = resolve; });
      const dialogOpened = new Promise(resolve => { opened = resolve; });
      const notices = [];

      const settlement = runtime.handlers.get("agent_settled")({}, {
        hasUI: true, ui: { notify: message => notices.push(message), confirm: () => {
          opened();

          return confirmation;
        } },
      });

      await dialogOpened;
      await runtime.handlers.get(boundary)({}, {});

      if (boundary === "session_start") await promote();
      else assert.equal(JSON.stringify(schema), original, "shutdown restores owned schema edits");
      accept(true);
      await settlement;

      assert.deepEqual(JSON.parse(fs.readFileSync(runtime.file, "utf8")).alwaysActive || [], [],
        "a prior session's confirmation must not persist pins");
      assert.deepEqual(notices, [], "a retired confirmation must not announce a save");

      if (boundary === "session_shutdown") assert.equal(JSON.stringify(schema), original,
        "a retired confirmation must not recompact schemas after shutdown");
      else assert.ok(runtime.pi.getActiveTools().includes("weather"), "the new session promotion survives");
    });
  }
});

test("live config errors preserve the running deny-list during reload and keep-pinned saves", async t => {
  for (const mode of ["reload-dangling", "keep-invalid", "keep-invalid-after-save"]) {
    await t.test(mode, async child => {
      const config = { promotionLifetime: "session", blockedTools: ["dangerous"] };
      const runtime = await reviewRuntime(child, config, [{ name: "weather", parameters: {} }, { name: "dangerous", parameters: {} }]);
      const blocked = () => runtime.handlers.get("tool_call")({ toolName: "dangerous" });
      const notices = [], ui = { notify: (text, level) => notices.push({ text, level }) };
      assert.equal(blocked().block, true);

      if (mode === "reload-dangling") {
        const target = runtime.file + ".held";
        fs.renameSync(runtime.file, target);
        fs.symlinkSync("missing.json", runtime.file);
        await runtime.commands.get("deferred").handler("reload", { ui });
      } else {
        await runtime.registered.get("promote_tools").execute("p", { names: ["weather"] });
        const invalid = JSON.stringify({ ...config, blockedTools: 42 });

        if (mode === "keep-invalid-after-save") {
          const unlink = fs.unlinkSync;
          const lock = fs.realpathSync(runtime.file) + ".lock";

          // An editor changes the config after the save releases its lock, before live reload.
          child.mock.method(fs, "unlinkSync", file => {
            unlink(file);

            if (file === lock) fs.writeFileSync(runtime.file, invalid);
          });
        }

        ui.confirm = async () => {
          if (mode === "keep-invalid") fs.writeFileSync(runtime.file, invalid);

          return true;
        };

        await runtime.handlers.get("agent_settled")({}, { hasUI: true, ui });
        assert.equal(fs.readFileSync(runtime.file, "utf8"), invalid);
      }

      assert.equal(blocked()?.block, true, "invalid live configuration must not erase the existing deny-list");
      assert.equal(notices.at(-1).level, "error");
      fs.writeFileSync(runtime.file, JSON.stringify(config));
      await runtime.commands.get("deferred").handler("reload", { ui });
      assert.equal(blocked().block, true);
      assert.equal(notices.at(-1).level, "info");
    });
  }
});

test("shutdown restores owned schemas after pending transitions and preserves them across runtime reload", async t => {
  const schema = { examples: [{ path: "README.md" }], type: "object", properties: { path: { type: "string", description: "Full path documentation. ".repeat(20) } } };
  const original = JSON.stringify(schema);

  const runtime = await reviewRuntime(t, { compactSchemas: { enabled: true, maxParamDescriptionChars: 40 } }, [
    { name: "read", parameters: schema }, { name: "weather", parameters: {} },
  ]);

  assert.notEqual(JSON.stringify(schema), original);
  const setActive = runtime.pi.setActiveTools;
  let finish;
  const pendingHost = t.mock.method(runtime.pi, "setActiveTools", names => new Promise(resolve => { finish = () => { setActive(names); resolve(); }; }));
  const promotion = runtime.registered.get("promote_tools").execute("p", { names: ["weather"] });
  const shutdown = runtime.handlers.get("session_shutdown")?.({}, {});
  finish();
  await Promise.all([promotion, shutdown]);
  pendingHost.mock.restore();
  assert.equal(JSON.stringify(schema), original, "unloading DCE must not strand its schema edits");
  assert.deepEqual(runtime.pi.getActiveTools(), ["search_tools", "weather"], "cleanup must not activate tools");
  const unavailableRegistry = t.mock.method(runtime.pi, "getAllTools", () => { throw new Error("host registry already torn down"); });
  await runtime.handlers.get("session_shutdown")({}, {});
  unavailableRegistry.mock.restore();
  assert.equal(JSON.stringify(schema), original);
  await runtime.restart();
  assert.notEqual(JSON.stringify(schema), original);
  await runtime.registered.get("promote_tools").execute("p", { names: ["read"] });
  assert.equal(JSON.stringify(schema), original, "a reloaded runtime must retain the full schema baseline");
});

test("Unicode discovery promotes a matching tool and loads a matching skill", async t => {
  const runtime = await reviewRuntime(t, {}, [{ name: "translate_notes", description: "翻译项目文档", parameters: {} }]);
  const filePath = path.join(runtime.directory, "SKILL.md"), body = "# 翻译指南\n保留代码块。\n";
  fs.writeFileSync(filePath, body);
  await runtime.handlers.get("before_agent_start")({ systemPrompt: "base", systemPromptOptions: {
    sections: {}, skills: [{ name: "translation-workflow", description: "翻译项目文档", filePath }],
  } }, {});
  const search = runtime.registered.get("search_tools");
  const tool = await search.execute("tool", { query: "翻译", kind: "tool" });
  assert.deepEqual(tool.details.added, ["translate_notes"]);
  assert.ok(runtime.pi.getActiveTools().includes("translate_notes"));
  const skill = await search.execute("skill", { query: "翻译", kind: "skill" });
  assert.equal(skill.details.loadedSkill?.name, "translation-workflow");
  assert.ok(skill.content[0].text.endsWith(body));
});

test("persistent unblock retains a rejected prefix activation when an exact unblock succeeds", async t => {
  const runtime = await reviewRuntime(t, { blockedTools: ["alpha"], blockedPrefixes: ["beta"] },
    [{ name: "alpha", parameters: {} }, { name: "beta_tool", parameters: {} }]);

  const apply = runtime.pi.setActiveTools;
  runtime.pi.setActiveTools = async names => apply(names.filter(name => name !== "beta_tool"));
  const notices = [];
  await runtime.commands.get("deferred").handler("unblock alpha beta_tool --persist", {
    ui: { notify: (text, level) => notices.push({ text, level }) },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.file, "utf8")).blockedTools, []);
  assert.ok(runtime.pi.getActiveTools().includes("alpha"));
  assert.ok(!runtime.pi.getActiveTools().includes("beta_tool"));
  assert.equal(runtime.handlers.get("tool_call")({ toolName: "beta_tool" }), undefined,
    "policy exemption lands even though its separate host activation fails");
  assert.equal(notices.at(-1).level, "error", "a successful exact unblock must not hide the failed prefix activation");
  assert.match(notices.at(-1).text, /host update failed/);
});

test("request boundaries remove captured declarations that synchronization re-defers", async t => {
  const runtime = await reviewRuntime(t, { alwaysActive: ["read"] }, [
    { name: "read", parameters: {} }, { name: "weather", parameters: {} },
  ]);

  const tools = [{ name: "weather", parameters: {} }, { name: "read", parameters: {} }];

  const messages = [{ role: "system", content: "Base instructions", tools, toolsAdded: tools },
    { role: "user", content: "Check the weather" }];

  const original = structuredClone(messages);

  // Another extension captures declarations while temporarily reactivating weather.
  runtime.pi.setActiveTools(["search_tools", "read", "weather"]);
  const projected = (await runtime.handlers.get("context_with_system")({ messages }))?.messages ?? messages;
  assert.ok(!runtime.pi.getActiveTools().includes("weather"));
  assert.deepEqual(projected[0].tools.map(tool => tool.name), ["read"]);
  assert.deepEqual(projected[0].toolsAdded.map(tool => tool.name), ["read"]);
  assert.equal(projected[1], messages[1]);
  assert.deepEqual(messages, original);

  const payloads = [
    { instructions: "Base", tools },
    { messages: [{ role: "system", content: "Base" }], tools: tools.map(tool => ({ type: "function", function: tool })) },
    { system: [{ type: "text", text: "Base", cache_control: { type: "ephemeral" } }], tools },
    { config: { tools: [{ functionDeclarations: tools }, { googleSearch: {} }] } },
  ];

  for (const payload of payloads) {
    const snapshot = structuredClone(payload);
    const final = await runtime.handlers.get("before_provider_request")({ payload }) ?? payload;
    const declarations = (final.config?.tools ?? final.tools).flatMap(tool => tool.functionDeclarations ?? [tool]);
    assert.ok(!declarations.some(tool => (tool.name ?? tool.function?.name) === "weather"));
    assert.ok(declarations.some(tool => (tool.name ?? tool.function?.name) === "read"));
    assert.deepEqual(payload, snapshot);

    if (final.config) assert.deepEqual(final.config.tools[1], { googleSearch: {} });
  }

  await runtime.registered.get("promote_tools").execute("p", { names: ["weather"] });
  const promoted = await runtime.handlers.get("before_provider_request")({ payload: payloads[0] }) ?? payloads[0];
  assert.deepEqual(promoted.tools, tools, "explicit DCE promotion retains the declaration");
  await runtime.handlers.get("agent_settled")({}, {});
  const settled = await runtime.handlers.get("before_provider_request")({ payload: promoted }) ?? promoted;
  assert.deepEqual(settled.tools.map(tool => tool.name), ["read"], "expired promotions cannot survive in captured declarations");
});


test("disabled audit reports no prompt pruning for native and legacy prompts", async t => {
  const runtime = await reviewRuntime(t, { enabled: false, deferSkills: true, deduplicateContext: true });
  const contextFiles = [{ path: "/a/AGENTS.md", content: "same rules" }, { path: "/b/AGENTS.md", content: "same rules" }];
  const skills = [{ name: "visible", description: "Visible", filePath: "/skills/visible/SKILL.md" }];
  const prompt = contextFiles.map(contextBlock).join("") + formatSkillIndex(skills);
  const notices = [], ui = { notify: text => notices.push(text) };

  for (const native of [true, false]) {
    const options = { contextFiles, skills };

    if (native) options.sections = {};

    await runtime.commands.get("deferred").handler("audit", { ui, getSystemPrompt: () => prompt, getSystemPromptOptions: () => options });

    if (native) {
      assert.match(notices.at(-1), /context-files=2→2/);
      assert.match(notices.at(-1), /skills=1→1/);
    } else {
      assert.ok(notices.at(-1).includes("prompt=" + prompt.length + "→" + prompt.length + " chars"));
      assert.match(notices.at(-1), /duplicate-context=0/);
      assert.match(notices.at(-1), /deferred-skills=0/);
    }
  }
});
