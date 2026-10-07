/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed exec protocol retained; see PROVENANCE.json. */
// Cursor tool requests either map onto exposed Pi tools or receive a terminal rejection.
import { ReadResultSchema, ReadRejectedSchema, LsResultSchema, LsRejectedSchema, WriteResultSchema, WriteRejectedSchema, DeleteResultSchema, DeleteRejectedSchema, GrepResultSchema, GrepErrorSchema, WriteShellStdinResultSchema, WriteShellStdinErrorSchema, FetchResultSchema, FetchErrorSchema, ShellResultSchema, ShellRejectedSchema, ShellStreamSchema, BackgroundShellSpawnResultSchema, DiagnosticsResultSchema, McpResultSchema, RequestContextSchema, RequestContextResultSchema, RequestContextSuccessSchema, ExecClientControlMessageSchema, ExecClientThrowSchema, AgentClientMessageSchema } from "./proto/agent_pb.cjs";
import { NATIVE_TOOL_UNAVAILABLE, mapNativeExecToPiTool } from "./stream-lifecycle.js";
import { sendExecResult, frameConnectMessage } from "./frames.js";
import { create, toBinary } from "@bufbuild/protobuf";
import { decodeMcpArgsMap } from "./request.js";
import { debugLog } from "./debug.js";

const REJECTED_EXEC = {
  readArgs: ["readResult", ReadResultSchema, "rejected", ReadRejectedSchema, args => ({
    path: args.path
  })],
  lsArgs: ["lsResult", LsResultSchema, "rejected", LsRejectedSchema, args => ({
    path: args.path
  })],
  writeArgs: ["writeResult", WriteResultSchema, "rejected", WriteRejectedSchema, args => ({
    path: args.path
  })],
  deleteArgs: ["deleteResult", DeleteResultSchema, "rejected", DeleteRejectedSchema, args => ({
    path: args.path
  })],
  grepArgs: ["grepResult", GrepResultSchema, "error", GrepErrorSchema],
  writeShellStdinArgs: ["writeShellStdinResult", WriteShellStdinResultSchema, "error", WriteShellStdinErrorSchema],
  fetchArgs: ["fetchResult", FetchResultSchema, "error", FetchErrorSchema, args => ({
    url: args.url ?? ""
  })],
  shellArgs: ["shellResult", ShellResultSchema, "rejected", ShellRejectedSchema, shellRejection],
  shellStreamArgs: ["shellStream", ShellStreamSchema, "rejected", ShellRejectedSchema, shellRejection, "event"],
  backgroundShellSpawnArgs: ["backgroundShellSpawnResult", BackgroundShellSpawnResultSchema, "rejected", ShellRejectedSchema, shellRejection]
};

const EMPTY_EXEC = {
  diagnosticsArgs: ["diagnosticsResult", DiagnosticsResultSchema],
  listMcpResourcesExecArgs: ["listMcpResourcesExecResult", McpResultSchema],
  readMcpResourceExecArgs: ["readMcpResourceExecResult", McpResultSchema],
  recordScreenArgs: ["recordScreenResult", McpResultSchema],
  computerUseArgs: ["computerUseResult", McpResultSchema]
};

function shellRejection(args) {
  return {
    command: args.command ?? "",
    workingDirectory: args.workingDirectory ?? "",
    isReadonly: false
  };
}

function rejectExec(execMsg, sendFrame) {
  const {
    case: execCase,
    value: args
  } = execMsg.message;
  const rejection = REJECTED_EXEC[execCase];
  if (rejection) {
    const [resultCase, schema, status, inner, payload = () => ({}), field = "result"] = rejection;
    const details = {
      ...payload(args),
      reason: NATIVE_TOOL_UNAVAILABLE,
      error: NATIVE_TOOL_UNAVAILABLE
    };
    sendExecResult(execMsg, resultCase, create(schema, {
      [field]: {
        case: status,
        value: create(inner, details)
      }
    }), sendFrame);
    return;
  }
  const empty = EMPTY_EXEC[execCase];
  if (empty) return sendExecResult(execMsg, empty[0], create(empty[1], {}), sendFrame);
  throwUnhandledExec(execMsg, execCase, sendFrame);
}

function requestContextResult(mcpTools) {
  const requestContext = create(RequestContextSchema, {
    rules: [],
    repositoryInfo: [],
    tools: mcpTools,
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [],
    fileContents: {},
    customSubagents: []
  });
  return create(RequestContextResultSchema, {
    result: {
      case: "success",
      value: create(RequestContextSuccessSchema, {
        requestContext
      })
    }
  });
}

function pendingExec(execMsg, details) {
  return {
    execId: execMsg.execId,
    execMsgId: execMsg.id,
    ...details
  };
}

function nativeToolCallId(args) {
  return typeof args.toolCallId === "string" && args.toolCallId ? args.toolCallId : crypto.randomUUID();
}

// Cursor mints dual tool ids ("call-<uuid>-<n>\nfc-<internal>_<i>").
// Cursor keys result frames by exec identity, but proxy-side matching,
// history steps and Pi echo all share this exact string: use the wire
// value verbatim everywhere and never split, trim or re-key it.
export function handleExecMessage(execMsg, mcpTools, sendFrame, onMcpExec) {
  const {
    case: execCase,
    value: args
  } = execMsg.message;
  if (execCase === "requestContextArgs") {
    sendExecResult(execMsg, "requestContextResult", requestContextResult(mcpTools), sendFrame);
    return false;
  }
  if (execCase === "mcpArgs") {
    const toolName = args.toolName || args.name;
    if (!piToolNames(mcpTools).has(toolName) || args.providerIdentifier && args.providerIdentifier !== "pi") {
      rejectExec(execMsg, sendFrame);
      return false;
    }
    onMcpExec(pendingExec(execMsg, {
      toolCallId: args.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify(decodeMcpArgsMap(args.args ?? {})),
      resultCase: "mcpResult"
    }));
    return true;
  }
  const nativeArgs = protoRecord(args);
  const mapped = mapNativeExecToPiTool(String(execCase ?? ""), nativeArgs, piToolNames(mcpTools));
  if (!mapped) {
    rejectExec(execMsg, sendFrame);
    return false;
  }
  onMcpExec(pendingExec(execMsg, {
    toolCallId: nativeToolCallId(nativeArgs),
    toolName: mapped.toolName,
    decodedArgs: JSON.stringify(mapped.args),
    resultCase: mapped.resultCase,
    nativeArgs
  }));
  return true;
}

export function throwUnhandledExec(execMsg, execCase, sendFrame) {
  debugLog("exec.unhandled", { execCase });
  const control = create(ExecClientControlMessageSchema, {
    message: {
      case: "throw",
      value: create(ExecClientThrowSchema, {
        id: execMsg.id,
        error: `${NATIVE_TOOL_UNAVAILABLE} (unhandled ${String(execCase ?? "exec")})`
      })
    }
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
    message: {
      case: "execClientControlMessage",
      value: control
    }
  }))));
}

function protoRecord(value) {
  if (!value || typeof value !== "object") return {};
  return {
    ...value
  };
}

function piToolNames(mcpTools) {
  const names = new Set();
  for (const tool of mcpTools) {
    if (tool.name) names.add(tool.name);
    if (tool.toolName) names.add(tool.toolName);
  }
  return names;
}
