/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed native-tool input coercion/omission retained; see PROVENANCE.json. */
// Only visible deltas and Pi-bound tools renew the progress watchdog. Checkpoints,
// blob traffic, rejected tools and heartbeats never hide a stalled upstream turn.
export const NATIVE_TOOL_UNAVAILABLE = "Tool not available in this environment. Use the MCP tools provided instead.";
export const TOOL_CALL_COALESCE_MS = 75;

export function resolveToolCallCoalesceMs(env = process.env) {
  const raw = env.PI_CURSOR_TOOL_COALESCE_MS?.trim();
  if (raw === undefined || raw === "") return TOOL_CALL_COALESCE_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647 ? parsed : TOOL_CALL_COALESCE_MS;
}

const frame = (kind, countsAsProgress = false, completesTurn = false) => ({ kind, countsAsProgress, completesTurn });
const UPDATES = new Map([
  [undefined, frame("heartbeat")], ["heartbeat", frame("heartbeat")],
  ["", frame("heartbeat")], ["turnEnded", frame("turnEnded", false, true)],
  ...["textDelta", "thinkingDelta", "tokenDelta"].map(key => [key, frame("visible", true)]),
]);
const MESSAGE_KINDS = new Map([
  ["kvServerMessage", "housekeeping"], ["conversationCheckpointUpdate", "housekeeping"],
  ["interactionQuery", "interactionQuery"], ["execServerControlMessage", "execControl"],
]);

function execFrame(execCase) {
  if (execCase === "mcpArgs") return frame("mcpExec", true);
  return frame(["requestContextArgs", "diagnosticsArgs"].includes(execCase) ? "housekeeping" : "nativeExec");
}

export function classifyCursorFrame({ messageCase, updateCase, execCase }) {
  if (messageCase === "interactionUpdate") return { ...(UPDATES.get(updateCase || undefined) || frame("housekeeping")) };
  if (messageCase === "execServerMessage") return execFrame(execCase);
  return frame(MESSAGE_KINDS.get(messageCase) || "unknown");
}

function quote(value) { return `'${value.replace(/'/g, `'\\''`)}'`; }
function asString(value) { return typeof value === "string" ? value : String(value ?? ""); }
const tool = (toolName, args, resultCase) => ({ toolName, args, resultCase });

function grepTool(args) {
  const forwarded = { pattern: asString(args.pattern) };
  if (args.path) forwarded.path = args.path;
  if (args.glob) forwarded.glob = args.glob;
  if (args.caseInsensitive) forwarded.ignoreCase = true;
  return tool("grep", forwarded, "grepResult");
}

function shellTool(args, resultCase) {
  const command = asString(args.command);
  // Pi Bash has no cwd parameter; fail closed if the requested directory is absent.
  return tool("bash", { command: args.workingDirectory ? `cd -- ${quote(asString(args.workingDirectory))} && (\n${command}\n)` : command }, resultCase);
}

const NATIVE_TOOLS = new Map([
  ["readArgs", ["read", args => tool("read", { path: asString(args.path) }, "readResult")]],
  ["writeArgs", ["write", args => tool("write", { path: asString(args.path), content: asString(args.fileText ?? args.content) }, "writeResult")]],
  ["grepArgs", ["grep", grepTool]],
  ["lsArgs", ["ls", args => tool("ls", { path: asString(args.path) }, "lsResult")]],
  ["shellArgs", ["bash", args => shellTool(args, "shellResult")]],
  ["shellStreamArgs", ["bash", args => shellTool(args, "shellStream")]],
]);
const UNSUPPORTED_SEARCH_OPTIONS = ["multiline", "type", "sort", "context", "contextBefore", "contextAfter", "headLimit"];

const BASH_FALLBACKS = new Map([
  ["readArgs", args => tool("bash", { command: `cat -- ${quote(asString(args.path))}` }, "readResult")],
  ["grepArgs", args => tool("bash", { command: `rg --line-number --with-filename --color never${args.caseInsensitive ? " --ignore-case" : ""}${args.glob ? ` --glob ${quote(asString(args.glob))}` : ""} -e ${quote(asString(args.pattern))} -- ${quote(asString(args.path || "."))}; status=$?; if [ "$status" -eq 1 ]; then exit 0; else exit "$status"; fi` }, "grepResult")],
  ["lsArgs", args => tool("bash", { command: `ls -1Ap -- ${quote(asString(args.path || "."))}` }, "lsResult")],
  ["deleteArgs", args => tool("bash", { command: `rm -f -- ${quote(asString(args.path))}` }, "deleteResult")],
]);

// Prefer native Pi tools; shell fallbacks are used only when Pi exposed bash.
// Unsupported execs remain rejected rather than executing Cursor's own tools.
export function mapNativeExecToPiTool(execCase, args, availableTools) {
  // Text-only Pi writes cannot preserve binary payloads. Search modes that cannot
  // be represented by the Pi tool/result contract must use the advertised MCP tools.
  if (execCase === "writeArgs" && args.fileBytes?.length) return undefined;
  if (execCase === "lsArgs" && (args.ignore?.length || args.timeoutMs !== undefined)) return undefined;
  if (["shellArgs", "shellStreamArgs"].includes(execCase) && (args.timeout || args.hardTimeout || args.isBackground)) return undefined;
  if (execCase === "grepArgs" && (args.outputMode && args.outputMode !== "content" ||
    args.sortAscending !== undefined || UNSUPPORTED_SEARCH_OPTIONS.some(option => args[option]))) return undefined;
  const tools = availableTools instanceof Set ? availableTools : new Set(availableTools);
  const preferred = NATIVE_TOOLS.get(execCase);
  if (preferred && tools.has(preferred[0])) return preferred[1](args);
  const fallback = BASH_FALLBACKS.get(execCase)?.(args);
  return tools.has("bash") ? fallback : undefined;
}

const QUERY_RESULTS = new Map([
  ["webSearchRequestQuery", "webSearchRequestResponse"], ["askQuestionInteractionQuery", "askQuestionInteractionResponse"],
  ["switchModeRequestQuery", "switchModeRequestResponse"], ["exaSearchRequestQuery", "exaSearchRequestResponse"],
  ["exaFetchRequestQuery", "exaFetchRequestResponse"], ["createPlanRequestQuery", "createPlanRequestResponse"],
  ["setupVmEnvironmentArgs", "setupVmEnvironmentResult"],
]);
export function interactionQueryResultCase(queryCase) { return QUERY_RESULTS.get(queryCase); }

// Internal boundary extracted from proxy.js. See README source map.
import { resolveCursorUsage } from "./prompt-usage.js";
import { completionIdentity, completionToolCall, completionResponse, completionChunk, completionUsage } from "./completion.js";

export function respondWithPendingToolCalls(modelId, pendingExecs, stream, res, promptTokenEstimate = 0) {
  const identity = completionIdentity(modelId);
  const usage = resolveCursorUsage({ outputTokens: 0, totalTokens: 0, promptTokenEstimate });
  const toolCalls = pendingExecs.map(completionToolCall);
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(completionResponse(identity, { role: "assistant", content: null, tool_calls: toolCalls }, "tool_calls", usage)));
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  for (const toolCall of toolCalls) send(completionChunk(identity, { tool_calls: [toolCall] }));
  send(completionChunk(identity, {}, "tool_calls"));
  send(completionUsage(identity, usage));
  res.write("data: [DONE]\n\n");
  res.end();
}
