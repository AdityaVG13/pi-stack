/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed response protocol retained; see PROVENANCE.json. */
// Start/resume bridge runs and collect nonstream responses with the same frame semantics.
import { bridgeFactory } from "./rpc.js";
import { debugLog } from "./debug.js";
import { frameConnectMessage, makeHeartbeatBytes, sendCancelAction, createConnectFrameParser, parseConnectEndStream } from "./frames.js";
import { writeSSEStream, createThinkingTagFilter } from "./stream.js";
import { getTurnToolCallResults, appendAssistantTextToTurn } from "./request.js";
import { activeBridges, conversationStates, commitConversationCheckpoint, forgetConversation } from "./conversation-registry.js";
import { respondWithPendingToolCalls } from "./stream-lifecycle.js";
import { resumePendingExecWithToolResult } from "./native-results.js";
import { computeUsage } from "./prompt-usage.js";
import { fromBinary } from "@bufbuild/protobuf";
import { AgentServerMessageSchema } from "./proto/agent_pb.cjs";
import { processServerMessage } from "./server-messages.js";
import { completionIdentity, completionResponse } from "./completion.js";
import { startUpstreamWatchdog, resolveTransportStallTimeoutMs, resolveUpstreamStallTimeoutMs, formatStallDuration } from "./upstream-watchdog.js";

function startBridge(accessToken, requestBytes) {
  const bridge = bridgeFactory({
    accessToken,
    rpcPath: "/agent.v1.AgentService/Run"
  });
  debugLog("bridge.start_run", {
    requestBytes
  });
  bridge.write(frameConnectMessage(requestBytes));
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return {
    bridge,
    heartbeatTimer
  };
}

export function handleStreamingResponse(payload, accessToken, modelId, bridgeKey, convKey, completedTurns, currentTurn, req, res, requestId, promptTokenEstimate = 0) {
  debugLog("stream.start", {
    requestId,
    bridgeKey,
    convKey,
    modelId
  });
  const {
    bridge,
    heartbeatTimer
  } = startBridge(accessToken, payload.requestBytes);
  writeSSEStream(bridge, heartbeatTimer, payload.blobStore, payload.mcpTools, modelId, bridgeKey, convKey, completedTurns, currentTurn, req, res, requestId, promptTokenEstimate);
}

export function handleToolResultResume(active, toolResults, modelId, bridgeKey, convKey, completedTurns, req, res, stream, requestId, promptTokenEstimate = 0) {
  const {
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    pendingExecs,
    currentTurn
  } = active;
  debugLog("tool_resume.start", {
    requestId,
    bridgeKey,
    convKey,
    toolResults,
    pendingExecs,
    currentTurn
  });
  for (const result of toolResults) {
    const turnToolStep = currentTurn.steps.find(step => step.kind === "toolCall" && step.toolCallId === result.toolCallId);
    if (turnToolStep) {
      turnToolStep.result = {
        content: result.content,
        isError: result.isError === true
      };
    }
  }
  const turnResults = getTurnToolCallResults(currentTurn);
  const unresolvedExecs = pendingExecs.filter(exec => !turnResults.has(exec.toolCallId));
  if (unresolvedExecs.length > 0) {
    activeBridges.set(bridgeKey, {
      bridge,
      heartbeatTimer,
      blobStore,
      mcpTools,
      pendingExecs,
      currentTurn
    });
    debugLog("tool_resume.partial_wait", {
      requestId,
      bridgeKey,
      unresolvedExecs,
      currentTurn
    });
    respondWithPendingToolCalls(modelId, unresolvedExecs, stream, res, promptTokenEstimate);
    return;
  }

  // Listen on the new OpenAI stream BEFORE writing exec results. Cursor often
  // replies in the same tick (text, thinking, the next exec, turnEnded). The
  // paused writer already called res.end(), so those frames used to land on a
  // closed SSE and vanish. Pi then sat on Working until the upstream stall watchdog fired.
  // Tool results belong to the same user turn that initiated the tool calls.
  // parseMessages keeps tool continuations out of completed history, so completedTurns
  // already reflects the correct history covered before this in-flight turn.
  writeSSEStream(bridge, heartbeatTimer, blobStore, mcpTools, modelId, bridgeKey, convKey, completedTurns, currentTurn, req, res, requestId, promptTokenEstimate);
  for (const exec of pendingExecs) {
    const result = turnResults.get(exec.toolCallId);
    if (!result) continue;
    resumePendingExecWithToolResult(exec, result.content, result.isError, data => bridge.write(data));
    debugLog("tool_resume.sent_result", {
      requestId,
      exec,
      result
    });
  }
}

export function resumeCursorToolResultsForTests(active, toolResults, req, res, opts) {
  handleToolResultResume(active, toolResults, opts.modelId, opts.bridgeKey, opts.convKey, opts.completedTurns ?? [], req, res, true);
}

