import { createRequire } from "node:module";
import { isString, isFunction } from "./decode.js";
import { buildCatalog, searchCatalog, describeTool, mergeNativeToolDefinitions } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createHostBridge } from "./host-bridge.js";
import { runGuestProgram, warmGuestWorker } from "./runtime.js";
import { renderSupernovaCall, renderSupernovaResult } from "./render.js";

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

const PROGRESS_FRAME_MS = 40;

/**
 * Live trace updates for the card. The first update is immediate (seeds the result slot);
 * later ones are coalesced to one host re-render per frame so a tight loop of nova.calls
 * is not throttled by the TUI. A throwing host callback must never break the run.
 */
function progressEmitter(onUpdate) {
  if (!isFunction(onUpdate)) return Object.assign(() => {}, { flush() {} });
  let pending = null;
  let timer = null;
  const send = (trace) => {
    try {
      onUpdate({ content: [{ type: "text", text: "" }], details: { trace, running: true } });
    } catch {}
  };
  const flush = () => {
    timer = null;
    if (pending === null) return;
    const trace = pending;
    pending = null;
    send(trace);
  };
  const emit = (trace) => {
    if (timer === null && pending === null) {
      send(trace);
      timer = setTimeout(flush, PROGRESS_FRAME_MS);
      return;
    }
    pending = trace;
    if (timer === null) timer = setTimeout(flush, PROGRESS_FRAME_MS);
  };
  emit.flush = () => {
    if (timer !== null) clearTimeout(timer);
    pending = null;
    timer = null;
  };
  return emit;
}

function sessionStats({ programs, returnedChars, collapsedChars, collapsedRuns }) {
  const total = returnedChars + collapsedChars;
  const pct = total ? Math.round((collapsedChars / total) * 100) : 0;
  return `this session: ${programs} programs · ~${Math.round(returnedChars / 4)} tokens returned · ~${Math.round(collapsedChars / 4)} already-seen tokens not re-sent (${pct}%, ${collapsedRuns} runs)`;
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
const TOOL_DESCRIPTION = `Run one JavaScript program that composes host tools. Async body or arrow; \`return\` a small shaped value (compact literal, capped; strings raw; console.log is captured).

Globals (async):
read(path|paths, offset?, limit?) → text | text[] · read(path, {about}) → whole-file outline, only relevant bodies expanded
write(path, text) · edit(path, oldText, newText) → post-edit lines (no re-read needed) · patch(path, unifiedDiff)
bash(cmd, {cwd?, timeoutMs?}) → output, throws on non-zero exit · exec(cmd, argv?) quotes argv
evidence(query, {k?}) → {spans: [{path, lines, name, text}]} top-K spans that answer a question; use before read
snap(query, root?) → {path, line, signature, context} · surface(path) → {items: [{name, kind, line}]}
nova.call(name, args) → {ok, value} for any host tool · nova.callMany([{name, args}]) parallel when read-only
nova.search(query) → [{name, description}] · nova.describe(name) → parameters · nova.has(name) sync
parallel(thunks) · pipeline(items, ...stages)

Already-seen lines collapse to "⋯ N lines same as #12 · path:a–b ⋯"; read(path, a, n) re-shows them.`;

export default function piSupernova(pi) {
  const config = loadConfig();
  let cwd = process.cwd();
  let catalog = [];
  let programSeq = 0;

  const bridge = createHostBridge({
    pi,
    config,
    getCwd: () => cwd,
  });

  function refreshCatalog(target = bridge) {
    const tools = target.refreshTools();
    const discoverable = mergeNativeToolDefinitions(tools, target.externalNames())
      .filter(tool => target.isCallable(tool.name))
      .map(tool => {
        const schema = tool.parameters;
        try {
          if (isFunction(schema?.toJsonSchema)) return { ...tool, parameters: schema.toJsonSchema() };
          if (schema && !schema.type && pi.zod?.toJSONSchema && (schema._zod || schema._def)) {
            return { ...tool, parameters: pi.zod.toJSONSchema(schema, { io: "input" }) };
          }
          return tool;
        } catch (error) {
          return { ...tool, parameters: undefined, schemaError: error.message };
        }
      });
    catalog = buildCatalog(discoverable, config.excludeTools || []);
    return catalog;
  }

  function makeNovaApi(runBridge, runCatalog, cancel) {
    return {
      search: async (query, limit) => searchCatalog(runCatalog, query, Number.isInteger(limit) ? limit : config.maxSearchResults),
      describe: async (name) => describeTool(runCatalog, name),
      call: (name, args) => runBridge.call(name, args),
      callMany: (calls) => runBridge.callMany(calls),
      speculateBegin: () => runBridge.beginSpeculation(),
      speculateCommit: () => runBridge.commitSpeculation(),
      speculateRollback: () => runBridge.rollbackSpeculation(),
      names: () => runCatalog.map(tool => tool.name),
      batchRead: runBridge.supportsBatchRead(),
      cancel,
    };
  }

  pi.registerTool({
    name: "supernova",
    label: "Supernova",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Compose host tools in one JavaScript program",
    promptGuidelines: [
      "Use supernova for multi-step tool work: loops, filtering, parallel reads, read→edit chains. To understand code: evidence(question) across the repo, or read(path, {about: question}) for one file: full structure, only relevant bodies expanded. Plain read(path) only for lines you will edit. Return a compact shaped value; keep raw tool output inside the program.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript program: async body or arrow function." }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, description: "Hard timeout in ms." })),
    }),
    // One self-owned result frame is shared by Pi and OMP; renderCall stays empty
    // so separate call/result slots cannot duplicate the lifecycle card.
    renderShell: "self",
    mergeCallAndResult: true,
    renderCall: renderSupernovaCall,
    renderResult: renderSupernovaResult,
    async execute(_id, params, signal, onUpdate, ctx) {
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
        const runCatalog = refreshCatalog(runBridge);
        runBridge.beginSpeculation();
        outcome = await runGuestProgram({
          code: params?.code,
          nova: makeNovaApi(runBridge, runCatalog, abortRun),
          config: { ...config, timeoutMs: Number.isInteger(params?.timeoutMs) ? params.timeoutMs : config.timeoutMs },
          signal: runController.signal,
          onTimeout: abortRun,
        });
        runBridge.close();
        if (outcome.ok) {
          if (runBridge.getOverlayDepth() !== 1) throw new Error("program ended with an unfinished nova.speculate branch; await it before returning");
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
      }
      const trace = runBridge.getTrace();
      const text = outcome.ok ? successText(outcome, call) : errorText(outcome, call);
      return result(runBridge.ledger.dedupe(text, call), {
        ok: outcome.ok, error: outcome.error, wallMs: outcome.wallMs,
        returnTruncated: outcome.returnTruncated, logTruncated: outcome.logTruncated,
        logs: outcome.logs, result: outcome.result, trace,
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
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
      const external = bridge.externalNames().filter(bridge.isCallable).sort();
      const natives = Object.keys(bridge.natives).filter(name => bridge.isCallable(name) && !external.includes(name)).sort();
      const lines = [
        `pi-supernova catalog: ${catalog.length} tools`,
        `external tools: ${external.length ? external.join(", ") : "(none)"}`,
        `native adapters: ${natives.join(", ")}`,
        `timeoutMs=${config.timeoutMs} maxCallResultChars=${config.maxCallResultChars} maxReturnChars=${config.maxReturnChars} maxBridgeCalls=${config.maxBridgeCalls} maxHeapMb=${config.maxHeapMb}`,
        sessionStats(bridge.ledger.stats),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
