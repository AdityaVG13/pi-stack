/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed frame protocol retained; see PROVENANCE.json. */
// Connect framing and client replies. Terminal shell replies also close the exec RPC.
import { create, toBinary } from "@bufbuild/protobuf";
import { KvClientMessageSchema, AgentClientMessageSchema, ExecClientMessageSchema, ExecClientControlMessageSchema, ExecClientStreamCloseSchema, ConversationActionSchema, CancelActionSchema, ClientHeartbeatSchema } from "./proto/agent_pb.cjs";
import { debugLog } from "./debug.js";

const CONNECT_END_STREAM_FLAG = 0b00000010;

export function frameConnectMessage(data, flags = 0) {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

export function sendKvResponse(kvMsg, messageCase, value, sendFrame) {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: {
      case: messageCase,
      value: value
    }
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: {
      case: "kvClientMessage",
      value: response
    }
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

export function sendExecResult(execMsg, messageCase, value, sendFrame) {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: {
      case: messageCase,
      value: value
    }
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: {
      case: "execClientMessage",
      value: execClientMessage
    }
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
  if (messageCase === "shellStream") {
    const event = value.event.case;
    if (event === "exit" || event === "rejected" || event === "permissionDenied" || event === "backgrounded") {
      // The exit event describes the process, not the end of the streaming exec
      // RPC. Without streamClose Cursor keeps draining that RPC forever while
      // Run heartbeats continue, so Pi stalls after an already completed bash.
      sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
        message: {
          case: "execClientControlMessage",
          value: create(ExecClientControlMessageSchema, {
            message: {
              case: "streamClose",
              value: create(ExecClientStreamCloseSchema, {
                id: execMsg.id
              })
            }
          })
        }
      }))));
      debugLog("exec.stream_closed", {
        execMsgId: execMsg.id,
        execId: execMsg.execId,
        terminalEvent: event
      });
    }
  }
}

export function sendPendingExecResult(exec, value, sendFrame) {
  sendExecResult({
    id: exec.execMsgId,
    execId: exec.execId
  }, exec.resultCase ?? "mcpResult", value, sendFrame);
}

export function sendCancelAction(bridge) {
  debugLog("bridge.cancel_action", {});
  const action = create(ConversationActionSchema, {
    action: {
      case: "cancelAction",
      value: create(CancelActionSchema, {})
    }
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: {
      case: "conversationAction",
      value: action
    }
  });
  bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

export function createConnectFrameParser(onMessage, onEndStream) {
  let pending = Buffer.alloc(0);
  let start = 0;
  let end = 0;
  return incoming => {
    const remaining = end - start;
    if (pending.length - end < incoming.length) {
      const required = remaining + incoming.length;
      if (required > pending.length) {
        const grown = Buffer.allocUnsafe(Math.max(required, pending.length * 2));
        pending.copy(grown, 0, start, end);
        pending = grown;
      } else {
        pending.copy(pending, 0, start, end);
      }
      start = 0;
      end = remaining;
    }
    pending.set(incoming, end);
    end += incoming.length;
    while (end - start >= 5) {
      const flags = pending[start];
      const frameEnd = start + 5 + pending.readUInt32BE(start + 1);
      if (end < frameEnd) break;
      let messageBytes = pending.subarray(start + 5, frameEnd);
      start = frameEnd;
      // Advance/release before reentrant callbacks; retained bytes cannot share reusable storage.
      if (start === end) {
        pending = Buffer.alloc(0);
        start = 0;
        end = 0;
      } else {
        messageBytes = Buffer.from(messageBytes);
      }
      if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);else onMessage(messageBytes);
    }
  };
}

export function parseConnectEndStream(data) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) return new Error(`Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`);
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

export function makeHeartbeatBytes() {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: "clientHeartbeat",
      value: create(ClientHeartbeatSchema, {})
    }
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}
