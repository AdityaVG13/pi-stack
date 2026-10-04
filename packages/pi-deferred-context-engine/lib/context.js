import fs from "node:fs";
import path from "node:path";
import { isObject, isString } from "./decode.js";

const SKILL_PREFIX = [
  "\n\nThe following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when the task matches its description.",
  "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
  "",
  "<available_skills>",
];

/** Prompt-visible skills only (Agent Skills hide / disable-model-invocation). */
function isPromptHiddenSkill(skill) {
  return skill?.disableModelInvocation === true || skill?.hide === true;
}

function visibleSkills(skills = []) {
  return skills.filter((skill) => !isPromptHiddenSkill(skill));
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

// Single pass: each source char maps once, inserted entities are never
// rescanned -- byte-identical to the chained five-replace version.
function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
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

function wrappedNames(names) {
  const lines = [];
  let buffer = "  ";

  for (const name of names) {
    const piece = (buffer === "  " ? "" : ", ") + name;

    if (buffer.length > 2 && buffer.length + piece.length > 80) {
      lines.push(buffer + ",");
      buffer = "  " + name;
    } else buffer += piece;
  }

  if (buffer.length > 2) lines.push(buffer);

  return lines;
}

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
    lines.push(...wrappedNames(names));
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

export { toolPriorityGuidance, toolPriorityText, prioritizePayload, prioritizeContext } from "./routing.js";

function deduplicatePrompt(prompt, files) {
  const seen = new Set();
  let duplicateFiles = 0;
  let duplicateContextChars = 0;

  for (const file of files) {
    if (!seen.has(file.content)) { seen.add(file.content); continue; }

    const next = removeOnce(prompt, contextBlock(file));

    if (next !== prompt) {
      duplicateFiles++;
      duplicateContextChars += prompt.length - next.length;
      prompt = next;
    }
  }

  return { prompt, duplicateFiles, duplicateContextChars };
}

function findSkillIndex(prompt, skills) {
  for (const format of [formatSkillIndex, formatCompressedSkillIndex]) {
    const text = format(skills);
    const at = text ? prompt.indexOf(text) : -1;

    if (at >= 0) return { text, at };
  }

  return null;
}

function deferPromptSkills(prompt, skills, config) {
  if (config.deferSkills === false || skills.length === 0) return { prompt, count: 0, chars: 0 };
  const pins = new Set(config.activeSkills || []);
  const pinned = skills.filter(skill => pins.has(skill.name));
  const index = findSkillIndex(prompt, skills);
  const count = skills.length - pinned.length;

  if (!index) return { prompt, count, chars: 0 };
  const replacement = pinned.length > 0 ? formatSkillIndex(pinned) : "";

  return { prompt: prompt.slice(0, index.at) + replacement + prompt.slice(index.at + index.text.length),
    count, chars: index.text.length - replacement.length };
}

// Only event-owned options can be edited; forced prompts remain opaque.
export function isNativePromptOptions(options) {
  return isObject(options?.sections) && options.forceSystemPrompt === undefined;
}

export function projectPromptResources(options, config) {
  const files = options.contextFiles || [], allSkills = options.skills || [];
  const seen = new Set(), pins = new Set(config.activeSkills || []);
  const visible = visibleSkills(allSkills);

  const contextFiles = config.deduplicateContext === false ? files : files.filter(file => {
    if (seen.has(file.content)) return false;
    seen.add(file.content);

    return true;
  });

  return { contextFiles, skills: config.deferSkills === false ? visible : allSkills,
    promptSkills: config.deferSkills === false ? visible : visible.filter(skill => pins.has(skill.name)),
    visibleSkillCount: visible.length };
}

export function optimizeSystemPrompt(systemPrompt, options = {}, config = {}) {
  const prompt = String(systemPrompt || "");
  const beforeChars = prompt.length;
  const duplicates = deduplicatePrompt(prompt, config.deduplicateContext === false ? [] : options.contextFiles || []);
  const allSkills = options.skills || [];
  const promptSkills = visibleSkills(allSkills);
  const deferred = deferPromptSkills(duplicates.prompt, promptSkills, config);

  // Hidden skills remain searchable, but never acquire prompt visibility.
  return {
    systemPrompt: deferred.prompt,
    skills: config.deferSkills === false ? promptSkills : allSkills,
    stats: { beforeChars, afterChars: deferred.prompt.length, removedChars: beforeChars - deferred.prompt.length,
      duplicateFiles: duplicates.duplicateFiles, duplicateContextChars: duplicates.duplicateContextChars,
      deferredSkills: config.deferSkills === false ? 0 : deferred.count + allSkills.filter(isPromptHiddenSkill).length,
      deferredSkillChars: deferred.chars },
  };
}

export function readSkill(skill, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("readSkill requires positive maxBytes from config.maxSkillBytes (config.default.json sole source)");
  }

  const file = fs.openSync(skill.filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  const overflow = size => new Error(`Skill exceeds maxSkillBytes (${size} > ${maxBytes}): ${skill.name}`);

  try {
    const stat = fs.fstatSync(file);

    if (!stat.isFile()) throw new Error(`Skill is not a file: ${skill.filePath}`);

    if (stat.size > maxBytes) throw overflow(stat.size);
    // Own one handle and bound the read even if the trusted file grows after stat.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;

    while (size < buffer.length) {
      const count = fs.readSync(file, buffer, size, buffer.length - size, null);

      if (!count) break;
      size += count;
    }

    if (size > maxBytes) throw overflow(size);

    return buffer.toString("utf8", 0, size);
  } finally { fs.closeSync(file); }
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

/** Pi uses strings; OMP may supply multiple blocks. Never comma-join those blocks. */
export function normalizeSystemPromptText(prompt) {
  return Array.isArray(prompt) ? prompt.filter(isString).join("\n") : String(prompt || "");
}

/** Retain OMP block boundaries when optimization only appends fixed guidance. */
export function projectSystemPrompt(original, before, optimized, blurb) {
  const after = blurb ? optimized + "\n\n" + blurb : optimized;

  if (after === before) return {};
  const wasArray = Array.isArray(original);

  if (wasArray && optimized === before && blurb) return { systemPrompt: [...original, blurb] };

  return { systemPrompt: wasArray ? [after] : after };
}
