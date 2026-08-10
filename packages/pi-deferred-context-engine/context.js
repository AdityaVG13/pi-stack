import fs from "node:fs";
import path from "node:path";
import { isPerfEnabled, span } from "./perf.js";

const SKILL_PREFIX = [
  "\n\nThe following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when the task matches its description.",
  "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
  "",
  "<available_skills>",
];

function visibleSkills(skills = []) {
  return skills.filter((skill) => !skill.disableModelInvocation);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatSkillIndex(skills = []) {
  const visible = visibleSkills(skills);
  if (visible.length === 0) return "";
  const lines = [...SKILL_PREFIX];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

// Some installs rewrite the verbose <available_skills> block into a compact
// "Skills under <root>/<name>/SKILL.md:" form before this engine runs.
// Strip must match BOTH the stock Pi form and the compressed form.
const COMPRESSED_SKILL_HEADER =
  "The following skills provide specialized instructions for specific tasks. When a skill name matches the task you are doing, read the SKILL.md at the listed location to load the full instructions. When a SKILL.md references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.";

export function formatCompressedSkillIndex(skills = []) {
  const visible = visibleSkills(skills);
  if (visible.length === 0) return "";
  const groups = new Map();
  for (const skill of visible) {
    const skillDir = path.dirname(skill.filePath);
    const root = path.dirname(skillDir);
    const list = groups.get(root) ?? [];
    list.push(skill.name);
    groups.set(root, list);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = ["", "", COMPRESSED_SKILL_HEADER];
  for (const [root, names] of sortedGroups) {
    names.sort();
    lines.push("");
    lines.push(`Skills under ${root}/<name>/SKILL.md:`);
    let buf = "  ";
    for (const name of names) {
      const piece = (buf === "  " ? "" : ", ") + name;
      if (buf.length > 2 && buf.length + piece.length > 80) {
        lines.push(`${buf},`);
        buf = `  ${name}`;
      } else {
        buf += piece;
      }
    }
    if (buf.length > 2) lines.push(buf);
  }
  return lines.join("\n");
}

function contextBlock(file) {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

function removeOnce(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return text;
  return text.slice(0, index) + text.slice(index + needle.length);
}

function optimizeSystemPromptImpl(systemPrompt, options = {}, config = {}) {
  let prompt = String(systemPrompt || "");
  const beforeChars = prompt.length;
  let duplicateFiles = 0;
  let duplicateContextChars = 0;

  if (config.deduplicateContext !== false) {
    const seen = new Set();
    for (const file of options.contextFiles || []) {
      if (!seen.has(file.content)) {
        seen.add(file.content);
        continue;
      }
      const block = contextBlock(file);
      const next = removeOnce(prompt, block);
      if (next !== prompt) {
        duplicateFiles += 1;
        duplicateContextChars += prompt.length - next.length;
        prompt = next;
      }
    }
  }

  let deferredSkillChars = 0;
  let deferredSkillCount = 0;
  const skills = visibleSkills(options.skills || []);
  if (config.deferSkills !== false && skills.length > 0) {
    // Skills named in activeSkills stay in the prompt; the rest are deferred
    // to search_tools. The pinned subset is re-inserted (verbose form) at the
    // exact position the full index occupied.
    const pinnedNames = new Set(config.activeSkills || []);
    const pinned = skills.filter((skill) => pinnedNames.has(skill.name));
    deferredSkillCount = skills.length - pinned.length;
    const pinnedIndex = pinned.length > 0 ? formatSkillIndex(pinned) : "";
    // Verbose first (Pi stock), then compressed form if present.
    for (const candidate of [formatSkillIndex(skills), formatCompressedSkillIndex(skills)]) {
      if (!candidate) continue;
      const index = prompt.indexOf(candidate);
      if (index < 0) continue;
      deferredSkillChars = candidate.length - pinnedIndex.length;
      prompt = prompt.slice(0, index) + pinnedIndex + prompt.slice(index + candidate.length);
      break;
    }
  }

  return {
    systemPrompt: prompt,
    skills,
    stats: {
      beforeChars,
      afterChars: prompt.length,
      removedChars: beforeChars - prompt.length,
      duplicateFiles,
      duplicateContextChars,
      deferredSkills: config.deferSkills === false ? 0 : deferredSkillCount,
      deferredSkillChars,
    },
  };
}

/** Optional profiling wrap for optimizeSystemPrompt (PI_DEFERRED_PERF). */
export function optimizeSystemPrompt(systemPrompt, options = {}, config = {}) {
  if (!isPerfEnabled()) return optimizeSystemPromptImpl(systemPrompt, options, config);
  return span("pi-deferred-context-engine.optimizeSystemPrompt", () =>
    optimizeSystemPromptImpl(systemPrompt, options, config),
    { beforeChars: String(systemPrompt || "").length },
  );
}

export function readSkill(skill, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("readSkill requires positive maxBytes from config.maxSkillBytes (config.default.json sole source)");
  }
  const stat = fs.statSync(skill.filePath);
  if (!stat.isFile()) throw new Error(`Skill is not a file: ${skill.filePath}`);
  if (stat.size > maxBytes) {
    throw new Error(`Skill exceeds maxSkillBytes (${stat.size} > ${maxBytes}): ${skill.name}`);
  }
  return fs.readFileSync(skill.filePath, "utf8");
}

function estimateToolBytes(tool) {
  return Buffer.byteLength(JSON.stringify({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.parameters || {},
  }));
}

export function schemaAudit(tools, activeNames) {
  const active = new Set(activeNames);
  let allBytes = 0;
  let activeBytes = 0;
  for (const tool of tools) {
    const bytes = estimateToolBytes(tool);
    allBytes += bytes;
    if (active.has(tool.name)) activeBytes += bytes;
  }
  return {
    allTools: tools.length,
    activeTools: active.size,
    deferredTools: Math.max(0, tools.length - active.size),
    allBytes,
    activeBytes,
    deferredBytes: Math.max(0, allBytes - activeBytes),
  };
}
