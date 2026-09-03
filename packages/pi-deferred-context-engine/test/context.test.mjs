import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rankCapabilities } from "../catalog.js";
import { formatCompressedSkillIndex, formatSkillIndex, optimizeSystemPrompt, readSkill, schemaAudit } from "../context.js";

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
