
import { isString, isObject } from "./decode.js";

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
