import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatCatalog, rankCapabilities } from "../lib/catalog.js";
import { registerDeferredTools } from "../lib/tools.js";
import { formatCompressedSkillIndex, formatSkillIndex, optimizeSystemPrompt, prioritizePayload, readSkill, schemaAudit } from "../lib/context.js";

function contextBlock(file) {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

test("removes duplicate context and the visible skill index exactly", () => {
  const contexts = [
    { path: "/global/AGENTS.md", content: "same rules" },
    { path: "/fixture-b/AGENTS.md", content: "same rules" },
    { path: "/project/AGENTS.md", content: "project rules" },
  ];

  const skills = [{
    name: "release-workflow",
    description: "Ship a release safely",
    filePath: "/skills/release/SKILL.md",
    disableModelInvocation: false,
  }];

  const prompt = "base\n" + contexts.map(contextBlock).join("") + formatSkillIndex(skills) + "\nend";

  const optimized = optimizeSystemPrompt(prompt, { contextFiles: contexts, skills }, {
    deduplicateContext: true,
    deferSkills: true,
  });

  assert.match(optimized.systemPrompt, /global\/AGENTS/);
  assert.doesNotMatch(optimized.systemPrompt, /fixture-b\/AGENTS/);
  assert.match(optimized.systemPrompt, /project rules/);
  assert.doesNotMatch(optimized.systemPrompt, /available_skills/);
  assert.equal(optimized.stats.duplicateFiles, 1);
  assert.equal(optimized.stats.deferredSkills, 1);
  assert.ok(optimized.stats.removedChars > 0);
});

test("strips the compressed skill index form", () => {
  const skills = [
    { name: "alpha", description: "A", filePath: "/root-a/alpha/SKILL.md" },
    { name: "beta", description: "B", filePath: "/root-a/beta/SKILL.md" },
    { name: "gamma", description: "G", filePath: "/root-b/gamma/SKILL.md" },
  ];

  const prompt = "base" + formatCompressedSkillIndex(skills) + "\nend";
  const optimized = optimizeSystemPrompt(prompt, { skills }, { deferSkills: true });
  assert.doesNotMatch(optimized.systemPrompt, /Skills under/);
  assert.doesNotMatch(optimized.systemPrompt, /specialized instructions/);
  assert.match(optimized.systemPrompt, /^base\nend$/);
  assert.equal(optimized.stats.deferredSkills, 3);
  assert.ok(optimized.stats.deferredSkillChars > 0);
});

test("deferSkills searchable catalog includes hide / disable-model-invocation skills", () => {
  const skills = [
    {
      name: "design",
      description: "High-taste frontend design",
      filePath: "/skills/design/SKILL.md",
      hide: true,
    },
    {
      name: "oxlint-anti-slop",
      description: "Wire anti-slop oxlint",
      filePath: "/skills/oxlint-anti-slop/SKILL.md",
      disableModelInvocation: true,
    },
    {
      name: "visible-skill",
      description: "Shown in prompt when not deferred",
      filePath: "/skills/visible/SKILL.md",
    },
  ];

  const prompt = "base" + formatSkillIndex(skills.filter((s) => !s.hide && !s.disableModelInvocation)) + "\nend";
  const optimized = optimizeSystemPrompt(prompt, { skills }, { deferSkills: true });
  assert.equal(optimized.skills.length, 3);
  assert.deepEqual(
    optimized.skills.map((s) => s.name).sort(),
    ["design", "oxlint-anti-slop", "visible-skill"],
  );
  assert.ok(rankCapabilities("frontend design", [], optimized.skills, 1).some((m) => m.name === "design"));
  assert.ok(rankCapabilities("anti-slop oxlint", [], optimized.skills, 1).some((m) => m.name === "oxlint-anti-slop"));
});

test("keeps activeSkills pinned in the prompt while deferring the rest", () => {
  const skills = [
    { name: "ask-user", description: "Ask questions", filePath: "/pkg/ask-user/SKILL.md" },
    { name: "video-export", description: "Video", filePath: "/fixture/skills/video-export/SKILL.md" },
    { name: "design-sync", description: "Design", filePath: "/fixture/skills/design-sync/SKILL.md" },
  ];

  for (const index of [formatSkillIndex(skills), formatCompressedSkillIndex(skills)]) {
    const prompt = "base" + index + "\nend";
    const optimized = optimizeSystemPrompt(prompt, { skills }, { deferSkills: true, activeSkills: ["ask-user"] });
    assert.match(optimized.systemPrompt, /ask-user/);
    assert.doesNotMatch(optimized.systemPrompt, /video-export/);
    assert.doesNotMatch(optimized.systemPrompt, /design-sync/);
    assert.match(optimized.systemPrompt, /<available_skills>/); // pinned subset re-inserted verbose
    assert.equal(optimized.stats.deferredSkills, 2);
  }
});

test("ranks tool and skill capabilities deterministically", () => {
  const tools = [
    { name: "web_search", description: "Search the live web for current information" },
    { name: "read", description: "Read local files" },
  ];

  const skills = [{ name: "release-workflow", description: "Publish and verify a software release" }];
  assert.deepEqual(
    rankCapabilities("search current web", tools, skills, 1).map((match) => match.name),
    ["web_search"],
  );
  assert.deepEqual(
    rankCapabilities("release workflow", tools, skills, 1).map((match) => match.name),
    ["release-workflow"],
  );
});

test("loads bounded trusted skill files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-skill-"));
  const filePath = path.join(directory, "SKILL.md");
  fs.writeFileSync(filePath, "# Safe workflow\n", "utf8");
  const skill = { name: "safe-workflow", filePath };
  assert.equal(readSkill(skill, 1024), "# Safe workflow\n");
  assert.throws(() => readSkill(skill, 2), /maxSkillBytes/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("reports active versus deferred schema bytes without prompt content", () => {
  const tools = [
    { name: "search_tools", description: "Search", parameters: { type: "object" } },
    { name: "large_tool", description: "x".repeat(500), parameters: { type: "object" } },
  ];

  const audit = schemaAudit(tools, ["search_tools"]);
  assert.equal(audit.allTools, 2);
  assert.equal(audit.activeTools, 1);
  assert.equal(audit.deferredTools, 1);
  assert.ok(audit.deferredBytes > audit.activeBytes);
});


test("skill reads reject growth after the initial size check", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-skill-growth-"));
  const filePath = path.join(directory, "SKILL.md");
  fs.writeFileSync(filePath, "abc", "utf8");
  t.diagnostic("Fixture retained at " + directory);
  const statSync = fs.statSync, fstatSync = fs.fstatSync;
  let grown = false;

  const growAfterStat = stat => (...args) => {
    const snapshot = stat(...args);

    if (!grown) {
      grown = true;
      fs.appendFileSync(filePath, "x".repeat(32));
    }

    return snapshot;
  };

  try {
    fs.statSync = growAfterStat(statSync);
    fs.fstatSync = growAfterStat(fstatSync);
    assert.throws(() => readSkill({ name: "growing-skill", filePath }, 16), /maxSkillBytes/);
  } finally {
    fs.statSync = statSync;
    fs.fstatSync = fstatSync;
  }

  assert.equal(fs.statSync(filePath).size, 35);
});


