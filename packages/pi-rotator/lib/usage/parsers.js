/* oxlint-disable -- Licensed external-provider parsing, scalar validation retained. See LICENSE. */
// Provider-specific quota interpretation. Unknown windows never create headroom.
import { record, usageWindow, percent, epochMs, finiteNumber } from "./common.js";

function quotaVerdict(limit) {
  if (typeof limit.limit_reached === "boolean") return !limit.limit_reached;
  return typeof limit.allowed === "boolean" ? limit.allowed : undefined;
}

function creditInfo(value) {
  const credits = record(value);
  return {
    hasCredits: typeof credits.has_credits === "boolean" ? credits.has_credits : undefined,
    unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : undefined,
    balance: ["string", "number"].includes(typeof credits.balance) ? String(credits.balance) : undefined,
  };
}

export function parseCodexUsageBody(provider, body, fetchedAt = Date.now(), credentialHash) {
  const source = record(body);
  const rateLimit = record(source.rate_limit);
  const primary = usageWindow(rateLimit.primary_window, 5 * 60 * 60);
  const secondary = usageWindow(rateLimit.secondary_window, 7 * 24 * 60 * 60);
  if (!primary && !secondary) return undefined;
  return {
    provider, family: "codex", fetchedAt, credentialHash,
    plan: typeof source.plan_type === "string" ? source.plan_type : undefined,
    account: typeof source.email === "string" && source.email.trim() ? source.email : undefined,
    serviceable: quotaVerdict(rateLimit), primary, secondary, credits: creditInfo(source.credits),
  };
}

export function parseAnthropicUsageBody(provider, body, fetchedAt = Date.now(), credentialHash) {
  const source = record(body);
  const primary = usageWindow(source.five_hour, 5 * 60 * 60);
  const secondary = usageWindow(source.seven_day, 7 * 24 * 60 * 60);
  if (!primary && !secondary) return undefined;
  return {
    provider,
    family: "anthropic",
    fetchedAt,
    credentialHash,
    primary,
    secondary
  };
}

function headerValue(headers, name) {
  const getter = headers?.get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(record(headers))) {
    if (key.toLowerCase() === name.toLowerCase() && value !== undefined) return String(value);
  }
  return undefined;
}

function headerBoolean(headers, name) {
  const value = headerValue(headers, name)?.toLowerCase();
  return value === "true" ? true : value === "false" ? false : undefined;
}

function headerWindow(headers, prefix) {
  const usedPercent = percent(headerValue(headers, `x-codex-${prefix}-used-percent`));
  const resetAt = epochMs(headerValue(headers, `x-codex-${prefix}-reset-at`));
  const windowMinutes = finiteNumber(headerValue(headers, `x-codex-${prefix}-window-minutes`));
  if (usedPercent === undefined || resetAt === undefined) return undefined;
  return {
    usedPercent,
    resetAt,
    ...(windowMinutes !== undefined ? {
      windowSeconds: windowMinutes * 60
    } : {})
  };
}

export function parseCodexUsageHeaders(provider, headers, fetchedAt = Date.now(), credentialHash) {
  const primary = headerWindow(headers, "primary");
  const secondary = headerWindow(headers, "secondary");
  if (!primary && !secondary) return undefined;
  return {
    provider,
    family: "codex",
    fetchedAt,
    credentialHash,
    plan: headerValue(headers, "x-codex-plan-type"),
    primary,
    secondary,
    credits: {
      hasCredits: headerBoolean(headers, "x-codex-credits-has-credits"),
      unlimited: headerBoolean(headers, "x-codex-credits-unlimited"),
      balance: headerValue(headers, "x-codex-credits-balance")
    }
  };
}

function nullableOllamaTime(value) {
  return value && typeof value === "object" && value.Valid === true && typeof value.Time === "string" ? value.Time : undefined;
}

function ollamaPlan(source) {
  const name = typeof source.Plan === "string" ? source.Plan : typeof source.plan === "string" ? source.plan : undefined;
  const parts = name ? [name] : [];
  if (nullableOllamaTime(source.SuspendedAt)) parts.push("SUSPENDED");
  const periodEnd = nullableOllamaTime(source.SubscriptionPeriodEnd);
  if (periodEnd) {
    const date = new Date(periodEnd);
    if (!Number.isNaN(date.getTime())) parts.push(`renews ${date.toISOString().slice(0, 10)}`);
  }
  return parts.length ? parts.join(" · ") : name;
}

