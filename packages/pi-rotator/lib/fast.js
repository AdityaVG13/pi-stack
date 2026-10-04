import { parseSlotId } from "./slots.js";

export const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

// Verified request capabilities, not a cloned provider/model catalog. Do not
// infer paid tiers merely from an OpenAI/Anthropic-compatible API shape.
const CLAUDE_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

const CODEX_FAST_MODEL = /^gpt-(?:5\.[456](?:$|[-.])|6(?:\.\d+)?-(?:astra|sol|luna)(?:$|[-.]))/;

const UNAVAILABLE = "No verified fast tier for this provider/model; request unchanged";

// Pi owns service-tier transport and pricing. This is only the opt-in shortcut;
// eligibility remains server-owned and never inferred for unrelated providers.
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
    : { kind: "cursor", detail: "Cursor requires a registered -fast counterpart; no generic tier flag" }],
  ["kimi-coding", (_model, id) => id.endsWith("-highspeed")
    ? { kind: "native", detail: "Kimi HighSpeed model selected; off does not replace this distinct model" }
    : { kind: "unavailable", detail: "Kimi HighSpeed is a different model; select it explicitly with /model" }],
]);

export function fastCapability(model) {
  const base = parseSlotId(model?.provider)?.base;
  const id = String(model?.id || "");
  const capability = CAPABILITIES.get(base);

  return capability ? capability(model, id) : { kind: "unavailable", detail: UNAVAILABLE };
}

function priorityPayload(payload) {
  return ["priority", "fast"].includes(payload.service_tier) ? payload : { ...payload, service_tier: "priority" };
}

function speedPayload(payload) {
  if (payload.betas !== undefined && !Array.isArray(payload.betas)) return payload;
  const betas = payload.betas || [];

  if (payload.speed === "fast" && betas.includes(ANTHROPIC_FAST_BETA)) return payload;

  return { ...payload, speed: "fast", betas: [...new Set([...betas, ANTHROPIC_FAST_BETA])] };
}

export function fastPayload(model, payload, enabled) {
  if (!enabled || !payload || payload.constructor !== Object) return payload;
  const capability = fastCapability(model);

  if (capability.kind === "priority") return priorityPayload(payload);

  if (capability.kind === "speed") return speedPayload(payload);

  return payload;
}

function speedRequested(payload) {
  return payload?.speed === "fast" && payload.betas?.includes(ANTHROPIC_FAST_BETA) === true;
}

export function fastRequested(model, payload) {
  const { kind } = fastCapability(model);

  if (kind === "native") return true;

  // The delivered payload can request a tier through upstream defaults even
  // when Rotator's shaping preference is off. Observe that request as-is.
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
