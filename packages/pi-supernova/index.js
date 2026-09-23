import {programParameters} from './src/contract/program.js';
import {progressEmitter} from './src/ui/progress.js';

export {progressEmitter} from './src/ui/progress.js';

import {result,errorText,successText,fitOutput,attachReceipts,throwIfFailed} from './src/output/outcome.js';

import { runProgramBatch } from "./src/runtime/program-batch.js";
import { REFERENCE } from "./src/runtime/reference.js";
import { errorMessage, isString } from "./src/shared/decode.js";
import { loadConfig } from "./src/config/config.js";
import { createHostBridge } from "./src/bridge/host-bridge.js";

import { runGuestProgram, warmGuestWorker, stopWarmGuestWorker } from "./src/runtime/runtime.js";
import { renderSupernovaCall, renderSupernovaResult } from "./src/ui/render.js";

export { renderSupernovaCall, renderSupernovaResult };

function sessionStats({ programs, returnedChars }) {
  return `this session: ${programs} programs · ${returnedChars} output characters (not token counts)`;
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
      call: (name, args, onItem) => runBridge.call(name, args, onItem),
      callMany: (calls) => runBridge.callMany(calls),
      speculateBegin: () => runBridge.barrier(() => runBridge.beginSpeculation()),
      speculateCommit: () => runBridge.barrier(() => runBridge.commitSpeculation()),
      speculateRollback: () => runBridge.barrier(() => runBridge.rollbackSpeculation()),
      names: () => ["read", "edit", "write", "bash"],
      describeMemory: () => runBridge.describeMemory?.() ?? null,
      batchRead: runBridge.supportsBatchRead(),
      nativeArgv: runBridge.supportsNativeArgv?.() === true,
      cancel,
    };
  }

  function rejectLoneParallel(params) {
    if (params?.parallel !== undefined) throw new Error("parallel applies to the programs array; no commands ran");

    if (params?.mergeData !== undefined) throw new Error("mergeData applies to the programs array; no commands ran");
  }

  function bindRunSignal(signal) {
    const runController = new AbortController();
    const abortRun = () => runController.abort(signal?.reason);

    if (signal?.aborted) abortRun();
    else signal?.addEventListener("abort", abortRun, { once: true });

    return { runController, abortRun };
  }

  function openRunBridge(ctx, runCwd, budget, runController, timeoutMs, terminalIdentity) {
    const runBridge = bridge.fork({ getCwd: () => runCwd, budget, timeoutMs, terminalIdentity });
    runBridge.bindCallContext(ctx, runController.signal);
    runBridge.resetCallBudget();

    return runBridge;
  }

  async function runAndCommit(params, runCwd, runBridge, abortRun, runController, budget) {
    refreshCatalog(runBridge);
    runBridge.beginSpeculation();

    const outcome = await runGuestProgram({
      code: params?.code,
      file: params?.file,
      cwd: runCwd,
      data: params?.data,
      nova: makeNovaApi(runBridge, abortRun),
      config: { ...config, maxLogLines: Math.max(0,config.maxLogLines-(budget?.logLines ?? 0)), timeoutMs: params?.timeoutMs === undefined ? config.timeoutMs : Number(params.timeoutMs) },
      signal: runController.signal,
      onTimeout: abortRun,
    });

    runBridge.close();

    if (outcome.ok) {
      if (runBridge.getOverlayDepth() !== 1) throw new Error("program ended with an unfinished edit checkpoint; await it before returning");
      await runBridge.commitSpeculation();
    }
    else while (runBridge.getOverlayDepth()) runBridge.rollbackSpeculation();

    return outcome;
  }

  function scheduleWarm(runController) {
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

  function finishRun(runBridge, emitProgress, signal, abortRun, runController) {
    runBridge.setCallListener(null);
    emitProgress.flush();
    signal?.removeEventListener("abort", abortRun);
    // Prepare one pristine worker during the model's next decision. Never
    // recycle a worker that has executed arbitrary guest JavaScript.
    scheduleWarm(runController);
  }

  function packExecuteResult(outcome, call, runBridge, budget, runOpts, peakSeen) {
    if (budget) budget.logLines += outcome.logs?.length ?? 0;
    outcome.overlappedTurn = !runOpts?.parallel && peakSeen > 1 ? peakSeen : 0;
    outcome.mutations = runBridge.getMutations();
    const trace = runBridge.getTrace();
    attachReceipts(outcome, trace);
    const bounded = fitOutput(outcome, call, config.maxReturnChars, outcome.ok ? successText : errorText);
    const visible = runBridge.ledger.dedupe(bounded, call);

    const response = result(visible, {
      ok: outcome.ok, error: outcome.error, wallMs: outcome.wallMs,
      returnTruncated: outcome.returnTruncated, logTruncated: outcome.logTruncated,
      logs: outcome.logs, result: outcome.result, trace, mutations: outcome.mutations,
    });

    if (outcome.images?.length) response.content.push(...outcome.images);

    return throwIfFailed(outcome, visible, response);
  }

  pi.registerTool({
    name: "supernova",
    label: "Supernova",
    description: TOOL_DESCRIPTION,
    promptSnippet: "read, write, edit, bash",
    parameters: programParameters(config),
    // One self-owned result frame is shared by Pi and OMP; renderCall stays empty
    // so separate call/result slots cannot duplicate the lifecycle card.
    renderShell: "self",
    mergeCallAndResult: true,
    renderCall: renderSupernovaCall,
    renderResult: renderSupernovaResult,
    execute: async function execute(_id, params, signal, onUpdate, ctx, budget, runOpts) {
      const runCwd = isString(ctx?.cwd) && ctx.cwd ? ctx.cwd : cwd;
      // The entire invocation owns one identity, including entries queued by a
      // sequential/parallel batch. Dispatch after reload cannot renew its lease.
      const terminalIdentity = runOpts?.terminalIdentity ?? bridge.captureTerminalIdentity(ctx, runCwd);

      if (params?.programs !== undefined) {
        const entry = (id, payload, abort, update, context, sharedBudget, options) =>
          execute(id, payload, abort, update, context, sharedBudget, {...options,terminalIdentity});

        return runProgramBatch(_id,params,signal,onUpdate,ctx,config,entry);
      }

      rejectLoneParallel(params);
      cancelWarmTimer();
      const { runController, abortRun } = bindRunSignal(signal);
      const runBridge = openRunBridge(ctx, runCwd, budget, runController, params?.timeoutMs, terminalIdentity);
      const call = ++programSeq;
      runBridge.ledger.beginProgram(call);
      const emitProgress = progressEmitter(onUpdate);
      runBridge.setCallListener((_record, trace) => emitProgress(trace));
      emitProgress([]);
      const started = performance.now();
      inFlight += 1;
      overlapPeak = Math.max(overlapPeak, inFlight);
      let peakSeen = overlapPeak;
      let outcome;

      try {
        outcome = await runAndCommit(params, runCwd, runBridge, abortRun, runController, budget);
      } catch (error) {
        abortRun();
        runBridge.close();

        while (runBridge.getOverlayDepth()) runBridge.rollbackSpeculation();
        outcome = { ok: false, error: errorMessage(error), logs: outcome?.logs ?? [], wallMs: Math.round(performance.now() - started) };
      } finally {
        peakSeen = Math.max(peakSeen, overlapPeak);
        inFlight -= 1;

        if (inFlight === 0) overlapPeak = 0;
        finishRun(runBridge, emitProgress, signal, abortRun, runController);
      }

      return packExecuteResult(outcome, call, runBridge, budget, runOpts, peakSeen);
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

  pi.on("session_shutdown", async () => {
    stopped = true;
    cancelWarmTimer();
    await Promise.all([stopWarmGuestWorker(), bridge.shutdownTerminals()]);
  });
  pi.on("session_start", async (_event, ctx) => {
    await bridge.shutdownTerminals();
    bridge.reopenTerminals();
    stopped = false;

    cwd = ctx && isString(ctx.cwd) && ctx.cwd ? ctx.cwd : process.cwd();
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
