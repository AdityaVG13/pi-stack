import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config/config.js";
import { isString } from "../shared/decode.js";
import { createHostBridge } from "./host-bridge.js";
import { buildPatchDiff } from "../fs/diff.js";
import { createNativeScheduler } from "../runtime/parallel.js";
import { truncateChars } from "../output/format.js";
import { clearPathCache, resolveWorkspacePath } from "../fs/workspace.js";

export const NATIVE_NAMES = Object.freeze(["read", "edit", "write", "bash"]);

function userPath(cwd, input) {
  if (!isString(input) || !input.trim()) throw new Error("path must be a non-empty string");
  const value = input.trim().replace(/^@/, "");
  return path.resolve(cwd, value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);
}

function boundText(result, maxChars) {
  const total = result.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
  const truncated = total > maxChars;
  const notice = truncated ? truncateChars("\n[Truncated: read files individually or narrow the line range/question.]", maxChars, "read-result").text : "";
  let remaining = maxChars - notice.length;
  const content = result.content.map(block => {
    if (block.type !== "text") return block; // Images remain image attachments.
    const bounded = truncateChars(block.text, remaining, "read-result");
    remaining -= bounded.text.length;
    return { ...block, text: bounded.text };
  });
  if (notice) content.push({ type: "text", text: notice });
  const details = { ...result.details };
  if (truncated) details.outputTruncated = true;
  return { ...result, content, details };
}

/** Familiar Pi tool definitions with Supernova's source engine and atomic VFS. */
export function registerNativeTools(pi, host, config = loadConfig()) {
  let cwd = process.cwd();
  const base = createHostBridge({ pi: null, config: { ...config, seenWindow: 0 }, getCwd: () => cwd });
  const scheduler = createNativeScheduler();
  const factories = {
    read: host.createReadToolDefinition,
    edit: host.createEditToolDefinition,
    write: host.createWriteToolDefinition,
    bash: host.createBashToolDefinition,
  };

  function settingsFor(ctx) {
    return host.SettingsManager?.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted?.() === true });
  }

  async function readOne(args, signal, ctx, bridge, id) {
    const target = userPath(ctx.cwd, args.path);
    let stat;
    try { stat = await fs.stat(target); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    signal?.throwIfAborted();
    const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(target);
    if (stat?.isFile() && (args.about === undefined || image)) {
      // Pi retains image handling, full text, line windows, truncation metadata,
      // and actionable continuation offsets. Do not summarize or dedupe these.
      return factories.read(ctx.cwd, { autoResizeImages: image ? settingsFor(ctx)?.getImageAutoResize() : undefined }).execute(id, { ...args, path: target }, signal, undefined, ctx);
    }
    return boundText(await bridge.natives.read({ ...args, path: stat ? target : args.path }, signal), config.maxCallResultChars);
  }

  async function execute(name, id, args, signal, onUpdate, context) {
    const ctx = { ...context, cwd: context?.cwd || cwd };
    const bridge = base.fork({ getCwd: () => ctx.cwd });
    bridge.bindCallContext(ctx, signal);
    signal?.throwIfAborted();
    try {
      if (name === "read") {
        if (!Array.isArray(args.path)) return await readOne(args, signal, ctx, bridge, id);
        if (args.path.some(p => !isString(p) || !p.trim())) throw new Error("read paths must be non-empty strings");
        if (args.path.length > 64) throw new Error("read path arrays support at most 64 entries; use smaller batches");
        const groups = [], errors = [];
        // Bound fan-out even when a model submits a large path array.
        for (let offset = 0; offset < args.path.length; offset += 8) {
          const results = await Promise.all(args.path.slice(offset, offset + 8).map(async file => {
            try {
              const result = await readOne({ ...args, path: file }, signal, ctx, bridge, id);
              return { content: [{ type: "text", text: "File: " + file }, ...result.content] };
            } catch (error) {
              signal?.throwIfAborted();
              errors.push({ path: file, message: error.message });
              return { content: [{ type: "text", text: "[read error: " + file + "] " + error.message }] };
            }
          }));
          groups.push(...results);
        }
        const content = [];
        let remaining = config.maxCallResultChars, outputTruncated = false;
        for (let i = 0; i < groups.length; i++) {
          const bounded = boundText(groups[i], Math.floor(remaining / (groups.length - i)));
          remaining -= bounded.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
          outputTruncated ||= bounded.details.outputTruncated === true;
          content.push(...bounded.content);
        }
        return { content, details: { batch: true, count: args.path.length, errors, outputTruncated } };
      }
      if (name === "bash") {
        const settings = settingsFor(ctx);
        try { return await factories.bash(ctx.cwd, { shellPath: settings?.getShellPath(), commandPrefix: settings?.getShellCommandPrefix() }).execute(id, args, signal, onUpdate, ctx); }
        finally { bridge.invalidateFiles(); }
      }
      clearPathCache();
      const target = await resolveWorkspacePath(ctx.cwd, userPath(ctx.cwd, args.path), name);
      const ops = bridge.fileOperations;
      let before, after;
      const tool = factories[name](ctx.cwd, { operations: {
        ...ops,
        async readFile(file) { const buffer = await ops.readFile(file); before = buffer.toString("utf8"); return buffer; },
        async writeFile(file, content) { await ops.writeFile(file, content); after = content; },
      } });
      // Pi's edit/write implementations hold its shared canonical per-file queue
      // over the entire mutation, including our atomic replacement operation.
      const result = await tool.execute(id, { ...args, path: target }, signal, onUpdate, ctx);
      if (name === "edit" && before !== undefined && after !== undefined && result.details?.patch) {
        const summary = await bridge.summarizeEdit(target, before, after, buildPatchDiff(target, result.details.patch));
        result.content = [{ type: "text", text: summary }];
      }
      return result;
    } finally { bridge.close(); }
  }

  for (const name of NATIVE_NAMES) {
    const definition = factories[name](cwd);
    const tool = {
      ...definition,
      execute(id, args, signal, onUpdate, ctx) {
        return scheduler.schedule(name, () => execute(name, id, args, signal, onUpdate, ctx), signal);
      },
    };
    if (name === "read") {
      tool.description += " Also reads directories or finds source from a symbol/question passed as path. Use about to focus a file or directory on a question. An array of paths returns all readable files and labels individual errors.";
      tool.parameters = { ...definition.parameters, properties: {
        ...definition.parameters.properties,
        path: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 64 }], description: "File, directory, source question, or up to 64 paths to read" },
        about: { type: "string", description: "Focus on this question or symbol; source selection reports uncertainty instead of guessing" },
      } };
      tool.promptGuidelines = [...(definition.promptGuidelines || []), "read can find source from a symbol or question; check its selection status before choosing a file. Plain file reads preserve full text within the stated limits."];
    }
    pi.registerTool(tool);
  }
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx?.cwd || cwd;
    base.invalidateFiles();
  });
  pi.registerCommand("supernova", {
    description: "Show Supernova native runtime status",
    handler: async (_args, ctx) => ctx.ui.notify("Supernova runtime: read, edit, write, bash; " + scheduler.stats.calls + " calls, " + scheduler.stats.readWaves + " read waves, peak " + scheduler.stats.peakParallelReads + " parallel reads. Mutations are ordered; plain reads are not summarized or deduplicated.", "info"),
  });
}
