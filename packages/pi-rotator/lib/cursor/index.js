/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed lifecycle retained; see PROVENANCE.json. */
// Single-account adapter kept for the reused controller surface. Rotator owns aliases.
import { registerSessionLifecycleHooks } from "./session-lifecycle.js";
import { cleanupSessionState, resetConversationForSession, stopProxy, startProxy, getCursorModels } from "./proxy.js";
import { debugExtensionLog, registerExtensionDebugHooks, isExtensionDebugEnabled, getExtensionDebugLogFilePath, summarizeProviderPayload, summarizeBranchTail } from "./diagnostics.js";
import { FALLBACK_MODELS, processModels, modelConfig } from "./models.js";
import { cursorPayloadStream } from "../provider-payload-stream.js";
import { generateCursorAuthParams, pollCursorAuth, getTokenExpiry, refreshCursorToken, withCursorAuthOperation } from "./auth.js";

export function registerSessionLifecycleCleanup(pi) {
  registerSessionLifecycleHooks(pi, {
    cleanupSessionState,
    resetConversationForSession,
    shutdown: stopProxy,
    debug: debugExtensionLog
  });
}

export default async function (pi) {
  // Current access token, updated by login/refresh/getApiKey
  let currentToken = "";

  // Start proxy eagerly — it just binds a port, no auth needed until a request arrives.
  // The getAccessToken callback reads currentToken at request time.
  const proxyReady = startProxy(async () => {
    if (!currentToken) throw new Error("Not logged in to Cursor. Run /login cursor");
    return currentToken;
  });
  const skipDedup = !!process.env.PI_CURSOR_RAW_MODELS;
  registerSessionLifecycleCleanup(pi);
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    debugLogFile: isExtensionDebugEnabled() ? getExtensionDebugLogFilePath() : undefined
  });
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (payload && ctx.model?.provider === "cursor") {
      payload.pi_session_id = ctx.sessionManager.getSessionId();
      debugExtensionLog("before_provider_request", {
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId?.(),
        model: ctx.model?.id,
        payload: summarizeProviderPayload(payload),
        branch: summarizeBranchTail(ctx)
      });
    }
    return payload;
  });

  // Await proxy so models are registered before pi proceeds with model resolution.
  const port = await proxyReady;
  register(pi, port, FALLBACK_MODELS);
  function register(pi, port, rawModels) {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const processed = skipDedup ? rawModels.map(m => ({
      ...m,
      supportsEffort: false
    })) : processModels(rawModels);
    pi.registerProvider("cursor", {
      baseUrl,
      api: "openai-completions",
      streamSimple: cursorPayloadStream,
      models: processed.map(modelConfig),
      oauth: {
        name: "Cursor",
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
          currentToken = accessToken;

          // Discover real models and re-register
          const realPort = await proxyReady;
          try {
            const discovered = await getCursorModels(accessToken, { signal });
            if (discovered.length > 0) register(pi, realPort, discovered);
          } catch {
            // catalog discovery is best-effort; FALLBACK_MODELS are already registered
          }
          signal.throwIfAborted();
          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken)
          };
          });
        },
        async refreshToken(credentials) {
          return withCursorAuthOperation(undefined, async signal => {
          const refreshed = await refreshCursorToken(credentials.refresh, { signal });
          currentToken = refreshed.access;

          // Discover real models on refresh too
          const realPort = await proxyReady;
          try {
            const discovered = await getCursorModels(refreshed.access, { signal });
            if (discovered.length > 0) register(pi, realPort, discovered);
          } catch {
            // catalog discovery is best-effort; FALLBACK_MODELS are already registered
          }
          signal.throwIfAborted();
          return refreshed;
          });
        },
        getApiKey(credentials) {
          currentToken = credentials.access;
          return "cursor-proxy";
        }
      }
    });
  }
}

export function cleanupControllerSession(sessionId) {
  cleanupSessionState(sessionId);
}

export { parseModelId, supportsReasoningModelId, buildEffortMap, processModels, modelConfig, FALLBACK_MODELS } from "./models.js";