test("Gemini declaration projections filter blocks without changing native tools or source payloads", () => {
  const builtIn = { googleSearch: {} };
  const allowed = { name: "allowed", parametersJsonSchema: { type: "object" } };
  const forbidden = { name: "forbidden" };
  const blocked = name => name === "forbidden";

  for (const priority of [[], ["allowed"]]) {
    for (const nested of [false, true]) {
      const container = { tools: [builtIn, { functionDeclarations: [forbidden] },
        { functionDeclarations: [forbidden], codeExecution: {} }, { functionDeclarations: [allowed] }],
      systemInstruction: "Keep this instruction", temperature: 0.2 };

      const payload = nested ? { model: "gemini-2.5-pro", contents: [], config: container } : container;
      const before = structuredClone(payload);
      const final = prioritizePayload(payload, priority, blocked);
      const tools = (nested ? final.config : final).tools;
      assert.deepEqual(tools, [builtIn, { codeExecution: {} }, { functionDeclarations: [allowed] }]);
      assert.equal(tools[0], builtIn);
      assert.equal(tools[2], container.tools[3]);
      assert.deepEqual(payload, before);
      assert.equal(prioritizePayload(final, priority, blocked), final);
    }
  }
});


test("tool and skill catalog previews do not introduce lone surrogates", async () => {
  const description = limit => "x".repeat(limit - 1) + "😀 trailing description";
  const tools = [{ name: "unicode", description: description(120) }];
  const catalog = formatCatalog(tools, new Set(), new Set());
  assert.equal(catalog[0].description, "x".repeat(119));
  const match = rankCapabilities("unicode", [{ name: "unicode", description: description(160) }], [], 1);
  assert.equal(match[0].description, "x".repeat(159));
  const registered = new Map();
  registerDeferredTools({ registerTool: tool => registered.set(tool.name, tool) }, { catalog: () => [] }, () => ({}), () => tools);
  const skills = await registered.get("list_capabilities").execute("unicode", { kind: "skill" });
  assert.equal(skills.details.rows[0].description, "x".repeat(119));
  assert.ok(skills.content[0].text.isWellFormed());
});

