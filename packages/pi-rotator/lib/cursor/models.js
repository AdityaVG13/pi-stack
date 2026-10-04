/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed catalog retained; see PROVENANCE.json. */
// Stable fallback catalog, effort grouping and display/pricing metadata.
import { cursorModelDisplayName } from "../cursor-model-name.js";
import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };

const MODEL_COST_TABLE = {
  "claude-4-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.5-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-4.5-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.6-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.6-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "composer-1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "composer-1.5": { input: 3.5, output: 17.5, cacheRead: 0.35, cacheWrite: 0 },
  "composer-2": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "grok-4.20": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
};

const FAST_OPUS_COST = { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 };

const MODEL_COST_PATTERNS = [
  [/claude.*opus/i, MODEL_COST_TABLE["claude-4.6-opus"]],
  [/claude.*haiku/i, MODEL_COST_TABLE["claude-4.5-haiku"]],
  [/claude.*sonnet/i, MODEL_COST_TABLE["claude-4.6-sonnet"]],
  [/composer/i, MODEL_COST_TABLE["composer-1"]],
  [/gpt-5\.4.*mini/i, MODEL_COST_TABLE["gpt-5.4-mini"]],
  [/gpt-5\.4/i, MODEL_COST_TABLE["gpt-5.4"]],
  [/gpt-5\.3/i, MODEL_COST_TABLE["gpt-5.3-codex"]],
  [/gpt-5\.2/i, MODEL_COST_TABLE["gpt-5.2"]],
  [/gpt-5.*mini/i, MODEL_COST_TABLE["gpt-5-mini"]],
  [/gpt-5/i, MODEL_COST_TABLE["gpt-5"]],
  [/gemini.*3\.1/i, MODEL_COST_TABLE["gemini-3.1-pro"]],
  [/gemini.*flash/i, MODEL_COST_TABLE["gemini-2.5-flash"]],
  [/gemini/i, MODEL_COST_TABLE["gemini-3-pro"]],
  [/grok/i, MODEL_COST_TABLE["grok-4.20"]],
  [/kimi/i, MODEL_COST_TABLE["kimi-k2.5"]],
];

const DEFAULT_COST = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 0
};

function estimateModelCost(modelId) {
  if (/claude.*opus.*fast/i.test(modelId)) return FAST_OPUS_COST;
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;
  const stripped = normalized.replace(/-(high|medium|low|preview|thinking|spark-preview|fast)$/g, "");
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return MODEL_COST_PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1] ?? DEFAULT_COST;
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "none"]);

export function parseModelId(id) {
  let remaining = id;
  let fast = false;
  let thinking = false;
  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -5);
  }
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
  }
  const lastDash = remaining.lastIndexOf("-");
  if (lastDash >= 0) {
    const suffix = remaining.slice(lastDash + 1);
    if (EFFORT_LEVELS.has(suffix)) {
      return {
        base: remaining.slice(0, lastDash),
        effort: suffix,
        fast,
        thinking
      };
    }
  }
  return {
    base: remaining,
    effort: "",
    fast,
    thinking
  };
}

export function supportsReasoningModelId(id) {
  const {
    base,
    effort,
    thinking
  } = parseModelId(id);
  if (effort || thinking) return true;
  if (base === "default") return true;
  // Cursor namespaces some families with a "cursor-" prefix (cursor-grok-4.6-high, …).
  // Matching the raw base against the family list misclassified every such model as
  // non-reasoning — and Pi clamps thinking to "off" for non-reasoning models, which also
  // meant no effort ever reached the proxy.
  const family = base.replace(/^cursor-/i, "");
  return /^(claude|composer|gemini|gpt|grok|kimi)(-|$)/i.test(family);
}

const EFFORT_ORDER = ["none", "low", "", "medium", "high", "xhigh", "max"];

export function buildEffortMap(efforts) {
  const sorted = EFFORT_ORDER.filter(e => efforts.has(e));
  if (sorted.length === 0) return {};
  const lowest = sorted[0];
  const pick = (...targets) => {
    for (const t of targets) if (efforts.has(t)) return t;
    return lowest;
  };
  return {
    minimal: pick("none", "low", ""),
    low: pick("low", "none", ""),
    medium: pick("medium", "", "low"),
    high: pick("high", "medium", ""),
    xhigh: pick("max", "xhigh", "high")
  };
}

function groupModels(raw) {
  const groups = new Map();
  for (const model of raw) {
    const parsed = parseModelId(model.id);
    const key = `${parsed.base}|${parsed.fast}|${parsed.thinking}`;
    if (!groups.has(key)) groups.set(key, { ...parsed, efforts: new Map() });
    groups.get(key).efforts.set(parsed.effort, model);
  }
  return groups.values();
}

function collapseModelGroup(group) {
  if (group.efforts.size === 1 && group.efforts.has("")) return [...group.efforts.values()].map(model => ({ ...model, supportsEffort: false }));
  const representative = group.efforts.get("medium") ?? group.efforts.get("") ?? [...group.efforts.values()][0];
  const named = group.efforts.get("") ?? group.efforts.get("high") ?? representative;
  const id = group.base + (group.thinking ? "-thinking" : "") + (group.fast ? "-fast" : "");
  return [{ ...representative, id, name: cursorModelDisplayName(named.name), supportsEffort: true, effortMap: buildEffortMap(new Set(group.efforts.keys())) }];
}

export function processModels(raw) {
  return [...groupModels(raw)].flatMap(collapseModelGroup).sort((a, b) => a.id.localeCompare(b.id));
}

export function modelConfig(m) {
  const thinkingLevelMap = m.supportsEffort && m.effortMap ? {
    off: null,
    ...m.effortMap
  } : undefined;
  return {
    id: m.id,
    name: cursorModelDisplayName(m.name),
    reasoning: supportsReasoningModelId(m.id),
    input: ["text"],
    cost: estimateModelCost(m.id),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(thinkingLevelMap ? {
      thinkingLevelMap
    } : {}),
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: m.supportsEffort,
      ...(m.supportsEffort && m.effortMap && {
        reasoningEffortMap: m.effortMap
      }),
      maxTokensField: "max_tokens"
    }
  };
}

export const FALLBACK_MODELS = rawFallbackModels.map(model => ({
  ...model,
  reasoning: supportsReasoningModelId(model.id)
}));
