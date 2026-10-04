/**
 * pi-model-sync models.dev enrichment.
 *
 * models.dev carries capabilities (context, costs, modalities, reasoning
 * options) that bare /v1/models lists lack. Live endpoint metadata always
 * wins when present; models.dev fills the rest. Unknown models pass through
 * with live data only, never fabricated defaults.
 */

import { defined, isNonEmptyString, isNumber, isObject, isString } from "./decode.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";

export const MODELS_DEV_TIMEOUT_MS = 30000;

// Pi provider id -> models.dev namespace. Deliberately small: identity and
// global exact-id fallback below cover the rest without guessing.
const PI_TO_MODELS_DEV = {
  anthropic: "anthropic",
  openai: "openai",
  xai: "xai",
  google: "google",
  "google-vertex": "google-vertex",
  deepseek: "deepseek",
  meta: "meta",
  mistral: "mistral",
  moonshotai: "moonshotai",
  minimax: "minimax",
  groq: "groq",
  cerebras: "cerebras",
  together: "togetherai",
  fireworks: "fireworks-ai",
  openrouter: "openrouter",
  zai: "zai",
  cohere: "cohere",
  perplexity: "perplexity",
  nvidia: "nvidia",
  baseten: "baseten",
  huggingface: "huggingface",
  ollama: "ollama-cloud",
};

export function modelsDevNamespace(piProviderId) {
  return PI_TO_MODELS_DEV[piProviderId] ?? piProviderId;
}

function namespaceModels(catalog, namespace) {
  if (!isObject(catalog)) {
    return undefined;
  }

  const provider = catalog[namespace];

  if (!isObject(provider)) {
    return undefined;
  }

  return isObject(provider.models) ? provider.models : undefined;
}

// Exact-id lookup: mapped namespace first, then a lazily built global
// index. Model ids are globally distinctive (vendor/model or bare names);
// a global exact hit beats guessing a namespace mapping. The index builds
// once per catalog object (WeakMap-held, so catalogs still GC) instead of
// scanning 223 namespaces per model. First-hit-wins in namespace order,
// exactly like the scan it replaces.
const globalIndexCache = new WeakMap();

function globalIndex(catalog) {
  const cached = globalIndexCache.get(catalog);

  if (cached !== undefined) {
    return cached;
  }

  const index = new Map();

  for (const namespace of Object.keys(catalog)) {
    const models = namespaceModels(catalog, namespace);

    if (models === undefined) {
      continue;
    }

    for (const id of Object.keys(models)) {
      if (!index.has(id)) {
        index.set(id, models[id]);
      }
    }
  }

  globalIndexCache.set(catalog, index);

  return index;
}

function findEntry(catalog, piProviderId, modelId) {
  const namespaced = namespaceModels(catalog, modelsDevNamespace(piProviderId));

  if (namespaced !== undefined && namespaced[modelId] !== undefined) {
    return namespaced[modelId];
  }

  if (!isObject(catalog)) {
    return undefined;
  }

  return globalIndex(catalog).get(modelId);
}