test("list_capabilities does not crash on null params or a non-string filter", async () => {
  const registered = new Map();
  registerDeferredTools(
    { registerTool: tool => registered.set(tool.name, tool) },
    { catalog: () => [{ kind: "tool", name: "read", state: "active", description: "Read files" }] },
    () => ({ enabled: true }),
    () => [{ name: "release-workflow", description: "Ship a release" }],
  );
  const list = registered.get("list_capabilities");
  const empty = await list.execute("null-params", null);
  assert.notEqual(empty.isError, true);
  assert.equal(empty.details.count, 2);
  const filtered = await list.execute("numeric-filter", { filter: 1 });
  assert.equal(filtered.isError, true);
  assert.match(filtered.details.error, /filter/);
});


test("native priority sections preserve transcript patches without duplicating text", async () => {
  const { prioritizeContext, toolPriorityText } = await import("../lib/context.js");
  const text = toolPriorityText(["read"]);

  const messages = [{ role: "system", content: "", sections: { dce_tool_priority: "stale", retired: null, custom: "Keep this instruction" },
    cache_control: { type: "ephemeral" }, tools: [{ name: "blocked" }, { name: "read" }] }];

  const original = structuredClone(messages);
  const projected = prioritizeContext(messages, ["read"], name => name === "blocked");
  assert.equal(projected[0].content, "", "section-based prompts must not also gain duplicate content guidance");
  assert.equal(Object.values(projected[0].sections).at(-1), text);
  assert.doesNotMatch(projected[0].sections.dce_tool_priority, /<dce_tool_priority>/, "Pi supplies section wrappers");
  assert.equal(projected[0].sections.retired, null, "section deletion patches remain deletion patches");
  assert.equal(projected[0].sections.custom, "Keep this instruction");
  assert.deepEqual(projected[0].tools, [{ name: "read" }]);
  assert.deepEqual(projected[0].cache_control, original[0].cache_control);
  assert.deepEqual(messages, original);
  assert.equal(prioritizeContext(projected, ["read"], name => name === "blocked"), projected);
});


test("native priority sections drop stale guidance when toolPriority is cleared", async () => {
  const { prioritizeContext } = await import("../lib/context.js");
  const messages = [{ role: "system", content: "", sections: { dce_tool_priority: "stale", retired: null, custom: "Keep this instruction" } }];
  const original = structuredClone(messages);
  const projected = prioritizeContext(messages, [], () => false);
  assert.equal(Object.hasOwn(projected[0].sections, "dce_tool_priority"), false);
  assert.equal(projected[0].sections.retired, null, "section deletion patches remain deletion patches");
  assert.equal(projected[0].sections.custom, "Keep this instruction");
  assert.equal(projected[0].content, "");
  assert.deepEqual(messages, original);
  assert.equal(prioritizeContext(projected, [], () => false), projected);
  const deletion = [{ role: "system", content: "", sections: { dce_tool_priority: null, custom: "Keep this instruction" } }];
  assert.equal(prioritizeContext(deletion, [], () => false), deletion);
});


test("legacy priority guidance replaces a previous order and strips when cleared", () => {
  const first = prioritizePayload({ instructions: "Keep this instruction" }, ["read"]);
  const second = prioritizePayload(first, ["bash"]);
  assert.equal([...second.instructions.matchAll(/<dce_tool_priority>/g)].length, 1);
  assert.match(second.instructions, /\["bash"\]/);
  assert.doesNotMatch(second.instructions, /\["read"\]/);
  const cleared = prioritizePayload(second, []);
  assert.equal(cleared.instructions, "Keep this instruction");
  assert.equal(prioritizePayload(cleared, []), cleared);
});


