import { isString } from "./decode.js";

const STOP_TERMS = new Set([
  "a", "an", "and", "for", "from", "in", "of", "on", "or", "the", "to", "with",
  "capability", "task", "tool", "tools", "use", "using",
]);

function terms(value) {
  return String(value)
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}_]+/u)
    .filter((term) => term && !STOP_TERMS.has(term));
}

/** Catalog character caps must not turn valid tool/skill prose into lone surrogates. */
export function descriptionPreview(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (text.length <= limit) return text;
  const end = text.codePointAt(limit - 1) > 0xffff ? limit - 1 : limit;

  return text.slice(0, end);
}

function catalogState(tool, name, deferred, active, blocked) {
  if (tool.exposure === "hidden") return "hidden";

  if (active.has(name)) return "active";

  if (blocked.has(name)) return "blocked";

  return deferred.has(name) ? "deferred" : "registered";
}

function callable(tool, name, active, blocked) {
  return !blocked.has(name) && (tool.exposure === "codemode" || tool.exposure === "deferred" ||
    (tool.exposure === "direct" && active.has(name)));
}

/** Shared row filter for tool and skill catalogs. */
export function filterRows(rows, { filter, state, kind } = {}) {
  let filtered = rows;

  if (filter) {
    const needle = filter.toLowerCase();
    filtered = filtered.filter((row) =>
      String(row.name ?? "").toLowerCase().includes(needle) || String(row.description ?? "").toLowerCase().includes(needle),
    );
  }

  if (state && state !== "all") filtered = filtered.filter((row) => row.state === state);

  if (kind && kind !== "all") filtered = filtered.filter((row) => row.kind === kind);

  return filtered;
}

export function formatCatalog(tools, deferred, active, blocked = new Set()) {
  return tools
    .map((tool) => {
      const name = tool.name ?? "";
      const state = catalogState(tool, name, deferred, active, blocked);

      const row = {
        kind: "tool",
        name,
        state,
        description: descriptionPreview(tool.description, 120),
      };

      if (tool.exposure) {
        row.exposure = tool.exposure;
        // Reachability under host exposure and DCE policy, not a permission grant.
        row.callable = callable(tool, name, active, blocked);
      }

      return row;
    })
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function optionalText(value) {
  return String(value || "").toLowerCase();
}

function scoreNameTerm(name, nameTerms, term) {
  if (nameTerms.has(term)) return 10;

  return name.includes(term) ? 6 : 0;
}

function scoreTextTerm(label, description, prompt, term) {
  let score = 0;

  if (label.includes(term)) score += 3;

  if (description.includes(term)) score += 2;

  if (prompt.includes(term)) score += 1;

  return score;
}

/**
 * Parse query once for ranking (O(Q) outside the O(T) tool loop).
 * Sole prep path for scoreToolPrepared (private) / rankCapabilities.
 */
function prepareQuery(query) {
  const rawQuery = String(query).toLowerCase().trim();
  const queryTerms = terms(rawQuery.replace(/[_-]+/g, " "));

  return {
    rawQuery,
    queryTerms,
    normalizedQuery: queryTerms.join(" "),
  };
}

/** Per-tool text prep, reused while the tool definition is unchanged. */
const preparedTools = new WeakMap();

function prepareTool(tool) {
  const cached = typeof tool === "object" && tool !== null ? preparedTools.get(tool) : undefined;

  if (cached && cached.name === tool.name && cached.label === tool.label && cached.description === tool.description &&
    cached.promptSnippet === tool.promptSnippet && cached.promptGuidelines === tool.promptGuidelines) return cached;
  const name = optionalText(tool.name);
  const normalizedName = name.replace(/[_-]+/g, " ");
  const prepared = {
    name,
    normalizedName,
    nameTerms: new Set(terms(normalizedName)),
    label: optionalText(tool.label),
    description: optionalText(tool.description),
    prompt: [tool.promptSnippet, ...(tool.promptGuidelines || [])].filter(Boolean).join(" ").toLowerCase(),
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
  };

  if (typeof tool === "object" && tool !== null) preparedTools.set(tool, prepared);

  return prepared;
}

function scoreToolPrepared(prepared, tool) {
  const { rawQuery, queryTerms, normalizedQuery } = prepared;

  if (queryTerms.length === 0) return 0;
  const { name, normalizedName, nameTerms, label, description, prompt } = prepareTool(tool);

  let score = name === rawQuery ? 64 : normalizedName === normalizedQuery ? 32 : 0;

  for (const term of queryTerms) {
    score += scoreNameTerm(name, nameTerms, term);
    score += scoreTextTerm(label, description, prompt, term);
  }

  if (queryTerms.length > 1 && description.includes(normalizedQuery)) score += 6;

  return score;
}

function requirePositiveLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("rankCapabilities requires positive integer limit (from config.maxSearchResults / parseSearchToolsParams)");
  }

  return limit;
}

function compareMatches(left, right) {
  return right.score - left.score || left.kind.localeCompare(right.kind) || left.item.name.localeCompare(right.item.name);
}

/** Bounded top-k: no full sort, no intermediate match array. */
function insertBounded(top, match, limit) {
  if (top.length === limit && compareMatches(match, top[limit - 1]) > 0) return;
  let at = top.length;

  while (at > 0 && compareMatches(match, top[at - 1]) < 0) at--;
  top.splice(at, 0, match);

  if (top.length > limit) top.pop();
}

export function rankCapabilities(query, tools, skills, limit) {
  limit = requirePositiveLimit(limit);
  const prepared = prepareQuery(query);
  const top = [];

  for (const [kind, items] of [["tool", tools], ["skill", skills]]) {
    for (const item of items) {
      if (!isString(item.name) || item.name.length === 0) continue;
      const score = scoreToolPrepared(prepared, item);

      if (score > 0) insertBounded(top, { kind, item, score }, limit);
    }
  }

  return top.map((match) => ({
    kind: match.kind,
    name: match.item.name,
    description: descriptionPreview(match.item.description, 160),
    score: match.score,
    item: match.item,
  }));
}
