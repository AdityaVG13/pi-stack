import { isObject } from "./decode.js";
import { PapercutsParams, CONTRACT_VERSION, textResult, errorEnvelope } from "./contract.js";
import { parsePapercutsParams } from "./params.js";
import { ACTIONS } from "./actions.js";
import { actionExecutor } from "./worker-client.js";
import { renderPapercutsFrameCall, renderPapercutsFrameResult } from "./render.js";

export { SEVERITIES, SCHEMA_TARGETS } from "./contract.js";

export { parsePapercutsParams } from "./params.js";

function executionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);

  const fix = code === "busy"
    ? "Retry after the writer finishes. If a lock remains after a crash, inspect its PID and remove it only after confirming no writer is running."
    : "Run papercuts({action:'doctor'}) or check file/PAPERCUTS_FILE is a normal writable file path.";

  return textResult(errorEnvelope(code, message, fix));
}

function errorCode(error) {
  if (!(error instanceof Error || isObject(error)) || !("code" in error)) return "internal";

  return error.code === "usage" || error.code === "busy" ? error.code : "internal";
}

async function execute(_id, params, _signal, onUpdate, ctx) {
  // Current Pi passes onUpdate then ctx; older SDK hosts pass ctx fourth.
  const context = ctx ?? (onUpdate && isObject(onUpdate) ? onUpdate : undefined);

  try {
    const parsed = parsePapercutsParams(params);

    if (!parsed.ok) return textResult(parsed.error);

    if (parsed.value.action === "schema") return ACTIONS.schema(parsed.value);

    return await actionExecutor.run(parsed.value, context?.cwd ?? process.cwd(), _signal);
  } catch (error) {
    return executionError(error);
  }
}

export default function registerPapercuts(pi) {
  pi.on?.("session_shutdown", () => actionExecutor.close());
  pi.registerTool({
    name: "papercuts",
    label: "Papercuts",
    description:
      "A complaint box for friction you hit while working: dead-end tool calls, broken links, misleading docs, footgun configs, missing helpers. " +
      "File a one-line papercut the moment you hit one (action=add), then keep working. " +
      "Papercuts persist in an append-only .papercuts.jsonl at the git root so a human or a later agent can review the backlog and fix the real problems. " +
      "Actions: add, list, resolve, prune (archive resolved entries, compact the log), doctor, schema.",
    promptSnippet: "File a friction note (papercut) the moment you hit one, then keep working",
    promptGuidelines: [
      "When you hit friction during work — a dead-end tool call, a broken link, a misleading doc, a footgun config, a missing helper — call papercuts action=add BEFORE moving on. Don't stop working; file it and push through.",
      "Write the text as: what you hit + what would have prevented it. One line.",
      "Severity: minor (default) for annoyances, major for time sinks, blocker for hard walls.",
      "When filing a tool failure, attach cmd/exit/stderr. Never feed raw environment dumps.",
      "Do NOT file papercuts for trivial typos you immediately fix yourself — only for friction worth fixing in the repo/tooling/docs.",
      "Use this tool when friction is worth fixing later; file it and keep working.",
    ],
    parameters: PapercutsParams,
    annotations: { openWorldHint: false },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        data: {},
        error: {
          type: "object",
          properties: {
            code: { type: "string" }, message: { type: "string" },
            retryable: { type: "boolean" }, suggested_fix: { type: "string" },
          },
          required: ["code", "message", "retryable", "suggested_fix"],
        },
        meta: { type: "object", properties: { contract: { const: CONTRACT_VERSION } }, required: ["contract"] },
      },
      required: ["ok", "meta"],
      anyOf: [
        { properties: { ok: { const: true } }, required: ["data"] },
        { properties: { ok: { const: false } }, required: ["error"] },
      ],
    },
    renderShell: "self",
    renderCall: renderPapercutsFrameCall,
    renderResult: renderPapercutsFrameResult,
    execute,
  });
}
