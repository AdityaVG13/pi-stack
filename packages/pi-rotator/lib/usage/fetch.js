/* oxlint-disable -- Licensed external-provider HTTP semantics retained. See LICENSE. */
// Authenticated quota probes share deadlines; plan-only providers never make HTTP calls.
import { UsageFetchError, record, usageFamily } from "./common.js";
import { parseOllamaUsageBody, parseOllamaMeBody, parseCursorCurrentPeriodUsage, parseCursorSandUsage, xaiUserIdFromAccessToken, parseXaiUsageBody, parseZaiCodingCnUsageBody, parseCodexUsageBody, parseAnthropicUsageBody } from "./parsers.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function requireUsageCredential(provider, credential, type, field, label) {
  if (credential.type !== type || !credential[field]) throw new UsageFetchError(`${provider} has no ${label}`);
}

function usageFailure(provider, error, prefix, fallback) {
  if (error instanceof UsageFetchError) throw error;
  if (fallback) return fallback();
  if (error?.name === "AbortError") throw new UsageFetchError(`${provider} ${prefix} request timed out`);
  const message = error instanceof Error ? error.message : String(error);
  throw new UsageFetchError(`${provider} ${prefix} request failed: ${message}`);
}

async function usageRequest(provider, options, run, prefix = "usage", fallback) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    return await run(options.fetchImpl ?? fetch, controller.signal);
  } catch (error) {
    return usageFailure(provider, error, prefix, fallback);
  } finally {
    clearTimeout(timer);
  }
}

function expectUsageResponse(provider, response, description = "usage endpoint") {
  if (!response.ok) throw new UsageFetchError(`${provider} ${description} returned HTTP ${response.status}`, response.status);
}

async function enrichOllamaUsage(provider, account, options, fetchImpl, headers, signal) {
  try {
    const response = await fetchImpl("https://ollama.com/api/usage", { method: "GET", headers, signal });
    if (!response.ok) return account;
    const usage = parseOllamaUsageBody(provider, await response.json(), Date.now(), options.credentialHash);
    if (!usage) return account;
    return { ...account, fetchedAt: usage.fetchedAt, primary: usage.primary ?? account.primary, secondary: usage.secondary ?? account.secondary };
  } catch {
    return account;
  }
}

async function fetchOllamaUsageSnapshot(provider, credential, options = {}) {
  requireUsageCredential(provider, credential, "api_key", "key", "API key");
  const headers = { Authorization: `Bearer ${credential.key}`, Accept: "application/json", "Content-Type": "application/json" };
  return usageRequest(provider, options, async (fetchImpl, signal) => {
    const request = { method: "POST", headers, body: "{}", signal };
    const response = await fetchImpl("https://ollama.com/api/me", request);
    expectUsageResponse(provider, response, "Ollama account check");
    const account = parseOllamaMeBody(provider, await response.json(), Date.now(), options.credentialHash);
    return enrichOllamaUsage(provider, account, options, fetchImpl, headers, signal);
  }, "Ollama usage");
}

const CURSOR_DASHBOARD_RPC_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService";

async function settledUsageBody(result) {
  if (result.status !== "fulfilled" || !result.value.ok) return undefined;
  try { return await result.value.json(); } catch { return undefined; }
}

function assertCursorUsageAuth(provider, results) {
  if (results.some(result => result.status === "fulfilled" && result.value.status === 401)) {
    throw new UsageFetchError(`${provider} Cursor usage endpoint returned HTTP 401`, 401);
  }
}

function cursorUsageResult(provider, fetchedAt, options, periodBody, sandBody, fallback) {
  const period = periodBody !== undefined ? parseCursorCurrentPeriodUsage(provider, periodBody, fetchedAt, options.credentialHash) : undefined;
  const sand = sandBody !== undefined ? parseCursorSandUsage(sandBody) : undefined;
  if (!period && !sand) return fallback();
  const name = record(sandBody).cursorPlanName;
  return { provider, family: "cursor", fetchedAt, credentialHash: options.credentialHash,
    plan: typeof name === "string" && name ? name : "subscription", primary: period?.primary, secondary: period?.secondary, tertiary: sand };
}

async function fetchCursorUsageSnapshot(provider, credential, options = {}) {
  requireUsageCredential(provider, credential, "oauth", "access", "OAuth access token");
  const fetchedAt = Date.now();
  const fallback = () => ({ provider, family: "cursor", fetchedAt, credentialHash: options.credentialHash, plan: "subscription" });
  return usageRequest(provider, options, async (fetchImpl, signal) => {
    const headers = { Authorization: `Bearer ${credential.access}`, Accept: "application/json", "Content-Type": "application/json", "Connect-Protocol-Version": "1" };
    const results = await Promise.allSettled(["GetCurrentPeriodUsage", "GetSandUsageStatus"].map(method => fetchImpl(`${CURSOR_DASHBOARD_RPC_URL}/${method}`, { method: "POST", headers, body: "{}", signal })));
    assertCursorUsageAuth(provider, results);
    const periodBody = await settledUsageBody(results[0]);
    const sandBody = await settledUsageBody(results[1]);
    return cursorUsageResult(provider, fetchedAt, options, periodBody, sandBody, fallback);
  }, "usage", fallback);
}

