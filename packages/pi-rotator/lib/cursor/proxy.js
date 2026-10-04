/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed HTTP protocol retained; see PROVENANCE.json. */
// Public Cursor transport surface and loopback HTTP routing. Account ownership is
// outside this module; request, exec, frames and stream state have named boundaries.
import { activeBridges, conversationStates, cleanupBridge, clearConversationRegistry, isStaleForTranscript, transcriptIdentity, forgetConversation, deterministicConversationId, deriveBridgeKeyFromSessionId, deriveConversationKeyFromSessionId, dropConversation } from "./conversation-registry.js";
import { createServer } from "node:http";
import { nextDebugRequestId, debugLog, isProxyDebugEnabled, getDebugLogFilePath } from "./debug.js";
import { resolveUsableModelId, resolveModelId, stopCursorBridgeProcesses } from "./rpc.js";
import { estimatePromptTokens } from "./prompt-usage.js";
import { handleToolResultResume, handleNonStreamingResponse, handleStreamingResponse } from "./responses.js";
import { buildMcpToolDefinitions, buildCursorRequest } from "./request.js";
import { historyForRebuild, requestActionText, systemPromptForRebuild, parseMessages as parseMessagesPure, textContent } from "./message-parsing.js";
import { createHash } from "node:crypto";

import { stopCursorAuthOperations } from "./auth.js";

const CONVERSATION_TTL_MS = 30 * 60 * 1000;

export const __testInternals = {
  activeBridges,
  conversationStates
};

let proxyServer;
let proxyPending;
let cancelProxyStartup;

let proxyPort;

let proxyAccessTokenProvider;

export function getProxyPort() {
  return proxyPort;
}

function observeRequest(req, res) {
  const requestId = nextDebugRequestId();
  // Socket failures are observed without throwing into the host process.
  res.on("error", error => debugLog("http.response_error", { requestId, error: String(error) }));
  req.on("error", error => debugLog("http.request_error", { requestId, error: String(error) }));
  const url = new URL(req.url ?? "/", "http://localhost");
  debugLog("http.request", { requestId, method: req.method, pathname: url.pathname, headers: req.headers });
  return { url, requestId };
}

function chatHttpError(res, error, requestId) {
  const message = error instanceof Error ? error.message : String(error);
  debugLog("http.chat.error", { requestId, message, stack: error instanceof Error ? error.stack : undefined });
  // Streaming headers may already be sent. Never throw again from the catch path.
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "server_error", code: "internal_error" } }));
}

async function chatHttpRequest(req, res, requestId) {
  const server = proxyServer;
  const current = () => proxyServer === server && !(res.destroyed || res.writableEnded || res.socket?.destroyed);
  try {
    const parsed = JSON.parse(await readBody(req));
    if (!current()) return;
    debugLog("http.chat.body", { requestId, body: parsed });
    if (!proxyAccessTokenProvider) throw new Error("No access token provider");
    // Resolve the account from THIS request; single-account callers may ignore req.
    const accessToken = await proxyAccessTokenProvider(req);
    // Credential lookup may outlive disconnect/shutdown; never resurrect a Run.
    if (!current()) return;
    await handleChatCompletion(parsed, accessToken, req, res, requestId);
  } catch (error) {
    chatHttpError(res, error, requestId);
  }
}

async function handleHttpRequest(req, res) {
  let observed;
  try { observed = observeRequest(req, res); } catch {
    // Node does not await async HTTP listeners; malformed targets must not reject.
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Invalid request target", type: "invalid_request_error" } }));
  }
  const { url, requestId } = observed;
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [] }));
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") return chatHttpRequest(req, res, requestId);
  res.writeHead(404);
  res.end("Not Found");
}

export async function startProxy(getAccessToken) {
  proxyAccessTokenProvider = getAccessToken;
  if (proxyServer && proxyPort) return proxyPort;
  if (proxyPending) return proxyPending;
  const pending = new Promise((resolve, reject) => {
    const server = createServer(handleHttpRequest);
    proxyServer = server;
    const fail = error => {
      if (proxyServer === server) {
        proxyServer = undefined;
        proxyPort = undefined;
      }
      server.close();
      reject(error);
    };
    cancelProxyStartup = () => fail(new Error("Cursor proxy stopped during startup"));
    server.on("clientError", (error, socket) => { debugLog("http.client_error", { error: String(error) }); socket.destroy(); });
    server.on("error", error => {
      debugLog("http.server_error", { error: String(error) });
      if (!server.listening) fail(error);
    });
    server.listen(0, "127.0.0.1", () => {
      if (proxyServer !== server) {
        server.close();
        return reject(new Error("Cursor proxy stopped during startup"));
      }
      const address = server.address();
      if (typeof address !== "object" || !address) return fail(new Error("Failed to bind proxy"));
      proxyPort = address.port;
      server.unref();
      debugLog("proxy.start", { port: proxyPort, debugLogFile: isProxyDebugEnabled() ? getDebugLogFilePath() : undefined });
      resolve(proxyPort);
    });
  });
  proxyPending = pending;
  try { return await pending; } finally {
    if (proxyPending === pending) {
      proxyPending = undefined;
      cancelProxyStartup = undefined;
    }
  }
}

