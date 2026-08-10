import { isPerfEnabled, span } from "./perf.js";

const STOP_TERMS = new Set([
  "a", "an", "and", "for", "from", "in", "of", "on", "or", "the", "to", "with",
  "capability", "task", "tool", "tools", "use", "using",
]);

function terms(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term && !STOP_TERMS.has(term));
}

export function formatCatalog(tools, deferred, active) {
  return tools
    .map((tool) => ({
      kind: "tool",
      name: tool.name ?? "",
      state: active.has(tool.name) ? "active" : deferred.has(tool.name) ? "deferred" : "registered",
      description: (tool.description || "").replace(/\s+/g, " ").trim().slice(0, 120),
    }))
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

/** Score one tool/skill against a prepared query (sole scorer; used by rankCapabilities). */
function scoreToolPrepared(prepared, tool) {
  const { rawQuery, queryTerms, normalizedQuery } = prepared;
  if (queryTerms.length === 0) return 0;
  const name = optionalText(tool.name);
  const normalizedName = name.replace(/[_-]+/g, " ");
  const nameTerms = new Set(terms(normalizedName));
  const label = optionalText(tool.label);
  const description = optionalText(tool.description);
  const prompt = [tool.promptSnippet, ...(tool.promptGuidelines || [])].filter(Boolean).join(" ").toLowerCase();

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

function rankCapabilitiesImpl(query, tools, skills, limit) {
  limit = requirePositiveLimit(limit);
  // Lever D: hoist query lower/split/join once -- was re-done per tool/skill (O(T×Q)).
  const prepared = prepareQuery(query);
  return [
    ...tools.map((tool) => ({ kind: "tool", item: tool, score: scoreToolPrepared(prepared, tool) })),
    ...skills.map((skill) => ({ kind: "skill", item: skill, score: scoreToolPrepared(prepared, skill) })),
  ]
    .filter((match) => match.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.kind.localeCompare(right.kind) ||
      left.item.name.localeCompare(right.item.name),
    )
    .slice(0, limit)
    .map((match) => ({
      kind: match.kind,
      name: match.item.name,
      description: String(match.item.description || "").replace(/\s+/g, " ").trim().slice(0, 160),
      score: match.score,
      item: match.item,
    }));
}

/** Optional profiling wrap for rankCapabilities (PI_DEFERRED_PERF).
 * limit is required (no dual default 3 — packageDefaults/maxSearchResults is sole source).
 */
export function rankCapabilities(query, tools, skills, limit) {
  limit = requirePositiveLimit(limit);
  if (!isPerfEnabled()) return rankCapabilitiesImpl(query, tools, skills, limit);
  return span("pi-deferred-context-engine.rankCapabilities", () =>
    rankCapabilitiesImpl(query, tools, skills, limit),
    { limit, tools: tools?.length, skills: skills?.length },
  );
}
