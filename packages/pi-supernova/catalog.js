
import { isString, isObject } from "./decode.js";

export const NATIVE_TOOL_DEFINITIONS = [
  {
    name: "read",
    description: "Read UTF-8 workspace files by path, or resolve a concept query to source. Supports path arrays, offset, and limit.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative file path or concept query" },
      target: { anyOf: [{ type: "string" }, { type: "array" }], description: "File path/query or array of paths" },
      offset: { type: "number", description: "One-based starting line" },
      limit: { type: "number", description: "Maximum lines to return" },
    } },
  },
  {
    name: "write", description: "Write UTF-8 content to a workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "edit", description: "Apply unique text replacements, or a unified diff, to a workspace file.",
    parameters: { type: "object", properties: {
      path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, edits: { type: "array" }, patch: { type: "string" },
    }, required: ["path"] },
  },
  {
    name: "apply_patch", description: "Apply a unified diff to one workspace file.",
    parameters: { type: "object", properties: { path: { type: "string" }, patch: { type: "string" } }, required: ["patch"] },
  },
  {
    name: "snap", description: "Resolve a concept query to the most relevant workspace source location.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Source concept to resolve" },
      path: { type: "string", description: "Optional workspace search root; explicitly targeting a hidden directory includes its hidden files, but Git metadata is always excluded" },
    }, required: ["query"] },
  },
  {
    name: "surface", description: "Extract a structural outline from a workspace source file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "bash", description: "Run a shell command inside the workspace and capture bounded output.",
    parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
  },
  {
    name: "grep", description: "Search workspace file contents by pattern.",
    parameters: { type: "object", properties: {
      pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, caseSensitive: { type: "boolean" },
    }, required: ["pattern"] },
  },
  {
    name: "glob", description: "List workspace files matching a glob pattern.",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "find", description: "List workspace files, optionally constrained by path and pattern.",
    parameters: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, glob: { type: "string" } } },
  },
  {
    name: "ls", description: "List direct entries in a workspace directory.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

export function mergeNativeToolDefinitions(tools, capturedNames = []) {
  const nativeByName = new Map(NATIVE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  const captured = new Set(capturedNames);
  const seen = new Set();
  const merged = [];

  for (const tool of tools || []) {
    const fallback = nativeByName.get(tool?.name);
    merged.push(fallback && !captured.has(tool.name)
      ? { ...tool, ...fallback, sourceInfo: { path: "<native:" + tool.name + ">" } }
      : tool);
    if (tool?.name) seen.add(tool.name);
  }
  for (const fallback of NATIVE_TOOL_DEFINITIONS) {
    if (!seen.has(fallback.name)) {
      merged.push({ ...fallback, sourceInfo: { path: "<native:" + fallback.name + ">" } });
    }
  }
  return merged;
}

function normalizeTool(tool) {
  if (!tool || !isObject(tool)) return null;
  const name = isString(tool.name) ? tool.name : "";
  if (!name) return null;
  const description = isString(tool.description) ? tool.description : "";
  return {
    name,
    nameLower: name.toLowerCase(),
    description,
    descLower: description.toLowerCase(),
    parameters: tool.parameters,
    sourcePath:
      tool.sourceInfo && isString(tool.sourceInfo.path)
        ? tool.sourceInfo.path
        : isString(tool.extensionPath)
          ? tool.extensionPath
          : isString(tool.sourcePath)
            ? tool.sourcePath
            : undefined,
  };
}

export function buildCatalog(tools, excludeNames = []) {
  const exclude = new Set(excludeNames);
  const rows = [];
  for (const tool of tools || []) {
    const row = normalizeTool(tool);
    if (!row || exclude.has(row.name)) continue;
    rows.push(row);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function tokenize(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length > 1);
}

function scoreRow(row, tokens) {
  if (tokens.length === 0) return 1;
  const name = row.nameLower || row.name.toLowerCase();
  const desc = row.descLower || row.description.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 10;
    else if (name.includes(token)) score += 5;
    else if (desc.includes(token)) score += 2;
  }
  return score;
}

export function searchCatalog(catalog, query, limit = 12) {
  const tokens = tokenize(query);
  const scored = [];
  for (const row of catalog) {
    const score = scoreRow(row, tokens);
    if (score <= 0 && tokens.length > 0) continue;
    scored.push({
      name: row.name,
      description: row.description.slice(0, 160),
      score,
      callable: true,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, limit)).map(({ score: _s, ...hit }) => hit);
}

function schemaSummary(parameters) {
  if (!parameters || !isObject(parameters)) return { type: "unknown" };
  const props = parameters.properties;
  if (!props || !isObject(props)) {
    return {
      type: parameters.type || "object",
      note: "schema present (no enumerable properties)",
    };
  }
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
  const fields = {};
  for (const [key, schema] of Object.entries(props)) {
    const s = schema && isObject(schema) ? schema : {};
    fields[key] = {
      type: s.type || (Array.isArray(s.anyOf) ? "union" : "unknown"),
      required: required.has(key),
      description: isString(s.description) ? s.description.slice(0, 120) : undefined,
    };
  }
  return { type: "object", fields };
}

export function describeTool(catalog, name) {
  const row = catalog.find((t) => t.name === name);
  if (!row) {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  if (!row._described) {
    row._described = {
      ok: true,
      name: row.name,
      description: row.description,
      parameters: schemaSummary(row.parameters),
      sourcePath: row.sourcePath,
      signature: `await nova.call(${JSON.stringify(row.name)}, args)`,
    };
  }
  return row._described;
}
