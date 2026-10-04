/* oxlint-disable -- Licensed external-provider parsing, scalar validation retained. See LICENSE. */
// Shared scalar validation and credential-family recognition; no HTTP or routing.

export class UsageFetchError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "UsageFetchError";
    this.status = status;
  }
}

export function record(value) {
  return value && typeof value === "object" ? value : {};
}

export function finiteNumber(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function percent(value) {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.min(100, Math.max(0, number));
}

export function epochMs(value) {
  if (typeof value === "string" && value.trim() && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return undefined;
  return number < 10_000_000_000 ? number * 1000 : number;
}

export function usageWindow(value, fallbackWindowSeconds) {
  const source = record(value);
  const usedPercent = percent(source.used_percent ?? source.utilization);
  const resetAt = epochMs(source.reset_at ?? source.resets_at);
  if (usedPercent === undefined || resetAt === undefined) return undefined;
  const windowSeconds = finiteNumber(source.limit_window_seconds) ?? fallbackWindowSeconds;
  return {
    usedPercent,
    resetAt,
    ...(windowSeconds !== undefined ? {
      windowSeconds
    } : {})
  };
}

const USAGE_FAMILIES = [
  [/^openai-codex(?:-account-\d+)?$/, "codex"], [/^anthropic(?:-account-\d+)?$/, "anthropic"],
  [/^ollama(?:-account-\d+)?$/, "ollama"], [/^cursor(?:-account-\d+)?$/, "cursor"],
  [/^alibaba(?:-account-\d+)?$/, "qwen"], [/^qwen/i, "qwen"],
  [/^kimi-coding(?:-account-\d+)?$/, "kimi-coding"], [/^xai(?:-account-\d+)?$/, "xai"],
  [/^zai-coding-cn(?:-account-\d+)?$/, "zai-coding-cn"],
];

export function usageFamily(provider) { return USAGE_FAMILIES.find(([pattern]) => pattern.test(provider))?.[1]; }
