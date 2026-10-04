/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed request protocol retained; see PROVENANCE.json. */
// Cursor request/history blobs and tool argument codecs. Session identity stays stable.
import { toBinary, fromJson, create, fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { McpToolDefinitionSchema, UserMessageSchema, SelectedContextSchema, ConversationStepSchema, AssistantMessageSchema, McpToolCallSchema, McpArgsSchema, McpResultSchema, McpErrorSchema, McpSuccessSchema, McpToolResultContentItemSchema, McpTextContentSchema, ToolCallSchema, ConversationStateStructureSchema, AgentConversationTurnStructureSchema, ConversationTurnStructureSchema, ConversationActionSchema, UserMessageActionSchema, ModelDetailsSchema, AgentRunRequestSchema, AgentClientMessageSchema } from "./proto/agent_pb.cjs";
import { createHash } from "node:crypto";
import { debugLog } from "./debug.js";

export function getTurnToolCallResults(turn) {
  const results = new Map();
  for (const step of turn.steps) {
    if (step.kind === "toolCall" && step.result) results.set(step.toolCallId, step.result);
  }
  return results;
}

export function appendAssistantTextToTurn(turn, text) {
  if (!text) return;
  const last = turn.steps.at(-1);
  if (last?.kind === "assistantText") {
    last.text += text;
  } else {
    turn.steps.push({
      kind: "assistantText",
      text
    });
  }
}

export function buildMcpToolDefinitions(tools) {
  return tools.map(t => {
    const fn = t.function;
    const jsonSchema = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {
      type: "object",
      properties: {},
      required: []
    };
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "pi",
      toolName: fn.name,
      inputSchema
    });
  });
}

function decodeMcpArgValue(value) {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {}
  return new TextDecoder().decode(value);
}

// Argument names are JSON data, including __proto__; never assign into {}.
export function decodeMcpArgsMap(args) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, decodeMcpArgValue(value)]));
}

function encodeMcpArgValue(value) {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value));
  } catch {
    return new TextEncoder().encode(String(value));
  }
}

function encodeMcpArgsMap(args) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, encodeMcpArgValue(value)]));
}

function buildSelectedContextBlob(rootPromptBlobIds, clientName) {
  const parts = [];
  for (const blobId of rootPromptBlobIds) {
    parts.push(new Uint8Array([0x0A, blobId.length, ...blobId]));
  }
  const clientBytes = new TextEncoder().encode(clientName);
  parts.push(new Uint8Array([0xB2, 0x01, clientBytes.length, ...clientBytes]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function storeAsBlob(data, blobStore) {
  const id = new Uint8Array(createHash("sha256").update(data).digest());
  blobStore.set(Buffer.from(id).toString("hex"), data);
  return id;
}

function createUserMessage(text, selectedContextBlob) {
  const messageId = crypto.randomUUID();
  return create(UserMessageSchema, {
    text,
    messageId,
    selectedContext: create(SelectedContextSchema, {}),
    mode: 1,
    selectedContextBlob,
    correlationId: messageId
  });
}

function buildTurnStepBytes(step) {
  if (step.kind === "assistantText") {
    return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: "assistantMessage",
        value: create(AssistantMessageSchema, {
          text: step.text
        })
      }
    }));
  }
  const toolName = step.toolName || "tool";
  const mcpToolCall = create(McpToolCallSchema, {
    args: create(McpArgsSchema, {
      name: toolName,
      args: encodeMcpArgsMap(step.arguments),
      toolCallId: step.toolCallId,
      providerIdentifier: "pi",
      toolName
    }),
    ...(step.result && {
      result: create(McpResultSchema, {
        result: step.result.isError ? {
          case: "error",
          value: create(McpErrorSchema, {
            error: step.result.content
          })
        } : {
          case: "success",
          value: create(McpSuccessSchema, {
            content: [create(McpToolResultContentItemSchema, {
              content: {
                case: "text",
                value: create(McpTextContentSchema, {
                  text: step.result.content
                })
              }
            })],
            isError: false
          })
        }
      })
    })
  });
  return toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "toolCall",
      value: create(ToolCallSchema, {
        tool: {
          case: "mcpToolCall",
          value: mcpToolCall
        }
      })
    }
  }));
}

export function buildCursorRequest(modelId, systemPrompt, userText, turns, conversationId, checkpoint, existingBlobStore) {
  debugLog("cursor_request.build.start", {
    modelId,
    systemPrompt,
    userText,
    turns,
    conversationId,
    checkpoint,
    existingBlobStore
  });
  const blobStore = new Map(existingBlobStore ?? []);
  const systemBytes = new TextEncoder().encode(JSON.stringify({
    role: "system",
    content: systemPrompt
  }));
  const systemBlobId = storeAsBlob(systemBytes, blobStore);
  const selectedCtxBlob = storeAsBlob(buildSelectedContextBlob([systemBlobId], "pi"), blobStore);
  let conversationState;
  if (checkpoint) {
    conversationState = fromBinary(ConversationStateStructureSchema, checkpoint);
  } else {
    const turnBlobIds = [];
    for (const turn of turns) {
      const userMsg = createUserMessage(turn.userText, selectedCtxBlob);
      const userMsgBlobId = storeAsBlob(toBinary(UserMessageSchema, userMsg), blobStore);
      const stepBlobIds = turn.steps.map(s => storeAsBlob(buildTurnStepBytes(s), blobStore));
      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: userMsgBlobId,
        steps: stepBlobIds,
        requestId: crypto.randomUUID()
      });
      const turnStructure = create(ConversationTurnStructureSchema, {
        turn: {
          case: "agentConversationTurn",
          value: agentTurn
        }
      });
      turnBlobIds.push(storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore));
    }
    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [systemBlobId],
      turns: turnBlobIds,
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [`file://${process.cwd()}`],
      mode: 1,
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      selfSummaryCount: 0,
      readPaths: [],
      clientName: "pi"
    });
  }
  const userMessage = createUserMessage(userText, selectedCtxBlob);
  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, {
        userMessage
      })
    }
  });
  const modelDetails = create(ModelDetailsSchema, {
    modelId,
    displayModelId: modelId,
    displayName: modelId
  });
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    conversationId
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: {
      case: "runRequest",
      value: runRequest
    }
  });
  const payload = {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    mcpTools: []
  };
  debugLog("cursor_request.build.end", payload);
  return payload;
}
