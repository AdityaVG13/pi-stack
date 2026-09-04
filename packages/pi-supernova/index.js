import { createRequire } from "node:module";
import { isString, isFunction, isObject } from "./decode.js";
import { buildCatalog, searchCatalog, describeTool, mergeNativeToolDefinitions } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createHostBridge } from "./host-bridge.js";
import { runGuestProgram, warmGuestWorker } from "./runtime.js";
import {
  extractOperationsFromCode,
  renderSupernovaCall,
  renderSupernovaResult,
  SafeText,
} from "./render.js";

export { extractOperationsFromCode, renderSupernovaCall, renderSupernovaResult, SafeText };

// Sync only — never top-level await. Dynamic import of host/deps hung OMP plugin load.
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

function logsBlock(outcome, tail = "") {
  return outcome.logs?.length ? `\n--- logs\n${outcome.logs.join("\n")}${tail}` : "";
}

function errorText(outcome) {
  return `error ${outcome.wallMs}ms: ${outcome.error}${logsBlock(outcome)}`;
}

function successText(outcome) {
  const truncated = outcome.returnTruncated ? " [return truncated]" : "";
  const hint = outcome.undefinedReturn ? " (no return statement — add \`return\` to get a value)" : "";
  return `ok ${outcome.wallMs}ms${truncated}${logsBlock(outcome, "\n--- result")}\n${outcome.resultText}${hint}`;
}
function unwrapStructuredResult(response, operation) {
  if (response?.ok === false) {
    throw new Error(response.value || response.error || `${operation} failed`);
  }
  const value = isObject(response) && "value" in response ? response.value : response;
  if (!isString(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const TOOL_DESCRIPTION = `Run one JavaScript program that composes host tools. Async body or arrow; \`return\` a small shaped value (compact literal, capped; strings raw; console.log is captured).

Globals (async):
read(path|paths, offset?, limit?) → text | text[] · read(path, {about}) → whole-file outline, relevant bodies expanded
write(path, text) · edit(path, oldText, newText) · patch(path, unifiedDiff)
bash(cmd, {cwd?, timeoutMs?}) → output, throws on non-zero exit · exec(cmd, argv?) quotes argv
evidence(query, {k?}) → {spans: [{path, lines, name, text}]} top-K spans that answer a question — use before read
snap(query, root?) → {path, line, signature, context} · surface(path) → {items: [{name, kind, line}]}
nova.call(name, args) → {ok, value} for any host tool · nova.callMany([{name, args}]) parallel when read-only
nova.search(query) → [{name, description}] · nova.describe(name) → parameters · nova.has(name) sync
parallel(thunks) · pipeline(items, ...stages)`;

export default function piSupernova(pi) {
  const config = loadConfig();
  let cwd = process.cwd();
  let catalog = [];

  const bridge = createHostBridge({
    pi,
    config,
    getCwd: () => cwd,
  });

  function refreshCatalog() {
    let tools = [];
    try {
      if (isFunction(pi.getAllTools)) {
        tools = pi.getAllTools() || [];
      }
    } catch {
      tools = [];
    }
    const discoverable = mergeNativeToolDefinitions(tools, bridge.executors.keys());
    catalog = buildCatalog(discoverable, config.excludeTools || []);
    return catalog;
  }

  function makeNovaApi() {
    return {
      async search(query, limit) {
        const cat = catalog.length ? catalog : refreshCatalog();
        const lim = Number.isInteger(limit) ? limit : config.maxSearchResults;
        return searchCatalog(cat, query, lim);
      },
      async describe(name) {
        const cat = catalog.length ? catalog : refreshCatalog();
        return describeTool(cat, name);
      },
      async call(name, args) {
        return bridge.call(name, args);
      },
      async callMany(calls) {
        return bridge.callMany(calls);
      },
      speculateBegin() {
        bridge.beginSpeculation();
      },
      async speculateCommit() {
        await bridge.commitSpeculation();
      },
      speculateRollback() {
        bridge.rollbackSpeculation();
      },
      names() {
        const cat = catalog.length ? catalog : refreshCatalog();
        return [...new Set([...cat.map((t) => t.name), ...bridge.executors.keys(), ...Object.keys(bridge.natives)])];
      },
      async surface(filePath) {
        return unwrapStructuredResult(await bridge.call("surface", { path: filePath }), "surface");
      },
      async snap(query, targetPath) {
        return unwrapStructuredResult(await bridge.call("snap", { query, path: targetPath }), "snap");
      },
    };
  }

  pi.registerTool({
    name: "supernova",
    label: "Supernova",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Compose host tools in one JavaScript program",
    promptGuidelines: [
      "Use supernova for multi-step tool work: loops, filtering, parallel reads, read→edit chains. To understand code: evidence(question) across the repo, or read(path, {about: question}) for one file — full structure, only relevant bodies expanded. Plain read(path) only for lines you will edit. Return a compact shaped value; keep raw tool output inside the program.",
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
      if (ctx && isString(ctx.cwd) && ctx.cwd) cwd = ctx.cwd;
      const runController = new AbortController();
      const abortRun = () => runController.abort(signal?.reason);
      if (signal?.aborted) abortRun();
      else signal?.addEventListener("abort", abortRun, { once: true });

      bridge.bindCallContext(ctx, runController.signal);
      bridge.resetCallBudget();
      refreshCatalog();
      bridge.beginSpeculation();
      const emitProgress = progressEmitter(onUpdate);
      bridge.setCallListener((_record, allTrace) => emitProgress(allTrace));
      emitProgress([]);

      let outcome;
      try {
        outcome = await runProgram(params, runController.signal, abortRun);
      } finally {
        bridge.setCallListener(null);
        emitProgress.flush();
        signal?.removeEventListener("abort", abortRun);
      }

      const trace = bridge.getTrace();
      if (!outcome.ok) {
        bridge.rollbackSpeculation();
        return result(errorText(outcome), { ok: false, error: outcome.error, wallMs: outcome.wallMs, logs: outcome.logs, trace });
      }
      await bridge.commitSpeculation();
      return result(successText(outcome), {
        ok: true,
        wallMs: outcome.wallMs,
        returnTruncated: outcome.returnTruncated,
        logTruncated: outcome.logTruncated,
        logs: outcome.logs,
        result: outcome.result,
        trace,
      });
    },
  });

  async function runProgram(params, signal, onTimeout) {
    const runStartedAt = performance.now();
    const runConfig = {
      ...config,
      timeoutMs: Number.isInteger(params?.timeoutMs) ? params.timeoutMs : config.timeoutMs,
    };
    try {
      return await runGuestProgram({ code: String(params?.code || ""), nova: makeNovaApi(), config: runConfig, signal, onTimeout });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        wallMs: Math.round(performance.now() - runStartedAt),
      };
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx && isString(ctx.cwd) && ctx.cwd) cwd = ctx.cwd;
    refreshCatalog();
    warmGuestWorker(config).catch(() => {});
  });

  pi.registerCommand("supernova", {
    description: "Show pi-supernova status (catalog size, captured executors)",
    handler: async (_args, ctx) => {
      refreshCatalog();
      const captured = [...bridge.executors.keys()].sort();
      const natives = Object.keys(bridge.natives).sort();
      const lines = [
        `pi-supernova catalog: ${catalog.length} tools`,
        `captured executors: ${captured.length ? captured.join(", ") : "(none yet — load this package early)"}`,
        `native adapters: ${natives.join(", ")}`,
        `timeoutMs=${config.timeoutMs} maxCallResultChars=${config.maxCallResultChars} maxReturnChars=${config.maxReturnChars} maxBridgeCalls=${config.maxBridgeCalls} maxHeapMb=${config.maxHeapMb}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
