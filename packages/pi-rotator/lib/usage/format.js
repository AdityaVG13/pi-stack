/* oxlint-disable -- Licensed user-facing formatting semantics retained. See LICENSE. */
// Presentation only. Quota verdicts and windows are never renewed by formatting.

const USAGE_LABELS = [
  [/^openai-codex/, "Codex"], [/^anthropic/, "Claude"], [/^ollama/, "Ollama"],
  [/^cursor/, "Cursor"], [/^kimi-coding/, "Kimi"], [/^xai/, "xAI"], [/^zai-coding-cn/, "GLM CN"],
  [/^alibaba/, "Qwen", "Qwen/Alibaba"], [/^qwen/i, "Qwen", "Qwen/Alibaba"],
];

export function providerUsageLabel(provider) {
  const index = provider.match(/-account-(\d+)$/)?.[1];
  const label = USAGE_LABELS.find(([pattern]) => pattern.test(provider));
  if (!label) return provider;
  return index ? `${label[1]} A${index}` : label[2] ?? label[1];
}

export function remainingPercent(window) {
  return Math.max(0, Math.round(100 - window.usedPercent));
}

export function formatResetDuration(resetAt, now = Date.now()) {
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

export function shortAccount(account) {
  if (!account) return undefined;
  const local = account.includes("@") ? account.slice(0, account.indexOf("@")) : account;
  return local.length > 18 ? `${local.slice(0, 17)}…` : local;
}

const PRODUCT_WINDOW_LABELS = {
  cursor: new Map([["primary", "models"], ["secondary", "other"]]),
  ollama: new Map([["primary", "session"]]),
};

const DURATION_LABELS = [[20 * 86400, "30d"], [6 * 86400, "7d"], [20 * 3600, "24h"]];

export function windowLabel(window, family, position) {
  if (family === "cursor") return PRODUCT_WINDOW_LABELS.cursor.get(position) || "grok bot";
  if (family === "ollama") return PRODUCT_WINDOW_LABELS.ollama.get(position) || "weekly";
  const seconds = window.windowSeconds;
  if (!seconds) return new Map([["primary", "5h"], ["secondary", "7d"]]).get(position) || "usage";
  return DURATION_LABELS.find(([minimum]) => seconds >= minimum)?.[1] || `${Math.max(1, Math.round(seconds / 3600))}h`;
}

export function mergeUsageSnapshot(previous, next) {
  if (!previous || previous.provider !== next.provider || !next.credentialHash || previous.credentialHash !== next.credentialHash) return next;
  return {
    ...next,
    account: next.account ?? previous.account,
    plan: next.plan ?? previous.plan
  };
}

const WINDOW_POSITIONS = ["primary", "secondary", "tertiary"];

function quotaWindows(snapshot) { return WINDOW_POSITIONS.map(key => [key, snapshot[key]]).filter(([, window]) => window); }

function planStatus(snapshot, details) {
  if (snapshot.family !== "ollama") return details ? `Status: ${snapshot.plan}` : snapshot.plan;
  return details ? `Plan: ${snapshot.plan}. Session/weekly quota is currently unavailable — check https://ollama.com/settings` : `${snapshot.plan} · quota unavailable`;
}

export function formatUsageCompact(snapshot, now = Date.now()) {
  const label = providerUsageLabel(snapshot.provider);
  const who = shortAccount(snapshot.account);
  const windows = quotaWindows(snapshot);
  const parts = [who ? `${label} · ${who}` : label];
  if (snapshot.plan && windows.length) parts.push(snapshot.plan);
  if (snapshot.serviceable === true) parts.push("ok");
  if (snapshot.serviceable === false) parts.push("spent");
  for (const [position, window] of windows) parts.push(`${windowLabel(window, snapshot.family, position)} ${remainingPercent(window)}% left/${formatResetDuration(window.resetAt, now)}`);
  if (!windows.length && snapshot.plan) parts.push(planStatus(snapshot, false));
  return parts.join(" | ");
}

function creditsLabel(credits) {
  if (credits?.unlimited) return "Credits: unlimited";
  return credits?.balance !== undefined ? `Credits: ${credits.balance}` : undefined;
}

export function formatUsageDetails(snapshot, now = Date.now()) {
  const label = providerUsageLabel(snapshot.provider);
  const lines = [`Limits for ${label}${snapshot.account ? ` — ${snapshot.account}` : ""}${snapshot.plan ? ` (${snapshot.plan})` : ""}`];
  if (snapshot.serviceable !== undefined) lines.push(snapshot.serviceable ? "The account reports it can be used right now." : "The account reports it is currently blocked, whatever the percentages below say.");
  const windows = quotaWindows(snapshot);
  if (!windows.length && snapshot.plan) lines.push(planStatus(snapshot, true));
  for (const [position, window] of windows) lines.push(`${windowLabel(window, snapshot.family, position)}: ${remainingPercent(window)}% left (${Math.round(window.usedPercent)}% used), resets in ${formatResetDuration(window.resetAt, now)} at ${new Date(window.resetAt).toLocaleString()}`);
  const credits = creditsLabel(snapshot.credits);
  if (credits) lines.push(credits);
  lines.push(`Updated ${formatResetDuration(now, snapshot.fetchedAt)} ago`);
  return lines.join("\n");
}

export function usageColor(snapshot) {
  const remaining = [snapshot.primary, snapshot.secondary].filter(window => !!window).map(remainingPercent);
  const lowest = remaining.length > 0 ? Math.min(...remaining) : 100;
  if (lowest <= 10) return "error";
  if (lowest <= 30) return "warning";
  return "success";
}
