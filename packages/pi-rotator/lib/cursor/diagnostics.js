/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed diagnostics retained; see PROVENANCE.json. */
// Opt-in host-event summaries, separate from wire-level debug redaction.
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { appendFileSync } from "node:fs";

let extensionDebugLogFilePath;

export function isExtensionDebugEnabled() {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

export function getExtensionDebugLogFilePath() {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured = process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(tmpdir(), `pi-cursor-provider-extension-debug-${stamp}-${process.pid}.log`);
  return extensionDebugLogFilePath;
}

function truncateDebugValue(value, max = 240) {
  return value.length > max ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>` : value;
}

const DEBUG_TEXT_FIELDS = new Set(["text", "thinking"]);

function summarizeContentBlock(block) {
  if (!block || typeof block !== "object") return block;
  if (DEBUG_TEXT_FIELDS.has(block.type)) return { type: block.type, [block.type]: truncateDebugValue(String(block[block.type] ?? "")) };
  if (block.type === "toolCall") return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
  if (block.type === "image") return { type: "image", mimeType: block.mimeType, data: `<redacted base64 ${String(block.data ?? "").length} chars>` };
  return block;
}

function summarizeContent(content) {
  if (typeof content === "string") return truncateDebugValue(content);
  return Array.isArray(content) ? content.map(summarizeContentBlock) : content;
}

function summarizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  const typed = message;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content)
  };
}

export function summarizeBranchTail(ctx, limit = 6) {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map(entry => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message)
        };
      })
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function summarizeProviderPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const typed = payload;
  const messages = Array.isArray(typed.messages) ? typed.messages.map(message => summarizeMessage(message)).slice(-8) : undefined;
  return {
    model: typed.model,
    stream: typed.stream,
    pi_session_id: typed.pi_session_id,
    messageCount: Array.isArray(typed.messages) ? typed.messages.length : undefined,
    messages,
    toolCount: Array.isArray(typed.tools) ? typed.tools.length : undefined
  };
}

export function debugExtensionLog(event, data) {
  if (!isExtensionDebugEnabled()) return;
  // Diagnostics run before lifecycle cleanup, so every failure is best-effort.
  try {
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      scope: "extension",
      event,
      ...data
    });
    appendFileSync(getExtensionDebugLogFilePath(), `${payload}\n`, "utf8");
  } catch {}
}

export function registerExtensionDebugHooks(pi) {
  if (!isExtensionDebugEnabled()) return;
  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage(event.message)
    });
  });
  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event;
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent ? {
        type: typedEvent.assistantMessageEvent.type,
        delta: truncateDebugValue(String(typedEvent.assistantMessageEvent.delta ?? typedEvent.assistantMessageEvent.content ?? ""))
      } : undefined,
      message: summarizeMessage(typedEvent.message)
    });
  });
  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage(event.message),
      branch: summarizeBranchTail(ctx)
    });
  });
  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event;
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages) ? typedEvent.messages.length : undefined,
      messages: Array.isArray(typedEvent.messages) ? typedEvent.messages.slice(-8).map(message => summarizeMessage(message)) : undefined,
      branch: summarizeBranchTail(ctx)
    });
  });
  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event;
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults) ? typedEvent.toolResults.map(message => summarizeMessage(message)) : undefined,
      branch: summarizeBranchTail(ctx)
    });
  });
  debugExtensionLog("extension.debug_hooks_registered", {
    logFile: getExtensionDebugLogFilePath()
  });
}
