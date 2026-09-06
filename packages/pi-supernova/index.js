import { createRequire } from "node:module";
import { isString, isFunction } from "./src/shared/decode.js";
import { loadConfig } from "./src/config/config.js";
import { createHostBridge } from "./src/bridge/host-bridge.js";
import { truncateChars } from "./src/output/format.js";
import { runGuestProgram, warmGuestWorker, stopWarmGuestWorker } from "./src/runtime/runtime.js";
import { renderSupernovaCall, renderSupernovaResult } from "./src/ui/render.js";

export { renderSupernovaCall, renderSupernovaResult };

// Sync only, never top-level await. Dynamic import of host/deps hung OMP plugin load.
const require = createRequire(import.meta.url);
let Type;
try {
  Type = require("typebox").Type;
} catch {
  Type = {
    Object: (props, opts) => ({ type: "object", properties: props || {}, additionalProperties: false, ...opts }),
    String: (opts) => ({ type: "string", ...opts }),
    Integer: (opts) => ({ type: "integer", ...opts }),
    Optional: (s) => ({ ...s }),
  };
}

function result(text, details) {
  return { content: [{ type: "text", text }], details };
}

const PROGRESS_FRAME_MS = 80;

/**
 * Live trace updates for the card. The first update is immediate (seeds the result slot);
 * later ones are coalesced to one host re-render per frame so a tight loop of nova.calls
 * is not throttled by the TUI. A throwing host callback must never break the run.
 */
export function progressEmitter(onUpdate) {
  if (!isFunction(onUpdate)) return Object.assign(() => {}, { flush() {} });
  let pending = null;
  let timer = null;
  let lastSent = -Infinity;
  const send = () => {
    timer = null;
    if (pending === null) return;
    // Snapshot only at emission, not on every tool event. Completed records must
    // not mutate a previously emitted frame while Pi is still consuming it.
    const trace = pending.map(record => ({ ...record }));
    pending = null;
    lastSent = performance.now();
    try {
      onUpdate({ content: [{ type: "text", text: "" }], details: { trace, running: true } });
    } catch {}
  };
  const emit = (trace) => {
    pending = trace;
    if (timer !== null) return;
    const wait = PROGRESS_FRAME_MS - (performance.now() - lastSent);
    if (wait <= 0) send();
    else timer = setTimeout(send, wait);
  };
  emit.flush = () => {
    if (timer !== null) clearTimeout(timer);
    pending = null;
    timer = null;
  };
  return emit;
}

function sessionStats({ programs, returnedChars }) {
  return `this session: ${programs} programs · ${returnedChars} output characters (not token counts)`;
}

function logsBlock(outcome, tail = "") {
  return outcome.logs?.length ? `\n--- logs\n${outcome.logs.join("\n")}${tail}` : "";
}

function errorText(outcome, call) {
  return `error #${call} ${outcome.wallMs}ms: ${outcome.error}${logsBlock(outcome)}`;
}

function successText(outcome, call) {
  const truncated = outcome.returnTruncated ? " [return truncated]" : "";
  const hint = outcome.undefinedReturn ? " (no return statement; add `return` to get a value)" : "";
  return `ok #${call} ${outcome.wallMs}ms${truncated}${logsBlock(outcome, "\n--- result")}\n${outcome.resultText}${hint}`;
}
const TOOL_DESCRIPTION = `Run one JavaScript program with four familiar commands: read, write, edit, bash. Use an async body or arrow. Return a small value; strings stay raw.

Native commands (async):
read(path|paths, offset?, limit?) → file text or text[]; read(directory) → directory entries
read("symbol or question") → JSON text with source location and context; no separate search tool needed
read(path, {about: question}) → relevant file bodies, or source selection inside a directory
read({query, evidence:true}) → ranked evidence; read({path, outline:true}) → structural declarations
write(path, text) → write a file
edit(path, oldText, newText) → post-edit lines, checks, and references
edit(async () => {...}) → filesystem checkpoint: commit on success, rollback on throw; no shell commands, nesting, or concurrent outside commands
bash(command, {cwd?, timeoutMs?}) → bounded output; throws on non-zero exit
bash({command, args:[...]}) → literal argv without shell expansion of arguments

Source selection reports found, ambiguous, not_found, or incomplete. Only found selects a path. Narrow the directory for uncertain results.
Object arguments also work: read({path, offset?, limit?, about?, outline?, evidence?}), edit({path, edits:[{oldText,newText}]}), edit({path,patch}), write({path,content}), bash({command,timeoutMs?}).
Independent read starts batch automatically. Mutations preserve submission order. Plain reads remain self-contained; oversized reads provide continuation offsets. Return only what the model needs. console.log is captured.`;

export default function piSupernova(pi) {
  registerCodeMode(pi);
}

