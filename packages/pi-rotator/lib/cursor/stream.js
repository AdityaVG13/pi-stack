/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed SSE protocol retained; see PROVENANCE.json. */
// Streaming writer: coalesce tools, stop at turnEnded and distinguish progress from transport.
import { debugLog } from "./debug.js";
import { startSSEResponse } from "./sse-keepalive.js";
import { formatStallDuration, startUpstreamWatchdog, resolveTransportStallTimeoutMs, resolveUpstreamStallTimeoutMs } from "./upstream-watchdog.js";
import { resumePendingExecWithToolResult } from "./native-results.js";
import { cleanupBridge, activeBridges, conversationStates, commitConversationCheckpoint, forgetConversation } from "./conversation-registry.js";
import { computeUsage } from "./prompt-usage.js";
import { resolveToolCallCoalesceMs, NATIVE_TOOL_UNAVAILABLE } from "./stream-lifecycle.js";
import { appendAssistantTextToTurn } from "./request.js";
import { parseToolCallArguments } from "./message-parsing.js";
import { createConnectFrameParser, parseConnectEndStream } from "./frames.js";
import { fromBinary } from "@bufbuild/protobuf";
import { AgentServerMessageSchema } from "./proto/agent_pb.cjs";
import { processServerMessage } from "./server-messages.js";
import { completionIdentity, completionChunk, completionUsage, completionToolCall } from "./completion.js";

const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'think_intent'];

const MAX_THINKING_TAG_LEN = 16;