export function cleanupAllSessionState() {
  debugLog("session.cleanup_all", {
    activeBridgeCount: activeBridges.size,
    conversationCount: conversationStates.size
  });
  for (const [bridgeKey, active] of activeBridges) {
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  }
  clearConversationRegistry();
  stopCursorBridgeProcesses();
  stopCursorAuthOperations();
}

export function stopProxy() {
  debugLog("proxy.stop", {
    port: proxyPort
  });
  const server = proxyServer;
  cancelProxyStartup?.();
  proxyServer = undefined;
  proxyPort = undefined;
  proxyPending = undefined;
  cancelProxyStartup = undefined;
  proxyAccessTokenProvider = undefined;
  // Closing only the listener leaves in-flight/keepalive HTTP connections open.
  server?.closeAllConnections();
  server?.close();
  cleanupAllSessionState();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function evictStaleConversations(now = Date.now()) {
  for (const [key, stored] of conversationStates) {
    if (!stored.sessionScoped && now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      debugLog("conversation.evict", {
        key,
        stored,
        now
      });
      conversationStates.delete(key);
    }
  }
}

function resumeToolResults(active, toolResults, context) {
  if (!active || toolResults.length === 0) return false;
  const { bridgeKey, convKey, modelId, turns, req, res, requestId, promptTokens, stream } = context;
  debugLog("chat.resume_tool_results", { requestId, bridgeKey, toolResults, pendingExecs: active.pendingExecs });
  activeBridges.delete(bridgeKey);
  if (!active.bridge.alive) {
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
    return false;
  }
  handleToolResultResume(active, toolResults, modelId, bridgeKey, convKey, turns, req, res, stream, requestId, promptTokens);
  return true;
}

function prepareConversation(convKey, sessionId, parsed, tools, requestId, credentialHash, modelId) {
  const turnsCovered = parsed.turns.length;
  let stored = conversationStates.get(convKey);
  debugLog("chat.stored_state.before", { requestId, convKey, stored });
  // A checkpoint cannot cover work done while another provider owned the turn.
  if (stored && (isStaleForTranscript(stored, parsed, tools) || stored.credentialHash !== credentialHash || stored.modelId !== modelId)) {
    debugLog("conversation.stale_checkpoint", { requestId, convKey, turnsCovered: stored.turnsCovered, completedTurns: turnsCovered });
    forgetConversation(convKey);
    stored = undefined;
  }
  // Every fresh Run gets a distinct collector owner, even when its scope/checkpoint is unchanged.
  stored = stored ? { ...stored } : { credentialHash, modelId, conversationId: deterministicConversationId(convKey), checkpoint: null, sessionScoped: !!sessionId, blobStore: new Map(), lastAccessMs: Date.now(), turnsCovered };
  conversationStates.set(convKey, stored);
  stored.turnsCovered = turnsCovered;
  stored.transcriptIdentity = transcriptIdentity(parsed, tools);
  stored.lastAccessMs = Date.now();
  evictStaleConversations();
  return stored;
}

async function handleChatCompletion(body, accessToken, req, res, requestId) {
  const parsed = parseMessages(body.messages, body.pi_tool_result_errors);
  const { systemPrompt, userText, turns, toolResults } = parsed;
  const modelId = resolveUsableModelId(resolveModelId(body.model, body.reasoning_effort), accessToken);
  const tools = body.tools ?? [];
  debugLog("chat.parsed_messages", { requestId, systemPrompt, userText, turns, toolResults, messageCount: body.messages.length, model: body.model, resolvedModelId: modelId, stream: body.stream !== false });
  if (!userText && toolResults.length === 0) {
    debugLog("chat.no_user_message", { requestId, messages: body.messages });
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
  }
  const sessionId = derivePiSessionId(body);
  const bridgeKey = deriveBridgeKey(body.messages, sessionId);
  const convKey = deriveConversationKey(body.messages, sessionId);
  const active = activeBridges.get(bridgeKey);
  debugLog("chat.session_keys", { requestId, sessionId, bridgeKey, convKey, hasActiveBridge: !!active });
  const promptTokens = estimatePromptTokens(body.messages, body.tools);
  const credentialHash = createHash("sha256").update(accessToken).digest("hex");
  const previous = conversationStates.get(convKey);
  const sameScope = previous?.credentialHash === credentialHash && previous.modelId === modelId
    && previous.turnsCovered === turns.length && !isStaleForTranscript(previous, parsed, tools, true);
  // Paused Runs are bound to their account, model, instructions, tools and exact user turn.
  // Rebuild abandoned pauses too; their checkpoint contains unfinished native execs.
  if (sameScope && body.stream !== false && resumeToolResults(active, toolResults, { bridgeKey, convKey, modelId, turns, req, res, requestId, promptTokens, stream: true })) return;
  if (active) forgetConversation(convKey);
  if (active && activeBridges.has(bridgeKey)) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  const stored = prepareConversation(convKey, sessionId, parsed, tools, requestId, credentialHash, modelId);
  const mcpTools = buildMcpToolDefinitions(tools);
  const hasCheckpoint = !!stored.checkpoint;
  const effectiveUserText = requestActionText(parsed, { hasCheckpoint });
  const effectiveSystemPrompt = systemPromptForRebuild(systemPrompt, parsed, { hasCheckpoint });
  if (!stored.checkpoint) debugLog("chat.no_checkpoint", { requestId, convKey, conversationId: stored.conversationId });
  const payload = buildCursorRequest(modelId, effectiveSystemPrompt, effectiveUserText, historyForRebuild(parsed), stored.conversationId, stored.checkpoint, stored.blobStore);
  debugLog("chat.cursor_request", { requestId, conversationId: stored.conversationId, effectiveUserText, restoredSystemPromptChars: effectiveSystemPrompt.length - systemPrompt.length, turnCount: turns.length, hasCheckpoint, payload });
  payload.mcpTools = mcpTools;
  const currentTurn = { userText: effectiveUserText, steps: [] };
  // Compare Pi-visible input, not the rebuild-only action annotations; collectors own the shared steps.
  stored.currentTurn = { userText, prefixSteps: parsed.pendingTurn?.steps ?? [], steps: currentTurn.steps };
  if (body.stream === false) {
    debugLog("chat.dispatch_nonstream", { requestId, convKey });
    await handleNonStreamingResponse(payload, accessToken, modelId, convKey, turns, currentTurn, req, res, requestId, promptTokens);
  } else {
    debugLog("chat.dispatch_stream", { requestId, bridgeKey, convKey });
    handleStreamingResponse(payload, accessToken, modelId, bridgeKey, convKey, turns, currentTurn, req, res, requestId, promptTokens);
  }
}

export function parseMessages(messages, toolErrors) {
  return parseMessagesPure(messages, debugLog, toolErrors);
}

export function derivePiSessionId(body) {
  const raw = body.pi_session_id ?? body.user;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function deriveBridgeKey(messages, sessionId) {
  if (sessionId) return deriveBridgeKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find(m => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256").update(`bridge:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

export function deriveConversationKey(messages, sessionId) {
  if (sessionId) return deriveConversationKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find(m => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256").update(`conv:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

export function cleanupSessionState(sessionId) {
  if (!sessionId) return;
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const active = activeBridges.get(bridgeKey);
  debugLog("session.cleanup", {
    sessionId,
    bridgeKey,
    convKey,
    hasActiveBridge: !!active,
    hadConversation: conversationStates.has(convKey)
  });
  if (active) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  dropConversation(convKey);
}

export function resetConversationForSession(sessionId) {
  if (!sessionId) return;
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const active = activeBridges.get(bridgeKey);
  const hadConversation = forgetConversation(convKey);
  debugLog("conversation.reset_after_compaction", {
    sessionId,
    bridgeKey,
    convKey,
    hadConversation,
    hasActiveBridge: !!active,
    nextConversationId: deterministicConversationId(convKey)
  });
  if (active) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
}

export { deriveBridgeKeyFromSessionId, deriveConversationKeyFromSessionId, deterministicConversationId };

export { setBridgeFactoryForTests, callCursorUnaryRpc, getCursorModels, resolveModelId, resolveUsableModelId } from "./rpc.js";

export { buildCursorRequest } from "./request.js";

export { writeSSEStreamForTests } from "./stream.js";

export { resumeCursorToolResultsForTests } from "./responses.js";
