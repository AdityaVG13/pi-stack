/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Multi-account surface for the Cursor provider.
 *
 * The single-account extension (`index.ts`) keeps ONE module-level access token and
 * registers ONE provider called `cursor`. Rotation needs N providers — `cursor`,
 * `cursor-account-2`, ... — that share one local proxy while each authenticates as its
 * own Cursor subscription.
 *
 * The account is carried by the request itself: every slot's `getApiKey` returns THAT
 * slot's access token, Pi puts it in the `Authorization` header of the call to the local
 * proxy, and the proxy hands the very same token to Cursor. Nothing is cached between
 * requests, so a failover mid-session takes effect on the next call instead of silently
 * re-using the spent account's token.
 *
 * Consumed by pi-multi-account's `cursor-bridge.ts`.
 */

import { cursorPayloadStream } from "../provider-payload-stream.js";
import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken, withCursorAuthOperation } from "./auth.js";
import { FALLBACK_MODELS, modelConfig, processModels } from "./index.js";
import { getCursorModels, startProxy, getProxyPort } from "./proxy.js";
export const CURSOR_BASE = "cursor";

/** Resolves the stored access token for a provider id (reads the host's auth.json). */

// `var`, deliberately: these are hoisted, so even a caller that reaches this module while it
// is still initializing (a concurrent import) sees `undefined` instead of a temporal-dead-zone
// crash. The module is shared by every account slot and must never be the reason a session
// loses Cursor.
// eslint-disable-next-line no-var
var proxyPromise;
// eslint-disable-next-line no-var
var tokenResolver;

/**
 * The bearer token Pi attached to this proxy call, i.e. the identity of the slot that
 * made it. `cursor-proxy` is the single-account extension's placeholder and carries no
 * identity, so it is treated as absent.
 */
function bearerFromRequest(req) {
  const raw = req?.headers?.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token || token === "cursor-proxy") return undefined;
  return token;
}

/**
 * Start (once) the shared local proxy. Idempotent: later calls only refresh the fallback
 * resolver and return the port already bound, so every slot registers against one port.
 */
export async function ensureCursorProxy(resolve) {
  tokenResolver = resolve;
  const pending = proxyPromise;
  if (pending) {
    const port = await pending;
    if (getProxyPort() === port) return port;
    if (proxyPromise === pending) proxyPromise = undefined;
  }
  proxyPromise ??= startProxy(async req => {
    const fromRequest = bearerFromRequest(req);
    if (fromRequest) return fromRequest;
    // No usable token on the request (a legacy placeholder, or a caller that sends none):
    // fall back to the base slot's stored credential rather than failing the call.
    const fallback = (await tokenResolver?.(CURSOR_BASE)) ?? "";
    if (!fallback) {
      throw new Error("No Cursor account is logged in for this request. Run /login and pick a cursor slot.");
    }
    return fallback;
  }).catch(error => {
    proxyPromise = undefined;
    throw error;
  });
  return proxyPromise;
}
function displayName(id) {
  return id === CURSOR_BASE ? "Cursor" : `Cursor (${id})`;
}
async function discoverModels(accessToken, onModelsDiscovered, signal) {
  if (!onModelsDiscovered) return;
  try {
    const discovered = await getCursorModels(accessToken, { signal });
    if (discovered.length > 0) onModelsDiscovered(discovered);
  } catch {
    // Catalog discovery is an enhancement over FALLBACK_MODELS. A login must never fail
    // because Cursor's model list could not be read.
  }
}

/**
 * Register one Cursor account slot as its own Pi provider.
 *
 * Safe to call repeatedly for the same id — that is how a freshly discovered catalog
 * replaces the fallback list.
 */
export function registerCursorProvider(pi, id, proxyPort, rawModels = FALLBACK_MODELS, options = {}) {
  const name = displayName(id);
  const models = processModels(rawModels).map(modelConfig);
  pi.registerProvider(id, {
    name,
    baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    api: "openai-completions",
    streamSimple: cursorPayloadStream,
    models,
    oauth: {
      name,
      isSubscription: true,
      async login(callbacks) {
        return withCursorAuthOperation(callbacks.signal, async signal => {
        const {
          verifier,
          uuid,
          loginUrl
        } = await generateCursorAuthParams();
        signal.throwIfAborted();
        callbacks.onAuth({
          url: loginUrl
        });
        const {
          accessToken,
          refreshToken
        } = await pollCursorAuth(uuid, verifier, signal);
        const credentials = {
          type: "oauth",
          access: accessToken,
          refresh: refreshToken,
          expires: getTokenExpiry(accessToken)
        };
        // Reject BEFORE the catalog call: a duplicate must cost nothing and change nothing.
        const verified = options.rejectDuplicateLogin ? options.rejectDuplicateLogin(id, credentials) : credentials;
        await discoverModels(accessToken, options.onModelsDiscovered, signal);
        signal.throwIfAborted();
        return verified;
        });
      },
      async refreshToken(credentials) {
        return withCursorAuthOperation(undefined, async signal => {
        const refreshed = await refreshCursorToken(credentials.refresh, { signal });
        await discoverModels(refreshed.access, options.onModelsDiscovered, signal);
        signal.throwIfAborted();
        return {
          type: "oauth",
          ...refreshed
        };
        });
      },
      /**
       * THIS slot's token, not a shared placeholder — it is what tells the proxy which
       * Cursor account the request belongs to.
       */
      getApiKey(credentials) {
        return credentials.access ?? "";
      }
    }
  });
}
export { FALLBACK_MODELS };

/**
 * Read the account's real model catalog.
 *
 * THROWS the underlying error: callers (login, refresh, startup discovery) each decide
 * whether a failed catalog read is fatal — swallowing it here left every layer above
 * guessing why the fallback list was still in effect.
 */
export async function discoverCursorModels(accessToken) {
  return getCursorModels(accessToken);
}
