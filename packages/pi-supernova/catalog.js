
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
    name: "evidence", description: "Top-K source spans (with path and line provenance) that answer a concept question; read these instead of whole files.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Concept, symbol, or question" },
      path: { type: "string", description: "Optional search root" },
      k: { type: "number", description: "Main spans to return (default 5)" },
      maxChars: { type: "number", description: "Total text budget (default 6000)" },
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

function sourcePathOf(tool) {
  if (tool.sourceInfo && isString(tool.sourceInfo.path)) return tool.sourceInfo.path;
  if (isString(tool.extensionPath)) return tool.extensionPath;
  if (isString(tool.sourcePath)) return tool.sourcePath;
  return undefined;
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
    sourcePath: sourcePathOf(tool),
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
    scored.push({ name: row.name, description: row.description.slice(0, 160), score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, limit)).map(({ score: _s, ...hit }) => hit);
}

function fieldSummary(key, schema, required) {
  const s = schema && isObject(schema) ? schema : {};
  // Only signal-bearing keys: `required:false` and empty descriptions cost tokens and say nothing.
  return {
    type: s.type || (Array.isArray(s.anyOf) ? "union" : "unknown"),
    required: required.has(key) || undefined,
    description: isString(s.description) ? s.description.slice(0, 120) : undefined,
  };
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
    fields[key] = fieldSummary(key, schema, required);
  }
  return { type: "object", fields };
}

/** Optimal string alignment distance: insert/delete/substitute/adjacent-transpose cost 1. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2][j - 2] + 1);
      rows[i][j] = best;
    }
  }
  return rows[a.length][b.length];
}

/** Closest tool names for a mistyped name: substring hits first, then a length-scaled edit distance. */
export function suggestNames(name, candidates, limit = 3) {
  const needle = String(name || "").toLowerCase();
  if (!needle) return [];
  const maxDistance = Math.max(1, Math.floor(needle.length / 3));
  const scored = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower === needle) continue;
    const distance = lower.includes(needle) || needle.includes(lower) ? 1 : editDistance(needle, lower);
    if (distance <= maxDistance) scored.push({ candidate, distance });
  }
  scored.sort(
    (a, b) =>
      a.distance - b.distance ||
      Math.abs(a.candidate.length - needle.length) - Math.abs(b.candidate.length - needle.length) ||
      a.candidate.localeCompare(b.candidate),
  );
  return scored.slice(0, limit).map((s) => s.candidate);
}

export function unknownToolMessage(name, candidates) {
  const close = suggestNames(name, candidates);
  const hint = close.length ? ` Did you mean ${close.map((c) => JSON.stringify(c)).join(", ")}?` : "";
  return `unknown tool "${name}".${hint} Use nova.search("") to list every callable tool.`;
}

export function describeTool(catalog, name) {
  const row = catalog.find((t) => t.name === name);
  if (!row) {
    return { ok: false, error: unknownToolMessage(name, catalog.map((t) => t.name)) };
  }
  if (!row._described) {
    row._described = {
      ok: true,
      name: row.name,
      description: row.description,
      parameters: schemaSummary(row.parameters),
      sourcePath: row.sourcePath,
    };
  }
  return row._described;
}
