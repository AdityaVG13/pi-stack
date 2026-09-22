// Effective warmth TTL: the model's own cache lifetime when Pi knows it,
// else the family override, else the global default.
//
// Mirrors core's getPromptCacheTtlMs: promptCache tiers are seconds keyed by
// retention ("short" default, "long" via PI_CACHE_RETENTION=long). Verified
// live: anthropic models carry { short: 300, long: 3600 }; codex models carry
// nothing (unknown), so Codex falls back to configured TTL.
export function effectiveTtlMs(model, familyTtlMs, retention) {
  const tier = retention === "long" ? "long" : "short";
  const seconds = model && model.promptCache ? model.promptCache[tier] : undefined;

  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);

  return familyTtlMs;
}
