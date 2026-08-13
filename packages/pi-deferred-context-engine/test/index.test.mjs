import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatSkillIndex } from "../context.js";

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
    let active = ["read"];
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
