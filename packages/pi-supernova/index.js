import { createRequire } from "node:module";
import { runProgramBatch } from "./src/runtime/program-batch.js";
import { REFERENCE } from "./src/runtime/reference.js";
import { isString, isFunction } from "./src/shared/decode.js";
import { loadConfig } from "./src/config/config.js";
import { createHostBridge } from "./src/bridge/host-bridge.js";
import { truncateChars, formatBoundedStringArray } from "./src/output/format.js";
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
    Unknown: (opts) => ({ ...opts }),
    Array: (items, opts) => ({ type: "array", items, ...opts }),
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
  if (!outcome.logs?.length && !outcome.logTruncated) return "";

  return `\n--- logs${outcome.logTruncated ? " [logs truncated]" : ""}\n${outcome.logs?.join("\n") ?? ""}${tail}`;
}

function mutationText(outcome) {
  const m = outcome.mutations;

  if (!m) return "";
  const external = m.external ? "; external calls attempted=" + m.external + ", their side effects cannot be rolled back" : "";
  const uncertain = m.pendingCommits || m.recoveryFailed ? "; filesystem outcome uncertain: inspect disk and any recovery backups before retrying" : "";

  return "\nmutations: committed=" + m.committed + " rolledBack=" + m.rolledBack + " (file versions)" + external + uncertain;
}

function mutationReceipts(trace) {
  if (!Array.isArray(trace)) return "";

  return trace
    .filter(row => row?.ok && (row.name === "write" || row.name === "edit") && isString(row.resultText) && row.resultText)
    .map(row => row.resultText)
    .join("\n");
}

// Corrective hint, emitted only when a turn actually split. Independent work
// belongs in one program: a split cannot use the single prewarmed worker and pays
// one extra spawn per sibling. Costs nothing until it fires, so it needs no room in
// the tool definition.
function splitTurnHint(outcome) {
  return outcome.overlappedTurn ? ` (${outcome.overlappedTurn} supernova calls ran at once; independent work belongs in one program)` : "";
}

function errorText(outcome, call) {
  return `error #${call} ${outcome.wallMs}ms${outcome.returnTruncated ? " [output truncated]" : ""}${mutationText(outcome)}${splitTurnHint(outcome)}
error: ${outcome.error}${logsBlock(outcome)}`;
}

function successText(outcome, call) {
  const truncated = outcome.returnTruncated ? " [return truncated]" : "";
  const hint = outcome.undefinedReturn ? " (no return statement; add `return` to get a value)" : "";

  return `ok #${call} ${outcome.wallMs}ms${truncated}${outcome.mutations?.committed || outcome.mutations?.rolledBack || outcome.mutations?.external ? mutationText(outcome) : ""}${splitTurnHint(outcome)}${logsBlock(outcome, "\n--- result")}\n${outcome.resultText}${hint}`;
}

function fitOutput(outcome, call, limit, format) {
  let text = format(outcome, call);

  if (text.length <= limit) return text;
  outcome.returnTruncated = true;
  const wrapper = format({ ...outcome, resultText: "", logs: [] }, call);
  const room = Math.max(256, limit - wrapper.length);

  if (Array.isArray(outcome.result) && outcome.result.length && outcome.result.every(isString)) {
    outcome.resultText = formatBoundedStringArray(outcome.result, room);
  } else if (isString(outcome.resultText) && outcome.resultText.length > room) {
    outcome.resultText = truncateChars(outcome.resultText, room, "output").text;
  }

  text = format(outcome, call);

  return text.length <= limit ? text : truncateChars(text, limit, "output").text;
}

const TOOL_DESCRIPTION = REFERENCE;

export default function piSupernova(pi) {
  registerCodeMode(pi);
}

