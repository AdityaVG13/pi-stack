/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Cursor OAuth authentication via PKCE.
 *
 * Flow:
 * 1. Generate PKCE verifier + challenge
 * 2. Open browser to cursor.com/loginDeepControl
 * 3. Poll api2.cursor.sh/auth/poll until tokens arrive
 * 4. Refresh via api2.cursor.sh/auth/exchange_user_api_key
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

import { setTimeout as sleep } from "node:timers/promises";

const activeAuth = new Set();
export function stopCursorAuthOperations() {
  for (const controller of activeAuth) controller.abort();
}

// Own the whole login/refresh, including PKCE, backoff, response bodies and catalog
// discovery. Individual I/O deadlines do not replace cancellation of the workflow.
export async function withCursorAuthOperation(signal, work) {
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  activeAuth.add(controller);
  try {
    activeSignal.throwIfAborted();
    const result = await work(activeSignal);
    activeSignal.throwIfAborted();
    return result;
  } finally {
    activeAuth.delete(controller);
  }
}

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

// ── PKCE ──

async function generatePKCE() {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");
  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = Buffer.from(hashBuffer).toString("base64url");
  return {
    verifier,
    challenge
  };
}

// ── Login params ──

export async function generateCursorAuthParams() {
  const {
    verifier,
    challenge
  } = await generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli"
  });
  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
  return {
    verifier,
    challenge,
    uuid,
    loginUrl
  };
}

// ── Poll for auth completion ──

function authTokens(data, fallbackRefresh) {
  const accessToken = data?.accessToken;
  const refreshToken = data?.refreshToken === undefined ? fallbackRefresh : data.refreshToken;
  if (typeof accessToken !== "string" || !accessToken.trim() || typeof refreshToken !== "string" || !refreshToken.trim()) throw new Error("Cursor authentication response contained invalid tokens");
  return { accessToken, refreshToken };
}

async function pollResult(response) {
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Poll failed: ${response.status}`);
  return authTokens(await response.json());
}

export function pollCursorAuth(uuid, verifier, signal) {
  return withCursorAuthOperation(signal, activeSignal => pollAuth(uuid, verifier, activeSignal));
}

async function pollAuth(uuid, verifier, signal) {
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay, undefined, { signal });
    try {
      const result = await pollResult(await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" } }));
      if (result) return result;
      consecutiveErrors = 0;
      delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
    } catch {
      signal.throwIfAborted();
      if (++consecutiveErrors >= 3) throw new Error("Too many consecutive errors during Cursor auth polling");
    }
  }
  throw new Error("Cursor authentication polling timeout");
}

// ── Token refresh ──

export function refreshCursorToken(refreshToken, options = {}) {
  return withCursorAuthOperation(options.signal, signal => refreshTokenRequest(refreshToken, AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 15000)])));
}

async function refreshTokenRequest(refreshToken, signal) {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0"
    },
    body: "{}"
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Cursor token refresh failed: HTTP ${response.status}`);
  }
  const data = authTokens(await response.json(), refreshToken);
  return {
    access: data.accessToken,
    refresh: data.refreshToken || refreshToken,
    expires: getTokenExpiry(data.accessToken)
  };
}

// ── JWT expiry extraction ──

export function getTokenExpiry(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600 * 1000;
    }
    const decoded = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {}
  return Date.now() + 3600 * 1000;
}