// Shared entry used by both host adapters and direct engine integration.
export function registerCodeMode(pi) {
  // Local cache residency cannot establish what remains in the model's context.
  const config = { ...loadConfig(), seenWindow: 0 };
  let cwd = process.cwd();
  let programSeq = 0;
  let stopped = false;
  let warmTimer;
  function cancelWarmTimer() {
    if (warmTimer !== undefined) clearImmediate(warmTimer);
    warmTimer = undefined;
  }

  const bridge = createHostBridge({
    pi,
    config,
    getCwd: () => cwd,
  });

  function refreshCatalog(target = bridge) {
    // Refresh executors and permissions, not a model-facing catalogue. Guest
    // programs cannot dispatch arbitrary tools or consume their schemas.
    return target.refreshTools();
  }

  function makeNovaApi(runBridge, cancel) {
    return {
      call: (name, args) => runBridge.call(name, args),
      callMany: (calls) => runBridge.callMany(calls),
      speculateBegin: () => runBridge.barrier(() => runBridge.beginSpeculation()),
      speculateCommit: () => runBridge.barrier(() => runBridge.commitSpeculation()),
      speculateRollback: () => runBridge.barrier(() => runBridge.rollbackSpeculation()),
      names: () => ["read", "edit", "write", "bash"],
      batchRead: runBridge.supportsBatchRead(),
      cancel,
    };
  }

  pi.registerTool({
    name: "supernova",
    label: "Supernova",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Use read, write, edit, and bash in one program",
    promptGuidelines: [
      "Use read, write, edit, and bash inside supernova. Start with read(question), or read(directory, {about: question}) for scoped source selection. Read file bodies with read(file, {about: question}). Check source selection status before using its path. Return a compact value.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript program: async body or arrow function." }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, description: "Hard timeout in ms." })),
    }, { required: ["code"] }),
    // One self-owned result frame is shared by Pi and OMP; renderCall stays empty
    // so separate call/result slots cannot duplicate the lifecycle card.
    renderShell: "self",
    mergeCallAndResult: true,
    renderCall: renderSupernovaCall,
    renderResult: renderSupernovaResult,
    async execute(_id, params, signal, onUpdate, ctx) {
      cancelWarmTimer();
      const runCwd = ctx?.cwd || cwd;
      const runController = new AbortController();
      const abortRun = () => runController.abort(signal?.reason);
      if (signal?.aborted) abortRun();
      else signal?.addEventListener("abort", abortRun, { once: true });
      const runBridge = bridge.fork({ getCwd: () => runCwd });
      runBridge.bindCallContext(ctx, runController.signal);
      runBridge.resetCallBudget();

      const call = ++programSeq;
      runBridge.ledger.beginProgram(call);
      const emitProgress = progressEmitter(onUpdate);
      runBridge.setCallListener((_record, trace) => emitProgress(trace));
      emitProgress([]);
      const started = performance.now();
      let outcome;
      try {
        refreshCatalog(runBridge);
        runBridge.beginSpeculation();
        outcome = await runGuestProgram({
          code: params?.code,
          nova: makeNovaApi(runBridge, abortRun),
          config: { ...config, timeoutMs: Number.isInteger(params?.timeoutMs) ? params.timeoutMs : config.timeoutMs },
          signal: runController.signal,
          onTimeout: abortRun,
        });
        runBridge.close();
        if (outcome.ok) {
          if (runBridge.getOverlayDepth() !== 1) throw new Error("program ended with an unfinished edit checkpoint; await it before returning");
          await runBridge.commitSpeculation();
        }
        else runBridge.rollbackSpeculation();
      } catch (error) {
        abortRun();
        runBridge.close();
        runBridge.rollbackSpeculation();
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error), logs: outcome?.logs ?? [], wallMs: Math.round(performance.now() - started) };
      } finally {
        runBridge.setCallListener(null);
        emitProgress.flush();
        signal?.removeEventListener("abort", abortRun);
        // Prepare one pristine worker during the model's next decision. Never
        // recycle a worker that has executed arbitrary guest JavaScript.
        cancelWarmTimer();
        if (!stopped && !runController.signal.aborted) {
          // Deliver the result before paying for another Worker constructor.
          warmTimer = setImmediate(() => {
            warmTimer = undefined;
            if (!stopped && !runController.signal.aborted) warmGuestWorker(config).catch(() => {});
          });
          warmTimer.unref?.();
        }
      }
      const trace = runBridge.getTrace();
      const text = outcome.ok ? successText(outcome, call) : errorText(outcome, call);
      const bounded = truncateChars(text, config.maxReturnChars, "output").text;
      const visible = runBridge.ledger.dedupe(bounded, call);
      if (!outcome.ok) throw new Error(visible);
      const response = result(visible, {
        ok: outcome.ok, error: outcome.error, wallMs: outcome.wallMs,
        returnTruncated: outcome.returnTruncated, logTruncated: outcome.logTruncated,
        logs: outcome.logs, result: outcome.result, trace,
      });
      if (outcome.images?.length) response.content.push(...outcome.images);
      return response;
    },
  });

  pi.on("session_shutdown", () => { stopped = true; cancelWarmTimer(); return stopWarmGuestWorker(); });
  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    if (ctx && isString(ctx.cwd) && ctx.cwd) cwd = ctx.cwd;
    // A new session is a new model context: nothing has been seen yet.
    bridge.bindCallContext(ctx);
    bridge.ledger.reset();
    programSeq = 0;
    refreshCatalog();
    warmGuestWorker(config).catch(() => {});
  });

  pi.registerCommand("supernova", {
    description: "Show pi-supernova status (callable tools and session statistics)",
    handler: async (_args, ctx) => {
      bridge.bindCallContext(ctx);
      refreshCatalog();
      const commands = ["read", "edit", "write", "bash"].filter(bridge.isCallable);
      const lines = [
        `Supernova CodeMode: ${commands.join(", ")}`,
        `timeoutMs=${config.timeoutMs} maxCallResultChars=${config.maxCallResultChars} maxReturnChars=${config.maxReturnChars} maxBridgeCalls=${config.maxBridgeCalls} maxHeapMb=${config.maxHeapMb}`,
        sessionStats(bridge.ledger.stats),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