// Shared entry used by both host adapters and direct engine integration.
export function registerCodeMode(pi) {
  // Citation elision is experimental and disabled by default. A context event is
  // not the final provider payload: hidden details or later transforms can invalidate
  // a citation. A positive seenWindow explicitly opts in despite those limitations.
  const config = loadConfig();
  let cwd = process.cwd();
  let programSeq = 0;
  let stopped = false;
  let warmTimer;
  // Program runs currently executing. Only one pristine worker is ever prewarmed,
  // so concurrent invocations cannot share it and each sibling pays a fresh spawn.
  // Counting them lets a result say so without adding standing guidance to the
  // tool definition, which is resent on every request.
  let inFlight = 0;
  // Peak concurrent execute() bodies in the current wave. Start-order or
  // finish-order alone cannot see a first-started call that finishes last.
  let overlapPeak = 0;

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
      nativeArgv: runBridge.supportsNativeArgv?.() === true,
      cancel,
    };
  }

  pi.registerTool({
    name: "supernova",
    label: "Supernova",
    description: TOOL_DESCRIPTION,
    promptSnippet: "read, write, edit, bash",
    parameters: Type.Object({
      code: Type.Optional(Type.String({ maxLength: config.maxCodeChars ?? 48000 })),
      file: Type.Optional(Type.String({ minLength: 1 })),
      data: Type.Optional(Type.Unknown()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
      programs: Type.Optional(Type.Array(Type.Object({
        code: Type.Optional(Type.String({ maxLength: config.maxCodeChars ?? 48000 })),
        file: Type.Optional(Type.String({ minLength: 1 })),
        data: Type.Optional(Type.Unknown()),
      }, {additionalProperties:false}), {minItems:1,maxItems:32})),
    }),
    // One self-owned result frame is shared by Pi and OMP; renderCall stays empty
    // so separate call/result slots cannot duplicate the lifecycle card.
    renderShell: "self",
    mergeCallAndResult: true,
    renderCall: renderSupernovaCall,
    renderResult: renderSupernovaResult,
    execute: async function execute(_id, params, signal, onUpdate, ctx, budget) {
      if (params?.programs !== undefined) return runProgramBatch(_id,params,signal,onUpdate,ctx,config,execute);
      cancelWarmTimer();
      const runCwd = ctx?.cwd || cwd;
      const runController = new AbortController();
      const abortRun = () => runController.abort(signal?.reason);

      if (signal?.aborted) abortRun();
      else signal?.addEventListener("abort", abortRun, { once: true });
      const runBridge = bridge.fork({ getCwd: () => runCwd, budget });
      runBridge.bindCallContext(ctx, runController.signal);
      runBridge.resetCallBudget();

      const call = ++programSeq;
      runBridge.ledger.beginProgram(call);
      const emitProgress = progressEmitter(onUpdate);
      runBridge.setCallListener((_record, trace) => emitProgress(trace));
      emitProgress([]);
      const started = performance.now();
      let outcome;
      inFlight += 1;
      overlapPeak = Math.max(overlapPeak, inFlight);
      let peakSeen = overlapPeak;

      try {
        refreshCatalog(runBridge);
        runBridge.beginSpeculation();
        outcome = await runGuestProgram({
          code: params?.code,
          file: params?.file,
          cwd: runCwd,
          data: params?.data,
          nova: makeNovaApi(runBridge, abortRun),
          config: { ...config, maxLogLines: Math.max(0,config.maxLogLines-(budget?.logLines ?? 0)), timeoutMs: Number.isInteger(params?.timeoutMs) ? params.timeoutMs : config.timeoutMs },
          signal: runController.signal,
          onTimeout: abortRun,
        });
        runBridge.close();

        if (outcome.ok) {
          if (runBridge.getOverlayDepth() !== 1) throw new Error("program ended with an unfinished edit checkpoint; await it before returning");
          await runBridge.commitSpeculation();
        }
        else while (runBridge.getOverlayDepth()) runBridge.rollbackSpeculation();
      } catch (error) {
        abortRun();
        runBridge.close();

        while (runBridge.getOverlayDepth()) runBridge.rollbackSpeculation();
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error), logs: outcome?.logs ?? [], wallMs: Math.round(performance.now() - started) };
      } finally {
        peakSeen = Math.max(peakSeen, overlapPeak);
        inFlight -= 1;
        if (inFlight === 0) overlapPeak = 0;
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

      if (budget) budget.logLines += outcome.logs?.length ?? 0;
      outcome.overlappedTurn = peakSeen > 1 ? peakSeen : 0;
      outcome.mutations = runBridge.getMutations();
      const trace = runBridge.getTrace();

      if (outcome.ok && outcome.result === undefined) {
        const receipts = mutationReceipts(trace);

        if (receipts) {
          outcome.resultText = receipts;
          outcome.undefinedReturn = false;
        }
      }
      const format = outcome.ok ? successText : errorText;
      const bounded = fitOutput(outcome, call, config.maxReturnChars, format);
      const visible = runBridge.ledger.dedupe(bounded, call);

      const response = result(visible, {
        ok: outcome.ok, error: outcome.error, wallMs: outcome.wallMs,
        returnTruncated: outcome.returnTruncated, logTruncated: outcome.logTruncated,
        logs: outcome.logs, result: outcome.result, trace, mutations: outcome.mutations,
      });

      if (outcome.images?.length) response.content.push(...outcome.images);

      if (!outcome.ok) {
        const error = new Error(visible);
        Object.defineProperty(error,"supernovaResult",{value:response});
        throw error;
      }

      return response;
    },
  });

  // This is a pre-conversion observation, not a final-payload retention proof.
  // Shipping seenWindow:0 must not subscribe: a no-op listener still runs on every
  // provider context event. Opt-in windows register here.
  if ((config.seenWindow ?? 0) > 0) {
    pi.on("context", event => {
      try { bridge.ledger.observe(event?.messages); } catch {}
    });
  }

  pi.on("session_shutdown", () => { stopped = true; cancelWarmTimer();

 return stopWarmGuestWorker(); });
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