test("multi-block system instructions remove stale priority from every text block", () => {
  const old = prioritizePayload({ instructions: "Base instruction" }, ["read"]).instructions;

  const blocks = [
    { type: "text", text: old, cache_control: { type: "ephemeral" } },
    { type: "text", text: "Later package instruction" },
  ];

  const payloads = [
    { system: blocks },
    { systemInstruction: { parts: blocks } },
    { config: { systemInstruction: { parts: blocks } } },
    { messages: [{ role: "system", content: blocks }, { role: "user", content: "User request" }] },
  ];

  const contentOf = payload => payload.system ?? payload.systemInstruction?.parts ??
    payload.config?.systemInstruction.parts ?? payload.messages[0].content;

  for (const payload of payloads) {
    const original = structuredClone(payload);

    for (const priority of [[], ["bash"]]) {
      const projected = prioritizePayload(payload, priority);
      const content = contentOf(projected);
      assert.equal(content[0].text, "Base instruction", "old DCE guidance must not survive in an earlier block");
      assert.deepEqual(content[0].cache_control, blocks[0].cache_control);
      assert.equal(content.length, blocks.length);
      const text = content.map(block => block.text).join("\n");
      assert.doesNotMatch(text, /\["read"\]/);
      assert.equal([...text.matchAll(/<dce_tool_priority>/g)].length, priority.length ? 1 : 0);
      assert.ok(content[1].text.startsWith("Later package instruction"));

      if (priority.length) assert.match(content[1].text, /\["bash"\]/);
      assert.equal(prioritizePayload(projected, priority), projected);
      assert.deepEqual(payload, original, "stored instruction blocks remain untouched");
    }
  }
});


test("priority changes remove stale guidance from earlier system and developer messages", async () => {
  const { prioritizeContext, toolPriorityGuidance } = await import("../lib/context.js");
  const old = "Base instruction\n\n" + toolPriorityGuidance(["read"]);
  const user = { role: "user", content: old };
  const assistant = { role: "assistant", content: old };

  for (const priority of [[], ["bash"]]) {
    for (const key of ["messages", "input"]) {
      const messages = [{ role: "system", content: old }, user,
        { role: "developer", content: old }, assistant,
        { role: "developer", content: "Later instruction" }];

      const original = structuredClone(messages);
      const projected = prioritizePayload({ [key]: messages }, priority)[key];

      assert.equal(projected[0].content, "Base instruction");
      assert.equal(projected[2].content, "Base instruction");
      assert.equal(projected[1], user, "user content is not DCE-owned guidance");
      assert.equal(projected[3], assistant, "assistant content is not DCE-owned guidance");
      assert.equal(projected[4].content, "Later instruction" +
        (priority.length ? "\n\n" + toolPriorityGuidance(priority) : ""));
      assert.deepEqual(messages, original);
      assert.equal(prioritizePayload({ [key]: projected }, priority)[key], projected);
    }

    for (const native of [false, true]) {
      const messages = [native
        ? { role: "system", content: "", sections: { dce_tool_priority: "old policy", custom: "Keep this instruction", retired: null } }
        : { role: "system", content: old }, user,
      { role: "system", content: "Later instruction" }];

      const original = structuredClone(messages);
      const projected = prioritizeContext(messages, priority);

      if (native) assert.deepEqual(projected[0].sections, { custom: "Keep this instruction", retired: null });
      else assert.equal(projected[0].content, "Base instruction");
      assert.equal(projected[1], user);
      assert.equal(projected[2].content, "Later instruction" +
        (priority.length ? "\n\n" + toolPriorityGuidance(priority) : ""));
      assert.deepEqual(messages, original);
      assert.equal(prioritizeContext(projected, priority), projected);
    }
  }
});

test("legacy audit counts visible and hidden deferred skills without counting a visible pin", () => {
  const skills = [
    { name: "pinned", description: "Pinned", filePath: "/skills/pinned/SKILL.md" },
    { name: "visible", description: "Visible", filePath: "/skills/visible/SKILL.md" },
    { name: "hidden", description: "Hidden", filePath: "/skills/hidden/SKILL.md", hide: true },
    { name: "manual", description: "Manual", filePath: "/skills/manual/SKILL.md", disableModelInvocation: true },
  ];

  const prompt = "base" + formatSkillIndex(skills);
  const config = { deferSkills: true, activeSkills: ["pinned", "hidden"] };
  const optimized = optimizeSystemPrompt(prompt, { skills }, config);
  assert.equal(optimized.stats.deferredSkills, 3);
  assert.deepEqual(optimized.skills, skills);
  assert.match(optimized.systemPrompt, /<name>pinned<\/name>/);
  assert.doesNotMatch(optimized.systemPrompt, /<name>(visible|hidden|manual)<\/name>/);
  const disabled = optimizeSystemPrompt(prompt, { skills }, { ...config, deferSkills: false });
  assert.equal(disabled.stats.deferredSkills, 0);
  assert.equal(disabled.systemPrompt, prompt);
});
