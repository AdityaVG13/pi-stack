import { createRequire } from "node:module";
import { isString, isFunction } from "./decode.js";
import { buildCatalog, searchCatalog, describeTool, mergeNativeToolDefinitions } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createHostBridge } from "./host-bridge.js";
import { runGuestProgram } from "./runtime.js";
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

const TOOL_DESCRIPTION = `Execute JavaScript that orchestrates host tools in one shot (Code Mode).

Inside the program you get:
  nova.search(query)           — thin catalog hits (name + one-liner)
  nova.describe(name)          — full parameter summary on demand
  nova.call(name, args)        — invoke a host tool (or native adapter)
  nova.callMany([{name,args}]) — Auto parallel wave (serial if any mutating)
  parallel(thunks) / pipeline(items, ...stages)

Prefer search→describe→call. Keep intermediates in the program; return a shaped value.
Schemas are NOT dumped into the system prompt — discover them inside the runtime.`;

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
      search(query, limit) {
        const cat = catalog.length ? catalog : refreshCatalog();
        const lim = Number.isInteger(limit) ? limit : config.maxSearchResults;
        return searchCatalog(cat, query, lim);
      },
      describe(name) {
        const cat = catalog.length ? catalog : refreshCatalog();
        return describeTool(cat, name);
      },
      async call(name, args) {
        return bridge.call(name, args);
      },
      async callMany(calls) {
        return bridge.callMany(calls);
      },
      async speculate(fn) {
        bridge.beginSpeculation();
        try {
          const val = await fn();
          await bridge.commitSpeculation();
          return { ok: true, committed: true, value: val };
        } catch (err) {
          bridge.rollbackSpeculation();
          return { ok: false, committed: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      async surface(filePath) {
        return bridge.call("surface", { path: filePath });
      },
      async snap(query, targetPath) {
        return bridge.call("snap", { query, path: targetPath });
      },
      has(name) {
        return bridge.hasExecutor(name) || catalog.some((t) => t.name === name);
      },
    };
  }

  pi.registerTool({
    name: "supernova",
    label: "Supernova",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Compose multiple host tools in one JavaScript program via supernova",
    promptGuidelines: [
      "Use supernova when a task needs multi-step tool composition, loops, filtering, or parallel reads.",
      "Discover tools with nova.search / nova.describe inside the program — do not guess full schemas.",
      "Return a compact shaped value; intermediates stay in the runtime.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description:
          "JavaScript async body or arrow. Globals: nova/tools, parallel, pipeline, console.",
      }),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1000,
          description: "Hard timeout in ms (default from supernova.json / package default)",
        }),
      ),
    }),
    // "self" = we own chrome. OMP uses native framedBlock (write/edit look);
    // Pi keeps the muted violet SafeText wash. "default" falls back to raw JSON.
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

      bridge.setCallListener((_record, allTrace) => {
        if (isFunction(onUpdate)) {
          try {
            onUpdate({
              content: [{ type: "text", text: "" }],
              details: { trace: allTrace, running: true },
            });
          } catch {}
        }
      });

      const runConfig = {
        ...config,
        timeoutMs: Number.isInteger(params?.timeoutMs) ? params.timeoutMs : config.timeoutMs,
      };

      let outcome;
      try {
        outcome = await runGuestProgram({
          code: String(params?.code || ""),
          nova: makeNovaApi(),
          config: runConfig,
          signal: runController.signal,
          onTimeout: abortRun,
        });
      } finally {
        signal?.removeEventListener("abort", abortRun);
      }

      const trace = bridge.getTrace();
      if (!outcome.ok) {
        bridge.rollbackSpeculation();
        let text = `Supernova error (${outcome.wallMs}ms):\n${outcome.error}`;
        if (outcome.logs?.length) text += `\n\nLogs:\n${outcome.logs.join("\n")}`;
        return result(text, {
          ok: false,
          error: outcome.error,
          wallMs: outcome.wallMs,
          logs: outcome.logs,
          trace,
        });
      }

      await bridge.commitSpeculation();
      let text = `Supernova ok (${outcome.wallMs}ms)`;
      if (outcome.returnTruncated) text += " [return truncated]";
      if (outcome.logs?.length) text += `\n\nLogs:\n${outcome.logs.join("\n")}`;
      text += `\n\nResult:\n${outcome.resultText}`;
      return result(text, {
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

  pi.on("session_start", (_event, ctx) => {
    if (ctx && isString(ctx.cwd) && ctx.cwd) cwd = ctx.cwd;
    refreshCatalog();
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
        `timeoutMs=${config.timeoutMs} maxCallResultChars=${config.maxCallResultChars} maxBridgeCalls=${config.maxBridgeCalls}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