export function parseOllamaMeBody(provider, body, fetchedAt = Date.now(), credentialHash) {
  const source = record(body);
  return {
    provider, family: "ollama", fetchedAt, credentialHash, plan: ollamaPlan(source),
    primary: usageWindow(source.session ?? source.Session ?? source.session_usage ?? source.SessionUsage, 5 * 60 * 60),
    secondary: usageWindow(source.weekly ?? source.Weekly ?? source.weekly_usage ?? source.WeeklyUsage, 7 * 24 * 60 * 60),
  };
}

const OLLAMA_SESSION_SECONDS = 5 * 60 * 60;

const OLLAMA_WEEK_SECONDS = 7 * 24 * 60 * 60;

const OLLAMA_WEEK_ANCHOR_MS = 4 * 24 * 60 * 60_000;

function nextBoundary(now, windowMs, anchorMs = 0) {
  return anchorMs + (Math.floor((now - anchorMs) / windowMs) + 1) * windowMs;
}

function ollamaFractionWindow(value, fetchedAt, windowSeconds, anchorMs = 0) {
  const rawUsage = record(value).usage;
  if (rawUsage === null || rawUsage === undefined || rawUsage === "") return undefined;
  const usage = finiteNumber(rawUsage);
  // Ollama documents this only through its live response today. Be strict about the observed
  // fractional shape so a future percentage-valued response cannot silently turn 50% into 100%.
  if (usage === undefined || usage < 0 || usage > 1) return undefined;
  return {
    usedPercent: usage * 100,
    resetAt: nextBoundary(fetchedAt, windowSeconds * 1000, anchorMs),
    windowSeconds
  };
}

export function parseOllamaUsageBody(provider, body, fetchedAt = Date.now(), credentialHash) {
  const limits = record(record(body).limits);
  const primary = ollamaFractionWindow(limits.session, fetchedAt, OLLAMA_SESSION_SECONDS);
  const secondary = ollamaFractionWindow(limits.weekly, fetchedAt, OLLAMA_WEEK_SECONDS, OLLAMA_WEEK_ANCHOR_MS);
  if (!primary && !secondary) return undefined;
  return {
    provider,
    family: "ollama",
    fetchedAt,
    credentialHash,
    primary,
    secondary
  };
}

function cursorBillingCycle(source) {
  const start = epochMs(source.billingCycleStart ?? source.billing_cycle_start);
  const end = epochMs(source.billingCycleEnd ?? source.billing_cycle_end);
  const seconds = start !== undefined && end !== undefined && end > start ? Math.round((end - start) / 1000) : undefined;
  return { end, seconds };
}

function cursorPeriodWindow(value, cycle) {
  const usedPercent = percent(value);
  if (usedPercent === undefined || cycle.end === undefined) return undefined;
  return { usedPercent, resetAt: cycle.end, ...(cycle.seconds !== undefined ? { windowSeconds: cycle.seconds } : {}) };
}

export function parseCursorCurrentPeriodUsage(provider, body, fetchedAt = Date.now(), credentialHash) {
  const source = record(body);
  const planUsage = record(source.planUsage ?? source.plan_usage);
  const cycle = cursorBillingCycle(source);
  const primary = cursorPeriodWindow(planUsage.autoPercentUsed ?? planUsage.auto_percent_used, cycle);
  const secondary = cursorPeriodWindow(planUsage.apiPercentUsed ?? planUsage.api_percent_used, cycle);
  if (!primary && !secondary) return undefined;
  return { provider, family: "cursor", fetchedAt, credentialHash, primary, secondary };
}