export const XAI_SUBSCRIPTION_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

let cachedXaiClientVersion;

export function xaiHostClientVersion() {
  if (cachedXaiClientVersion) return cachedXaiClientVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
    const name = typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "pi-rotator";
    const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
    cachedXaiClientVersion = version ? `${name}/${version}` : name;
  } catch {
    cachedXaiClientVersion = "pi-rotator";
  }
  return cachedXaiClientVersion;
}

async function fetchXaiUsageSnapshot(provider, credential, options = {}) {
  if (credential.type !== "oauth" || !credential.access) return {
    provider, family: "xai", fetchedAt: Date.now(), credentialHash: options.credentialHash, plan: "api-key · no usage endpoint",
  };
  const userId = xaiUserIdFromAccessToken(credential.access);
  if (!userId) throw new UsageFetchError(`${provider} xAI access token has no user id`);
  return usageRequest(provider, options, async (fetchImpl, signal) => {
    const response = await fetchImpl(XAI_SUBSCRIPTION_USAGE_URL, { method: "GET", signal, headers: {
      Authorization: `Bearer ${credential.access}`, Accept: "application/json", "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": userId, "x-grok-client-version": xaiHostClientVersion(), "x-grok-client-mode": "headless",
    } });
    expectUsageResponse(provider, response);
    const snapshot = parseXaiUsageBody(provider, await response.json(), Date.now(), options.credentialHash);
    if (!snapshot) throw new UsageFetchError(`${provider} usage endpoint returned no quota window`);
    return snapshot;
  });
}

export const ZAI_CODING_CN_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

async function fetchZaiCodingCnUsageSnapshot(provider, credential, options) {
  if (credential.type !== "api_key" || !credential.key) throw new UsageFetchError(`${provider} has no Coding Plan API key`);
  try {
    const response = await (options.fetchImpl ?? fetch)(ZAI_CODING_CN_USAGE_URL, {
      headers: {
        Authorization: credential.key,
        Accept: "application/json"
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    });
    if (!response.ok) throw new UsageFetchError(`${provider} usage endpoint returned HTTP ${response.status}`, response.status);
    const snapshot = parseZaiCodingCnUsageBody(provider, await response.json(), Date.now(), options.credentialHash);
    if (!snapshot) throw new UsageFetchError(`${provider} usage endpoint returned no current quota window`);
    return snapshot;
  } catch (error) {
    if (error instanceof UsageFetchError) throw error;
    // Never echo provider bodies or fetch errors that could embed a credential.
    throw new UsageFetchError(`${provider} usage request failed or timed out`);
  }
}

async function fetchOAuthUsageSnapshot(provider, credential, options, family) {
  requireUsageCredential(provider, credential, "oauth", "access", "OAuth access token");
  const headers = { Authorization: `Bearer ${credential.access}`, Accept: "application/json" };
  const codex = family === "codex";
  const url = codex ? "https://chatgpt.com/backend-api/wham/usage" : "https://api.anthropic.com/api/oauth/usage";
  if (codex && credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
  if (!codex) headers["anthropic-beta"] = "oauth-2025-04-20";
  return usageRequest(provider, options, async (fetchImpl, signal) => {
    const response = await fetchImpl(url, { method: "GET", headers, signal });
    expectUsageResponse(provider, response);
    const parser = codex ? parseCodexUsageBody : parseAnthropicUsageBody;
    const snapshot = parser(provider, await response.json(), Date.now(), options.credentialHash);
    if (!snapshot) throw new UsageFetchError(`${provider} usage endpoint returned no 5h/7d windows`);
    return snapshot;
  });
}

function planOnlyUsage(provider, _credential, options, family, plan) {
  return { provider, family, fetchedAt: Date.now(), credentialHash: options.credentialHash, plan };
}

const USAGE_FETCHERS = new Map([
  ["codex", (provider, credential, options) => fetchOAuthUsageSnapshot(provider, credential, options, "codex")],
  ["anthropic", (provider, credential, options) => fetchOAuthUsageSnapshot(provider, credential, options, "anthropic")],
  ["ollama", fetchOllamaUsageSnapshot], ["cursor", fetchCursorUsageSnapshot],
  ["xai", fetchXaiUsageSnapshot], ["zai-coding-cn", fetchZaiCodingCnUsageSnapshot],
  ["kimi-coding", (provider, credential, options) => planOnlyUsage(provider, credential, options, "kimi-coding", "subscription · no usage endpoint")],
  ["qwen", (provider, credential, options) => planOnlyUsage(provider, credential, options, "qwen", "api-key · no usage endpoint")],
]);

export async function fetchUsageSnapshot(provider, credential, options = {}) {
  const fetcher = USAGE_FETCHERS.get(usageFamily(provider));
  if (!fetcher) throw new UsageFetchError(`Usage is not supported for ${provider}`);
  return fetcher(provider, credential, options);
}
