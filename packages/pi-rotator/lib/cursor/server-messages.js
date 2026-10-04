/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed server protocol retained; see PROVENANCE.json. */
// Incoming protocol dispatch; only visible text and Pi-bound tools count as progress.
import { create, toBinary } from "@bufbuild/protobuf";
import * as proto from "./proto/agent_pb.cjs";
import { classifyCursorFrame, interactionQueryResultCase, NATIVE_TOOL_UNAVAILABLE } from "./stream-lifecycle.js";
import { debugLog } from "./debug.js";
import { handleExecMessage } from "./exec.js";
import { sendKvResponse, frameConnectMessage } from "./frames.js";

const TEXT_UPDATES = new Map([["textDelta", false], ["thinkingDelta", true]]);
function applyUpdate(update, context) {
  const kind = update.message?.case;
  const thinking = TEXT_UPDATES.get(kind);
  if (thinking !== undefined) {
    const text = update.message.value.text || "";
    if (text) context.onText(text, thinking);
    else context.classified.countsAsProgress = false;
  } else if (kind === "tokenDelta") {
    const tokens = update.message.value.tokens ?? 0;
    context.state.outputTokens += tokens;
    if (tokens <= 0) context.classified.countsAsProgress = false;
  } else if (kind === "turnEnded") {
    context.onTurnEnded?.();
  }
}

function applyExec(exec, context) {
  if (!handleExecMessage(exec, context.mcpTools, context.sendFrame, context.onMcpExec)) {
    context.classified.countsAsProgress = false;
    return;
  }
  context.classified = { kind: exec.message?.case === "mcpArgs" ? "mcpExec" : "nativeExec", countsAsProgress: true, completesTurn: false };
}

function saveCheckpoint(checkpoint, context) {
  if (checkpoint.tokenDetails) context.state.totalTokens = checkpoint.tokenDetails.usedTokens;
  if (context.onCheckpoint) context.onCheckpoint(toBinary(proto.ConversationStateStructureSchema, checkpoint));
}

const SERVER_MESSAGES = new Map([
  ["interactionUpdate", applyUpdate], ["execServerMessage", applyExec], ["conversationCheckpointUpdate", saveCheckpoint],
  ["kvServerMessage", (value, context) => handleKvMessage(value, context.blobStore, context.sendFrame)],
  ["interactionQuery", (value, context) => handleInteractionQuery(value, context.sendFrame)],
  ["execServerControlMessage", value => debugLog("exec.control", { control: value.message?.case })],
]);

export function processServerMessage(msg, blobStore, mcpTools, sendFrame, state, onText, onMcpExec, onCheckpoint, onTurnEnded) {
  const msgCase = msg.message.case;
  const updateCase = msgCase === "interactionUpdate" ? msg.message.value.message?.case : undefined;
  const execCase = msgCase === "execServerMessage" ? msg.message.value.message?.case : undefined;
  const classified = classifyCursorFrame({ messageCase: msgCase, updateCase, execCase });
  debugLog("server_message", { msgCase, updateCase, execCase, classified });
  const context = { blobStore, mcpTools, sendFrame, state, onText, onMcpExec, onCheckpoint, onTurnEnded, classified };
  SERVER_MESSAGES.get(msgCase)?.(msg.message.value, context);
  return context.classified;
}

function handleKvMessage(kvMsg, blobStore, sendFrame) {
  const kind = kvMsg.message.case;
  const value = kvMsg.message.value;
  if (kind === "getBlobArgs") {
    const key = Buffer.from(value.blobId).toString("hex");
    const blobData = blobStore.get(key);
    if (!blobData) debugLog("kv.blob_miss", { blobIdKey: key, knownBlobs: blobStore.size });
    sendKvResponse(kvMsg, "getBlobResult", create(proto.GetBlobResultSchema, blobData ? { blobData } : {}), sendFrame);
  } else if (kind === "setBlobArgs") {
    blobStore.set(Buffer.from(value.blobId).toString("hex"), value.blobData);
    sendKvResponse(kvMsg, "setBlobResult", create(proto.SetBlobResultSchema, {}), sendFrame);
  }
}

const QUERY_REJECTIONS = new Map([
  ["webSearchRequestResponse", [proto.WebSearchRequestResponseSchema, proto.WebSearchRequestResponse_RejectedSchema]],
  ["switchModeRequestResponse", [proto.SwitchModeRequestResponseSchema, proto.SwitchModeRequestResponse_RejectedSchema]],
  ["exaSearchRequestResponse", [proto.ExaSearchRequestResponseSchema, proto.ExaSearchRequestResponse_RejectedSchema]],
  ["exaFetchRequestResponse", [proto.ExaFetchRequestResponseSchema, proto.ExaFetchRequestResponse_RejectedSchema]],
]);
const QUERY_RESPONSES = new Map([
  ["askQuestionInteractionResponse", () => create(proto.AskQuestionInteractionResponseSchema, { result: create(proto.AskQuestionResultSchema, { result: { case: "rejected", value: create(proto.AskQuestionRejectedSchema, { reason: NATIVE_TOOL_UNAVAILABLE }) } }) })],
  ["createPlanRequestResponse", () => create(proto.CreatePlanRequestResponseSchema, { result: create(proto.CreatePlanResultSchema, { planUri: "", result: { case: "error", value: create(proto.CreatePlanErrorSchema, { error: NATIVE_TOOL_UNAVAILABLE }) } }) })],
  ["setupVmEnvironmentResult", () => create(proto.SetupVmEnvironmentResultSchema, { result: { case: "success", value: create(proto.SetupVmEnvironmentSuccessSchema, {}) } })],
]);

function interactionResult(kind) {
  const schemas = QUERY_REJECTIONS.get(kind);
  if (!schemas) return QUERY_RESPONSES.get(kind)?.();
  const [outer, inner] = schemas;
  return create(outer, { result: { case: "rejected", value: create(inner, { reason: NATIVE_TOOL_UNAVAILABLE }) } });
}

function handleInteractionQuery(query, sendFrame) {
  const queryCase = query.query.case;
  const kind = interactionQueryResultCase(queryCase);
  const value = interactionResult(kind);
  if (!value) return debugLog("interaction_query.unhandled", { queryCase });
  const response = create(proto.InteractionResponseSchema, { id: query.id, result: { case: kind, value } });
  sendFrame(frameConnectMessage(toBinary(proto.AgentClientMessageSchema, create(proto.AgentClientMessageSchema, { message: { case: "interactionResponse", value: response } }))));
}
