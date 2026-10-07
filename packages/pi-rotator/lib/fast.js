import { parseSlotId } from "./slots.js";

// Observed fast-tier markers, used only to classify failures and scope
// cooldowns. Rotator never requests a tier itself: OpenAI priority comes
// from Pi-native samplingParams, Cursor fast and Kimi HighSpeed are
// distinct models the user selects, and anything else is upstream shaping
// the router merely observes. Capability marks marker eligibility only;
// tier use always requires the marker itself (or an explicit fast model).
export const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

const CLAUDE_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

const CODEX_FAST_MODEL = /^gpt-(?:5\.[456](?:$|[-.])|6(?:\.\d+)?-(?:astra|sol|luna)(?:$|[-.]))/;

const UNAVAILABLE = "No recognized fast-tier markers for this provider/model";

function priorityCapability(model, id) {
  const codex = parseSlotId(model.provider)?.base === "openai-codex";

  const supported = codex ? model.api === "openai-codex-responses" && CODEX_FAST_MODEL.test(id)
    : ["openai-responses", "openai-completions"].includes(model.api) && !id.startsWith("ft:");

  return supported ? { kind: "priority", detail: "Pi-native OpenAI priority tier; eligibility and increased API/ChatGPT charges are provider-controlled" }
    : { kind: "unavailable", detail: UNAVAILABLE };
}

function claudeCapability(model, id) {
  if (model.api === "anthropic-messages" && CLAUDE_FAST_MODELS.has(id.replace(/-\d{8}$/, ""))) {
    return { kind: "speed", detail: "Claude fast preview; access required, separate fast/standard caches" };
  }

  return { kind: "unavailable", detail: UNAVAILABLE };
}

const CAPABILITIES = new Map([
  ["openai", priorityCapability],
  ["openai-codex", priorityCapability],
  ["anthropic", claudeCapability],
  ["cursor", (_model, id) => id.endsWith("-fast")
    ? { kind: "native", detail: "Cursor fast model selected; availability depends on this account's catalog/plan" }
    : { kind: "cursor", detail: "Cursor fast models are selected explicitly; no generic tier flag" }],
  ["kimi-coding", (_model, id) => id.endsWith("-highspeed")
    ? { kind: "native", detail: "Kimi HighSpeed model selected; availability depends on this account's catalog/plan" }
    : { kind: "unavailable", detail: "Kimi HighSpeed is a different model; select it explicitly with /model" }],
]);

export function fastCapability(model) {
  const base = parseSlotId(model?.provider)?.base;
  const id = String(model?.id || "");
  const capability = CAPABILITIES.get(base);

  return capability ? capability(model, id) : { kind: "unavailable", detail: UNAVAILABLE };
}

function speedRequested(payload) {
  return payload?.speed === "fast" && payload.betas?.includes(ANTHROPIC_FAST_BETA) === true;
}

// Whether the delivered payload is already a fast-tier request: an
// explicitly selected fast model, or tier fields Pi or upstream shaping
// put there. Never true from Rotator preference alone.
export function fastRequested(model, payload) {
  const { kind } = fastCapability(model);

  if (kind === "native") return true;

  return (kind === "priority" && ["priority", "fast"].includes(payload?.service_tier)) ||
    (kind === "speed" && speedRequested(payload));
}

// Tier/model-scoped entries share expiry/pruning machinery with ordinary
// cooldowns, but must never exclude an account when returning to standard.
export function fastCooldownKey(provider, modelId) {
  return JSON.stringify(["fast", provider, modelId]);
}

export function fastTierError(message) {
  return /fast|service_tier|priority|\bspeed\b/i.test(message) &&
    /rate|limit|capacity|overload|unavailable|unsupported|denied|not.{0,40}(?:enabled|allowed|supported|available|eligible|authorized|permitted)/i.test(message);
}