function finiteNumber(value) {
  if (isNumber(value)) {
    return value >= 0 ? value : undefined;
  }

  if (isString(value) && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  return undefined;
}

// Context windows must be positive: Pi rejects zero-window models at
// composition time, which would take down the whole provider. Costs may
// legitimately be 0 (free tiers), so they keep finiteNumber.
function positiveNumber(value) {
  const number = finiteNumber(value);

  return number !== undefined && number > 0 ? number : undefined;
}

function asRecord(value) {
  return isObject(value) ? value : undefined;
}

function textImageInput(modalities) {
  const input = asRecord(modalities)?.input;

  if (!Array.isArray(input)) {
    return undefined;
  }

  const kept = [...new Set(input.filter((modality) => modality === "text" || modality === "image"))];

  return kept.length > 0 ? kept : undefined;
}

// Effort value list from reasoning_options, or null when the source says
// nothing usable. "toggle" dialects and unknown shapes yield null.
function effortValues(reasoningOptions) {
  if (!Array.isArray(reasoningOptions)) {
    return null;
  }

  for (const option of reasoningOptions) {
    const entry = asRecord(option);

    if (entry?.type !== "effort" || !Array.isArray(entry.values)) {
      continue;
    }

    const values = [...new Set(entry.values.filter(isNonEmptyString))];

    if (values.length > 0) {
      return values;
    }
  }

  return null;
}

// Cost legs: each output leg reads every alias from live pricing first,
// then the models.dev entry. Unknown legs default to 0 once any leg is
// known (Pi's own zero-cost default shape); all-unknown yields undefined.
const COST_LEGS = [
  ["input", ["input"]],
  ["output", ["output"]],
  ["cacheRead", ["cache_read", "cacheRead"]],
  ["cacheWrite", ["cache_write", "cacheWrite"]],
];

// Gateway list prices are USD/token; Pi and models.dev use USD/million tokens.
// Normalize only this known wire schema, never scale models.dev fallbacks.
function gatewayCosts(pricing) {
  const cost = {};

  for (const [leg, field] of [
    ["input", "input"], ["output", "output"],
    ["cacheRead", "input_cache_read"], ["cacheWrite", "input_cache_write"],
  ]) {
    const value = finiteNumber(pricing[field]);

    if (value !== undefined) cost[leg] = value * 1_000_000;
  }

  return cost;
}

function costsOf(live, entry, piProviderId) {
  const pricing = asRecord(live?.pricing);

  const liveCost = piProviderId === "vercel-ai-gateway" && pricing !== undefined
    ? gatewayCosts(pricing) : asRecord(live?.pricing ?? asRecord(live?.cost));

  const sources = [liveCost, asRecord(entry?.cost)];

  let known = false;
  const cost = {};

  for (const [leg, aliases] of COST_LEGS) {
    const value = finiteNumber(firstPresent(sources, aliases));

    if (value !== undefined) {
      known = true;
    }

    cost[leg] = value ?? 0;
  }

  return known ? cost : undefined;
}

// First non-nullish value across sources and aliases, in order. Separates
// selection from finiteNumber validation exactly like the ?? chain did:
// an invalid first hit still blocks later aliases.
function firstPresent(sources, aliases) {
  for (const source of sources) {
    for (const alias of aliases) {
      const value = source?.[alias];

      if (value !== undefined && value !== null) {
        return value;
      }
    }
  }

  return undefined;
}

function displayNameOf(modelId) {
  const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;

  const titled = bare
    .split(/[-_]/)
    .map((word) => (word === "" ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ")
    .trim();

  // Pi schema rejects name:"" (minLength 1) and would fail the whole file.
  return titled !== "" ? titled : modelId;
}

// Output modalities when either source states them. Used to drop video,
// image, and embedding models Pi cannot drive; unknown stays syncable.
function outputModalities(live, entry) {
  for (const source of [live, entry]) {
    const output = asRecord(source?.modalities)?.output;

    if (Array.isArray(output) && output.length > 0) {
      return output;
    }
  }

  return undefined;
}

// Merge live endpoint metadata with the models.dev entry into Pi model
// fields. Every field is omitted when neither source knows it. Returns
// undefined for models whose output is known non-text (video, image,
// embeddings): selectable-but-broken entries help nobody.
function limitsOf(live, entry) {
  const entryLimit = asRecord(entry?.limit) ?? {};

  return {
    contextWindow: positiveNumber(live.context_window ?? live.contextWindow ?? live.inputTokenLimit ?? entryLimit.context),
    maxTokens: positiveNumber(live.max_tokens ?? live.maxTokens ?? live.outputTokenLimit ?? entryLimit.output),
  };
}

function reasoningOf(live, entry) {
  const liveEfforts = effortValues(live.reasoning_options);
  const liveTags = Array.isArray(live.tags) ? live.tags : [];

  return {
    reasoning: liveTags.includes("reasoning") || liveEfforts !== null || entry?.reasoning === true,
    explicitEfforts: liveEfforts ?? effortValues(entry?.reasoning_options),
  };
}

function trainingOf(live, entry) {
  const retained = live.no_training === "none" || live.zdr === "none" || entry?.no_training === "none";

  return retained ? true : undefined;
}

// Vendor display names win: Anthropic ships display_name, Google ships
// displayName while its name is a "models/..." resource path, never a
// label. Resource paths fall through to the title-cased model id.
function displayNameOfLive(live, entry, modelId) {
  const liveName = live.display_name ?? live.displayName ?? live.name ?? entry?.name;

  return isNonEmptyString(liveName) && !liveName.startsWith("models/") ? liveName : displayNameOf(modelId);
}

export function enrichModel(catalog, piProviderId, modelId, liveMeta) {
  const entry = findEntry(catalog, piProviderId, modelId);
  const live = asRecord(liveMeta) ?? {};
  const output = outputModalities(live, entry);
  // Google's list advertises API methods, not output modalities. Embedding
  // and predict-only models cannot serve Pi's generateContent chat requests.
  const methods = live.supportedGenerationMethods;

  if (Array.isArray(methods) && methods.length > 0 && !methods.includes("generateContent")) {
    return undefined;
  }

  if (output !== undefined && !output.includes("text")) {
    return undefined;
  }

  const limits = limitsOf(live, entry);
  const thinking = reasoningOf(live, entry);

  return defined({
    name: displayNameOfLive(live, entry, modelId),
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    cost: costsOf(live, entry, piProviderId),
    input: textImageInput(live.modalities) ?? textImageInput(entry?.modalities),
    reasoning: thinking.reasoning,
    explicitEfforts: thinking.explicitEfforts ?? undefined,
    trainingRetained: trainingOf(live, entry),
  });
}

// Fetch the whole catalog. One 5MB call per sync run; callers treat failure
// as enrichment-offline (live metadata only), never fatal.
export async function fetchModelsDevCatalog(fetchImpl, userAgent) {
  const response = await fetchImpl(MODELS_DEV_URL, {
    headers: { Accept: "application/json", "User-Agent": userAgent },
    signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`models.dev catalog failed (HTTP ${response.status})`);
  }

  const catalog = await response.json();

  if (!isObject(catalog)) {
    throw new Error("models.dev catalog returned an unexpected shape");
  }

  return catalog;
}