export function createThinkingTagFilter() {
  let buffer = "";
  let inThinking = false;
  return {
    process(text) {
      const input = buffer + text;
      buffer = "";
      const output = { content: "", reasoning: "" };
      const append = value => { output[inThinking ? "reasoning" : "content"] += value; };
      let lastIndex = 0;
      const tags = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`, "gi");
      let match;
      while ((match = tags.exec(input)) !== null) {
        append(input.slice(lastIndex, match.index));
        inThinking = match[1] !== "/";
        lastIndex = tags.lastIndex;
      }
      const rest = input.slice(lastIndex);
      const prefix = rest.lastIndexOf("<");
      const candidate = rest.slice(prefix).trimEnd();
      if (prefix >= 0 && candidate.length < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(candidate)) {
        buffer = rest.slice(prefix);
        append(rest.slice(0, prefix));
      } else {
        append(rest);
      }
      return output;
    },
    flush() {
      const remaining = buffer;
      buffer = "";
      return { content: inThinking ? "" : remaining, reasoning: inThinking ? remaining : "" };
    },
  };
}

export function writeSSEStream(bridge, heartbeatTimer, blobStore, mcpTools, modelId, bridgeKey, convKey, completedTurns, currentTurn, req, res, requestId, promptTokenEstimate = 0) {
  debugLog("stream.writer_start", {
    requestId,
    bridgeKey,
    convKey,
    modelId,
    completedTurnCount: completedTurns.length,
    currentTurn
  });
  const conversation = conversationStates.get(convKey);
  const ownsConversation = () => conversationStates.get(convKey) === conversation;
  const discardConversation = () => { if (ownsConversation()) forgetConversation(convKey); };
  const identity = completionIdentity(modelId);
  
  const stopKeepalive = startSSEResponse(res);
  let closed = false;
  let turnFinished = false;
  let coalesceTimer;
  const clearCoalesceTimer = () => {
    if (!coalesceTimer) return;
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
  };
  const sendSSE = data => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const sendDone = () => {
    if (closed) return;
    res.write("data: [DONE]\n\n");
  };
  const closeResponse = () => {
    if (closed) return;
    closed = true;
    clearCoalesceTimer();
    stopKeepalive();
    transportWatchdog.stop();
    upstreamWatchdog.stop();
    res.end();
  };
  const makeChunk = (delta, finishReason = null) => completionChunk(identity, delta, finishReason);
  const failRun = message => {
    // Closing an SSE for tools pauses the Run; only turnEnded establishes success.
    if (cancelled || turnFinished) return;
    cancelled = true;
    discardConversation();
    // An invalid finish_reason makes the host discard the actual failure message.
    sendSSE({ error: { message, type: "upstream_error", code: "cursor_error" } });
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
  };
  const failStalledRun = (kind, silentForMs) => {
    if (closed) return;
    const missing = kind === "transport" ? "upstream frames" : "useful output";
    const message = `Cursor Run stalled: no ${missing} for ${formatStallDuration(silentForMs)}; stream timed out`;

    debugLog("stream.upstream_stall", {
      requestId,
      bridgeKey,
      convKey,
      modelId,
      kind,
      silentForMs
    });
    failRun(message);
  };

  // A decoded housekeeping frame proves the HTTP/2 transport is alive, but only
  // visible tokens or a Pi-bound tool prove the model is making useful progress.
  const transportWatchdog = startUpstreamWatchdog(silentForMs => failStalledRun("transport", silentForMs), resolveTransportStallTimeoutMs());
  const upstreamWatchdog = startUpstreamWatchdog(silentForMs => failStalledRun("useful_output", silentForMs), resolveUpstreamStallTimeoutMs());
  const makeUsageChunk = () => completionUsage(identity, computeUsage(state));
  const state = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    promptTokenEstimate
  };
  const tagFilter = createThinkingTagFilter();
  let mcpExecReceived = false;
  let toolCallsFlushed = false;
  let cancelled = false;
  let latestCheckpoint = null;
  const coalesceMs = resolveToolCallCoalesceMs();
  const flushPiToolCalls = () => {
    clearCoalesceTimer();
    if (closed || cancelled || toolCallsFlushed || state.pendingExecs.length === 0) return;
    // The coalescing timer may outlive this Run even though its input frame was owned.
    if (!ownsConversation()) return failRun("Cursor Run was superseded before tool delivery");
    toolCallsFlushed = true;
    mcpExecReceived = true;
    const flushed = tagFilter.flush();
    if (flushed.reasoning) sendSSE(makeChunk({
      reasoning_content: flushed.reasoning
    }));
    if (flushed.content) {
      appendAssistantTextToTurn(currentTurn, flushed.content);
      sendSSE(makeChunk({
        content: flushed.content
      }));
    }
    for (const exec of state.pendingExecs) {
      const toolCallIndex = state.toolCallIndex++;
      sendSSE(makeChunk({ tool_calls: [completionToolCall(exec, toolCallIndex)] }));
    }
    activeBridges.set(bridgeKey, {
      bridge,
      heartbeatTimer,
      blobStore,
      mcpTools,
      pendingExecs: state.pendingExecs,
      currentTurn
    });
    debugLog("stream.tool_call_pause", {
      requestId,
      bridgeKey,
      pendingExecs: state.pendingExecs,
      currentTurn
    });
    sendSSE(makeChunk({}, "tool_calls"));
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
  };
  const queuePiTool = exec => {
    if (closed || cancelled || toolCallsFlushed) {
      debugLog("stream.late_exec_rejected", {
        requestId,
        bridgeKey,
        exec
      });
      resumePendingExecWithToolResult(exec, NATIVE_TOOL_UNAVAILABLE, true, data => bridge.write(data));
      return;
    }
    state.pendingExecs.push(exec);
    mcpExecReceived = true;
    currentTurn.steps.push({
      kind: "toolCall",
      toolCallId: exec.toolCallId,
      toolName: exec.toolName,
      arguments: parseToolCallArguments(exec.decodedArgs)
    });
    clearCoalesceTimer();
    coalesceTimer = setTimeout(flushPiToolCalls, coalesceMs);
    coalesceTimer.unref?.();
  };
  const finishOpenAITurn = () => {
    if (closed || mcpExecReceived) return;
    turnFinished = true;
    const flushed = tagFilter.flush();
    if (flushed.reasoning) sendSSE(makeChunk({
      reasoning_content: flushed.reasoning
    }));
    if (flushed.content) {
      appendAssistantTextToTurn(currentTurn, flushed.content);
      sendSSE(makeChunk({
        content: flushed.content
      }));
    }
    sendSSE(makeChunk({}, "stop"));
    sendSSE(makeUsageChunk());
    sendDone();
    closeResponse();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
  };

  // Detect client disconnect (e.g. user pressed Escape in pi)
  const onClientClose = () => {
    if (cancelled || closed) return;
    debugLog("stream.client_close", {
      requestId,
      bridgeKey,
      convKey
    });
    cancelled = true;
    discardConversation();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
    closeResponse();
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);
  const processChunk = createConnectFrameParser(messageBytes => {
    if (cancelled || !ownsConversation()) return;
    try {
      const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
      transportWatchdog.touch();
      const classified = processServerMessage(serverMessage, blobStore, mcpTools, data => bridge.write(data), state, (text, isThinking) => {
        if (isThinking) {
          sendSSE(makeChunk({
            reasoning_content: text
          }));
        } else {
          const {
            content,
            reasoning
          } = tagFilter.process(text);
          if (reasoning) sendSSE(makeChunk({
            reasoning_content: reasoning
          }));
          if (content) {
            appendAssistantTextToTurn(currentTurn, content);
            sendSSE(makeChunk({
              content
            }));
          }
        }
      }, exec => {
        queuePiTool(exec);
      }, checkpointBytes => {
        latestCheckpoint = checkpointBytes;
        commitConversationCheckpoint(convKey, blobStore, checkpointBytes, true, "stream_buffered", requestId, conversation);
        debugLog("stream.checkpoint_buffered", {
          requestId,
          convKey,
          checkpointBytes
        });
      }, () => {
        debugLog("stream.turn_ended", {
          requestId,
          bridgeKey,
          convKey,
          mcpExecReceived,
          closed
        });
        finishOpenAITurn();
      });
      if (classified.countsAsProgress) upstreamWatchdog.touch();
    } catch (err) {
      debugLog("stream.decode_error", { requestId, error: String(err) });
      failRun("Cursor stream message could not be processed");
    }
  }, endStreamBytes => {
    if (cancelled || turnFinished || !ownsConversation()) return;
    const endError = parseConnectEndStream(endStreamBytes);
    failRun(endError?.message ?? "Cursor Run ended before turnEnded");
  });
  bridge.onData(processChunk);
  bridge.onClose(code => {
    debugLog("stream.bridge_close", {
      requestId,
      bridgeKey,
      convKey,
      code,
      cancelled,
      mcpExecReceived,
      toolCallsFlushed,
      currentTurn,
      latestCheckpoint
    });
    clearCoalesceTimer();
    transportWatchdog.stop();
    upstreamWatchdog.stop();
    clearInterval(heartbeatTimer);
    req.removeListener("close", onClientClose);
    res.removeListener("close", onClientClose);
    commitConversationCheckpoint(convKey, blobStore, latestCheckpoint, !cancelled && turnFinished, "stream", requestId, conversation);
    if (cancelled || turnFinished) return;
    // A clean process exit proves transport completion, not model-turn completion.
    if (activeBridges.get(bridgeKey)?.bridge === bridge) activeBridges.delete(bridgeKey);
    failRun(code === 0 ? "Cursor Run ended before turnEnded" : "Bridge connection lost");
  });
}

export function writeSSEStreamForTests(args) {
  writeSSEStream(args.bridge, args.heartbeatTimer, args.blobStore ?? new Map(), args.mcpTools ?? [], args.modelId, args.bridgeKey, args.convKey, args.completedTurns, args.currentTurn, args.req, args.res, args.requestId, args.promptTokenEstimate ?? 0);
}