export async function handleNonStreamingResponse(payload, accessToken, modelId, convKey, completedTurns, currentTurn, req, res, requestId, promptTokenEstimate = 0) {
  debugLog("nonstream.start", {
    requestId,
    convKey,
    modelId,
    currentTurn,
    completedTurnCount: completedTurns.length
  });
  const conversation = conversationStates.get(convKey);
  const ownsConversation = () => conversationStates.get(convKey) === conversation;
  const discardConversation = () => { if (ownsConversation()) forgetConversation(convKey); };
  const identity = completionIdentity(modelId);
  
  const {
    bridge,
    heartbeatTimer
  } = startBridge(accessToken, payload.requestBytes);
  let cancelled = false;
  const onClientClose = () => {
    if (cancelled) return;
    debugLog("nonstream.client_close", {
      requestId,
      convKey
    });
    cancelled = true;
    discardConversation();
    clearInterval(heartbeatTimer);
    if (bridge.alive) {
      sendCancelAction(bridge);
      bridge.destroy();
    }
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);
  const state = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    promptTokenEstimate
  };
  const tagFilter = createThinkingTagFilter();
  let fullText = "";
  let nonStreamError = null;
  let latestCheckpoint = null;
  return new Promise(resolve => {
    let settled = false;
    const endBridge = () => {
      clearInterval(heartbeatTimer);
      if (bridge.alive) {
        sendCancelAction(bridge);
        bridge.destroy();
      }
    };
    const commitCheckpoint = () => commitConversationCheckpoint(convKey, payload.blobStore, latestCheckpoint, !cancelled && !nonStreamError, "nonstream", requestId, conversation);
    const settle = () => {
      if (settled) return;
      settled = true;
      transportWatchdog.stop();
      upstreamWatchdog.stop();
      req.removeListener("close", onClientClose);
      res.removeListener("close", onClientClose);
      commitCheckpoint();
      if (cancelled) {
        if (!res.headersSent) {
          res.writeHead(499, {
            "Content-Type": "application/json"
          });
          res.end(JSON.stringify({
            error: {
              message: "Client closed request",
              type: "aborted",
              code: "client_closed"
            }
          }));
        }
        endBridge();
        resolve();
        return;
      }
      if (nonStreamError) {
        res.writeHead(502, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: nonStreamError.message,
            type: "upstream_error",
            code: "cursor_error"
          }
        }));
        endBridge();
        resolve();
        return;
      }
      const flushed = tagFilter.flush();
      fullText += flushed.content;
      appendAssistantTextToTurn(currentTurn, flushed.content);
      const usage = computeUsage(state);
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(completionResponse(identity, { role: "assistant", content: fullText }, "stop", usage)));
      endBridge();
      resolve();
    };
    const stalled = (kind, silentForMs) => {
      if (settled) return;
      discardConversation();
      nonStreamError = new Error(`Cursor Run stalled: no ${kind} for ${formatStallDuration(silentForMs)}`);
      settle();
    };
    const transportWatchdog = startUpstreamWatchdog(ms => stalled("upstream frames", ms), resolveTransportStallTimeoutMs());
    const upstreamWatchdog = startUpstreamWatchdog(ms => stalled("useful output", ms), resolveUpstreamStallTimeoutMs());
    bridge.onData(createConnectFrameParser(messageBytes => {
      if (settled || cancelled || !ownsConversation()) return;
      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
        transportWatchdog.touch();
        const classified = processServerMessage(serverMessage, payload.blobStore, payload.mcpTools, data => bridge.write(data), state, (text, isThinking) => {
          if (isThinking) return;
          const {
            content
          } = tagFilter.process(text);
          fullText += content;
          appendAssistantTextToTurn(currentTurn, content);
        }, exec => {
          resumePendingExecWithToolResult(exec, "Tools are not available on this non-streaming request.", true, data => bridge.write(data));
        }, checkpointBytes => {
          latestCheckpoint = checkpointBytes;
          commitConversationCheckpoint(convKey, payload.blobStore, checkpointBytes, true, "nonstream_buffered", requestId, conversation);
          debugLog("nonstream.checkpoint_buffered", {
            requestId,
            convKey,
            checkpointBytes
          });
        }, () => {
          debugLog("nonstream.turn_ended", {
            requestId,
            convKey
          });
          settle();
        });
        // Nonstream requests reject tools locally; rejected execs cannot renew useful output.
        if (classified.countsAsProgress && classified.kind === "visible") upstreamWatchdog.touch();
      } catch (err) {
        debugLog("nonstream.decode_error", { requestId, error: String(err) });
        discardConversation();
        nonStreamError = new Error("Cursor response message could not be processed");
        settle();
      }
    }, endStreamBytes => {
      if (settled || cancelled || !ownsConversation()) return;
      nonStreamError = parseConnectEndStream(endStreamBytes) ?? new Error("Cursor Run ended before turnEnded");
      debugLog("nonstream.upstream_error", { requestId, message: nonStreamError.message });
      discardConversation();
      settle();
    }));
    bridge.onClose(code => {
      if (!settled && !cancelled) {
        discardConversation();
        nonStreamError = new Error(code === 0 ? "Cursor Run ended before turnEnded" : "Bridge connection lost");
      }
      debugLog("nonstream.bridge_close", {
        requestId,
        convKey,
        cancelled,
        settled,
        nonStreamError: nonStreamError?.message,
        currentTurn,
        latestCheckpoint
      });
      settle();
    });
  });
}