export function parseCursorSandUsage(body) {
  const source = record(body);
  const usedPercent = percent(source.usagePercent ?? source.usage_percent);
  const resetAt = epochMs(source.nextResetTimestampUtc ?? source.next_reset_timestamp_utc);
  const startAt = epochMs(source.currentPeriodStart ?? source.current_period_start);
  if (usedPercent === undefined || resetAt === undefined) return undefined;
  const windowSeconds = startAt !== undefined && resetAt > startAt ? Math.round((resetAt - startAt) / 1000) : undefined;
  return {
    usedPercent,
    resetAt,
    ...(windowSeconds !== undefined ? {
      windowSeconds
    } : {})
  };
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    let payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    payload += "=".repeat((4 - payload.length % 4) % 4);
    const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jwtClaimString(payload, key) {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function xaiUserIdFromAccessToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  return jwtClaimString(payload, "sub") ?? jwtClaimString(payload, "principal_id");
}

function isGrokBuildProduct(name) {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase().replace(/[_-]/g, "");
  return normalized === "productgrokbuild" || normalized === "grokbuild";
}

function grokBuildUsagePercent(productUsage) {
  if (!Array.isArray(productUsage)) return undefined;
  for (const item of productUsage) {
    const product = record(item);
    if (!isGrokBuildProduct(product.product)) continue;
    const value = percent(product.usagePercent);
    if (value !== undefined) return value;
  }
  return undefined;
}

function xaiUsagePeriod(value, fetchedAt) {
  const source = record(value);
  const start = epochMs(source.start);
  const end = epochMs(source.end);
  if (start === undefined || end === undefined || end <= start || fetchedAt < start || fetchedAt >= end) {
    return undefined;
  }
  return {
    resetAt: end,
    windowSeconds: Math.round((end - start) / 1000)
  };
}

function xaiUsageSnapshot(provider, usedPercent, period, fetchedAt, credentialHash) {
  return {
    provider,
    family: "xai",
    fetchedAt,
    credentialHash,
    primary: {
      usedPercent,
      ...period
    }
  };
}

function legacyXaiUsage(config, provider, fetchedAt, credentialHash) {
  const period = xaiUsagePeriod({ start: config.billingPeriodStart, end: config.billingPeriodEnd }, fetchedAt);
  if (!period) return undefined;
  const limit = finiteNumber(record(config.monthlyLimit).val);
  const used = finiteNumber(record(config.used).val);
  if (limit === undefined || limit <= 0 || used === undefined || used < 0) return undefined;
  const usage = percent((used / limit) * 100);
  return usage === undefined ? undefined : xaiUsageSnapshot(provider, usage, period, fetchedAt, credentialHash);
}

export function parseXaiUsageBody(provider, body, fetchedAt = Date.now(), credentialHash) {
  const source = record(body);
  if (source.config === undefined || source.config === null) return undefined;
  const config = record(source.config);
  const period = xaiUsagePeriod(config.currentPeriod, fetchedAt);
  const used = percent(config.creditUsagePercent) ?? grokBuildUsagePercent(config.productUsage);
  if (used !== undefined) return period ? xaiUsageSnapshot(provider, used, period, fetchedAt, credentialHash) : undefined;
  // Unknown modern quota cannot manufacture headroom by falling back to legacy totals.
  if (config.currentPeriod !== undefined) return undefined;
  return legacyXaiUsage(config, provider, fetchedAt, credentialHash);
}

function zaiWindow(value, fetchedAt) {
  const item = record(value);
  if (!["CREDIT_LIMIT", "TOKENS_LIMIT"].includes(item.type)) return undefined;
  const unit = finiteNumber(item.unit);
  const count = finiteNumber(item.number);
  const seconds = new Map([["3:5", 5 * 3600], ["6:1", 7 * 86400]]).get(`${unit}:${count}`);
  const usedPercent = percent(item.percentage);
  const resetAt = epochMs(item.nextResetTime);
  if (!seconds || usedPercent === undefined || resetAt === undefined || resetAt <= fetchedAt) return undefined;
  return { usedPercent, resetAt, windowSeconds: seconds };
}

function validZaiResponse(source) {
  return source.success !== false && (source.code === undefined || [0, 200, "0", "200"].includes(source.code));
}

function assignZaiWindow(snapshot, window) {
  const key = window.windowSeconds === 5 * 3600 ? "primary" : "secondary";
  if (!snapshot[key] || window.usedPercent > snapshot[key].usedPercent) snapshot[key] = window;
}

export function parseZaiCodingCnUsageBody(provider, body, fetchedAt = Date.now(), credentialHash) {
  const source = record(body);
  if (!validZaiResponse(source)) return undefined;
  const data = record(source.data);
  if (!Array.isArray(data.limits)) return undefined;
  const snapshot = { provider, family: "zai-coding-cn", fetchedAt, credentialHash };
  if (typeof data.level === "string" && data.level.trim()) snapshot.plan = data.level.trim();
  for (const value of data.limits) {
    const window = zaiWindow(value, fetchedAt);
    if (!window) continue;
    // Duplicate windows must not make an exhausted account look healthier.
    assignZaiWindow(snapshot, window);
  }
  return snapshot.primary || snapshot.secondary ? snapshot : undefined;
}
