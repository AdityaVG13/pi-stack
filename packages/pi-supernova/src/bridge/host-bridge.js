import * as fs from "node:fs/promises";
import * as path from "node:path";
import { packageHostResult, hostResultFailed } from "../output/bottleneck.js";
import { truncateChars } from "../output/format.js";
import { isString, isFunction, isObject } from "../shared/decode.js";
import { isMutatingTool, runParallelWave, createNativeScheduler } from "../runtime/parallel.js";
import { unknownToolMessage } from "./catalog.js";
import { toolIsCallable, resolveInvokeTarget } from "./invoke.js";
import { buildWriteDiff } from "../fs/diff.js";
import { WorkspaceIndex } from "../context/repo-index.js";
import { SeenLedger } from "../context/ledger.js";
import { CausalVfs } from "../fs/vfs.js";
import { resolveWorkspacePath, runCommand, clearPathCache, relativeSlash } from "../fs/workspace.js";
import { createNativeAdapters } from "../adapters/index.js";
import { resultDiff, boundedWriteDiff, writeSnapshot } from "../fs/text-ops.js";

export function createHostBridge({ pi, config, getCwd, registry, ledger: runLedger, budget }) {
  const index = registry?.index ?? new WorkspaceIndex((argv, opts) => runCommand(argv, opts));
  const ledger = runLedger ?? new SeenLedger({ window: config.seenWindow ?? 0 });

  const vfs = new CausalVfs(paths => {
    index.invalidate();
    notifyWorkspaceChanged(paths);
  }, target => resolveWorkspacePath(getCwd(), target, "commit", false, true));

  const executors = registry?.executors ?? new Map();
  const definitions = registry?.definitions ?? new Map();
  const sharedRegistry = registry ?? { executors, definitions, index, callSeq: 0 };
  let closed = false;
  const hooks = {};
  const natives = createNativeAdapters(getCwd, vfs, config, index, ledger, hooks);
  let callCount = 0;
  let activeCtx = null;
  let hostSession = null;
  let boundSessionId;
  let activeSignal = undefined;
  let trace = [];
  let callListener = null;
  const scheduler = createNativeScheduler();

  // Advisory host event, not a tool or a transaction participant. Consumers
  // invalidate synchronously; failures must never affect committed bytes.
  function notifyWorkspaceChanged(paths = null) {
    if (!isFunction(pi?.events?.emit)) return;

    const event = Object.freeze({
      version: 1, cwd: path.resolve(getCwd()),
      paths: paths === null ? null : Object.freeze([...new Set(paths)]),
    });

    try { pi.events.emit("workspace:changed", event)?.catch?.(() => {}); } catch {}
  }

  hooks.workspaceChanged = notifyWorkspaceChanged;
  hooks.artifactsDir = () => activeCtx?.sessionManager?.getArtifactsDir?.();
  hooks.commandEnv = () => {
    const env = { ...process.env };

    const current = {
      PI_SESSION_ID: activeCtx?.sessionManager?.getSessionId?.(),
      PI_SESSION_FILE: activeCtx?.sessionManager?.getSessionFile?.(),
      PI_PROVIDER: activeCtx?.model?.provider,
      PI_MODEL: activeCtx?.model?.id,
      PI_REASONING_LEVEL: activeCtx?.thinkingLevel,
    };

    for (const [key, value] of Object.entries(current)) {
      if (isString(value)) env[key] = value;
      else delete env[key];
    }

    return env;
  };

  function captureHostTool(tool, excluded) {
    return tool && isString(tool.name) && isFunction(tool.execute) && tool.name !== "supernova" && !excluded.has(tool.name);
  }

  function wrapHostRegister() {
    if (registry || !pi || !isFunction(pi.registerTool)) return;
    const original = pi.registerTool.bind(pi);
    const excluded = new Set(config.excludeTools || []);
    pi.registerTool = (tool) => {
      if (captureHostTool(tool, excluded)) {
        executors.set(tool.name, tool.execute.bind(tool));
        definitions.set(tool.name, tool);
      }

      return original(tool);
    };
  }

  wrapHostRegister();

  function bindCallContext(ctx, signal) {
    activeCtx = ctx || null;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    boundSessionId = sessionId;
    const registry = pi?.pi?.AgentRegistry?.global?.();
    let sessions = [];

    try { sessions = registry?.list?.() ?? []; } catch {}
    if (!Array.isArray(sessions)) sessions = [];
    hostSession = sessionId
      ? sessions.map(ref => ref.session).find(session => !session?.isDisposed && session?.sessionManager?.getSessionId?.() === sessionId) ?? null
      : null;
    activeSignal = signal;
    vfs.signal = signal;
  }

  function evalToolNames() {
    try { return hostSession?.getEvalBridgeToolNames?.() ?? []; }
    catch { return []; }
  }

  function hostTool(name) {
    if (!hostSession) return undefined;
    const metadata = definitions.get(name);

    // Keep Supernova's transactional adapters for ordinary built-ins. Respect overrides.
    if (Object.hasOwn(natives, name) && metadata?.sourceInfo?.source === "builtin") return undefined;

    try { return hostSession.getToolForEvalBridge?.(name); }
    catch { return undefined; }
  }

  function callableEnv() {
    return {
      excluded: new Set(config.excludeTools || []),
      hostSession,
      natives,
      executors,
      sessionInvalid: () => hostSession && (hostSession.isDisposed || hostSession.sessionManager?.getSessionId?.() !== boundSessionId),
      nativeOwned: name => Object.hasOwn(natives, name) && !executors.has(name)
        && (!hostSession || !definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin"),
      evalAllows: name => {
        if (!evalToolNames().includes(name) && definitions.has(name)) return false;

        return !!hostTool(name) || (Object.hasOwn(natives, name) && (!definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin"));
      },
      listed: name => {
        let activeTools;

        try { activeTools = isFunction(pi?.getActiveTools) ? pi.getActiveTools() : undefined; } catch {}

        if (definitions.has(name) && Array.isArray(activeTools) && !activeTools.includes(name)) return false;

        return executors.has(name) || Object.hasOwn(natives, name);
      },
      hostTool,
    };
  }

  function isCallable(name) {
    return toolIsCallable(name, callableEnv());
  }

  function refreshTools() {
    let listed = [];

    try { listed = pi?.getAllTools?.() ?? []; } catch {}
    const tools = Array.isArray(listed) ? listed : [];

    for (const tool of tools) {
      if (!isString(tool?.name)) continue;
      definitions.set(tool.name, { ...definitions.get(tool.name), ...tool });

      if (!hostSession && isFunction(tool.execute)) executors.set(tool.name, tool.execute.bind(tool));
    }

    return [...definitions.values()].filter(tool => isCallable(tool.name));
  }

  function externalNames() {
    return [...definitions.keys()].filter(name => !!hostTool(name) || executors.has(name));
  }

  function resetCallBudget() {
    closed = false;
    vfs.closed = false;
    callCount = 0;
    trace = [];
    // Files may change between programs (editor, git); never serve a stale run.
    vfs.invalidateObserved();
    clearPathCache();
  }

  function getTrace() {
    return [...trace];
  }

  function setCallListener(fn) {
    callListener = isFunction(fn) ? fn : null;
  }

  function beginSpeculation() {
    return vfs.begin();
  }

  async function commitSpeculation() {
    return await vfs.commit();
  }

  function rollbackSpeculation() {
    return vfs.rollback();
  }

  function notifyCall(record) {
    if (!callListener) return;

    try {
      callListener(record, [...trace]);
    } catch {}
  }

  function assertRunOpen(name) {
    if (closed) throw new Error("program is already complete");

    if (activeSignal?.aborted) throw new Error("aborted");

    if (!isString(name) || !name) throw new Error("tool name required");
  }

  function chargeCallBudget() {
    const maxCalls = config.maxBridgeCalls ?? 256;

    if (budget && ++budget.calls > maxCalls) throw new Error("host call budget exceeded (" + maxCalls + " calls per program batch): split the batch");
    callCount += 1;

    if (callCount > maxCalls) {
      throw new Error(
        `host call budget exceeded (${maxCalls} calls per program): split the work across programs`,
      );
    }
  }

  function assertCallableTarget(name) {
    // Never re-enter supernova or other excluded composition tools via the bridge.
    const excluded = new Set(config.excludeTools || []);

    if (name === "supernova" || excluded.has(name)) {
      throw new Error(
        `${name} is blocked (excluded / non-reentrant).`,
      );
    }
  }

  async function writeFallbackDiff(name, args) {
    if (name !== "write" || !isString(args?.path) || !isString(args?.content)) return undefined;
    const target = await resolveWorkspacePath(getCwd(), args.path, "write", false);
    const { previous, removedLines } = await writeSnapshot(vfs, target, activeSignal);

    return removedLines === undefined ? buildWriteDiff(target, previous, args.content) : boundedWriteDiff(target, args.content, removedLines);
  }

  function completeRecord(record, res, fallbackDiff) {
    const diff = resultDiff(res) || fallbackDiff;
    finishRecord(record, res);

    if (diff && record.ok) record.diff = diff;
    notifyCall(record);
  }

  function traceArgs(args) {
    if (!isObject(args)) return {};
    const out = {};

    for (const key of ["path", "target", "query", "pattern", "command", "cwd", "glob", "action", "op"]) {
      const value = args[key];

      if (isString(value)) out[key] = truncateChars(value, 240, "trace").text;
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- display-only label: the value is already handled, this names its kind for the trace.
      else if (Array.isArray(value)) out[key] = value.slice(0, 128).map(item => isString(item) ? truncateChars(item, 240, "trace").text : typeof item);
    }

    if (isString(args.content)) out.content = args.content.length + " chars";
    if (Array.isArray(args.edits)) out.edits = args.edits.length + " edits";
    if (Array.isArray(args.args)) out.args = args.args.length + " argv";

    return out;
  }

  function assertOwnedOverride(name, args) {
    if (name === "read" && (args?.json !== undefined || /^(agent|artifact):\/\/.*\?/i.test(String(args?.path)))) throw new Error("JSON projection requires the Supernova-owned read adapter, not an external override");
    if (name === "write" && args?.append === true) throw new Error("append requires the Supernova-owned write adapter, not an external override");
  }

  async function invokeOverride(target, name, args, record, callId) {
    assertOwnedOverride(name, args);
    const fallbackDiff = await writeFallbackDiff(name, args);
    const mutating = isMutatingTool(name, config, args, definitions.get(name));

    if (mutating) await vfs.prepareExternalMutation(name);
    if (activeSignal?.aborted || closed) throw new Error("aborted");
    if (!isCallable(name)) throw new Error("tool is no longer enabled in this session: " + name);

    try {
      const res = await target.exec(`supernova:${name}:${callId}`, args || {}, activeSignal, undefined, target.delegated
        ? { ...activeCtx, settings: hostSession.settings, toolNames: evalToolNames(), autoApprove: false }
        : activeCtx);

      completeRecord(record, res, fallbackDiff);

      return res;
    } finally {
      if (mutating) { vfs.invalidateObserved(); index.invalidate(); clearPathCache(); notifyWorkspaceChanged(); }
    }
  }

  async function invokeNative(target, args, record) {
    const res = await target.native(target.argvOwned ? { ...args, args: args.args.map(String) } : args || {}, activeSignal);
    completeRecord(record, res);

    return res;
  }

  function failRecord(record, error) {
    record.ok = false;
    record.ms = Date.now() - record.time;
    record.error = error instanceof Error ? error.message : String(error);
    notifyCall(record);
  }

  async function invokeRaw(name, args) {
    assertRunOpen(name);
    const callId = ++sharedRegistry.callSeq;
    assertCallableTarget(name);

    if (!isCallable(name)) throw new Error(unknownToolMessage(name, [...definitions.keys(), ...Object.keys(natives)].filter(isCallable)));
    // Refused calls are free: only charge the budget once a target will run.
    chargeCallBudget();

    const command = { apply_patch: "edit", surface: "read", evidence: "read", snap: "read" }[name] ?? name;
    const record = { name: command, adapter: name, args: traceArgs(args), time: Date.now() };
    trace.push(record);
    notifyCall(record);

    try {
      const target = resolveInvokeTarget(name, args, { hostTool, hostSession, executors, natives });

      if (target.kind === "override") return await invokeOverride(target, name, args, record, callId);
      if (target.kind === "native") return await invokeNative(target, args, record);

      throw new Error(unknownToolMessage(name, [...executors.keys(), ...Object.keys(natives)]));
    } catch (error) {
      failRecord(record, error);
      throw error;
    }
  }

  function finishRecord(record, res) {
    record.ms = Date.now() - record.time;
    record.ok = !hostResultFailed(res);
    const exitCode = isObject(res?.details) ? res.details.exitCode : undefined;

    if (Number.isInteger(exitCode) && exitCode !== 0) record.exitCode = exitCode;
    const text = isObject(res) && Array.isArray(res.content)
      ? res.content.filter(part => part?.type === "text" && isString(part.text)).map(part => part.text).join("\n")
      : undefined;

    if (text) record.resultText = truncateChars(text, 4096, "trace").text;
  }

  async function call(name, args) {
    if (!isString(name) || !name) throw new Error("nova.call requires a tool name");
    const invoke = async () => packageHostResult(await invokeRaw(name, args), config);
    const kind = isMutatingTool(name, config, args, definitions.get(name)) ? "write" : "read";

    return scheduler.schedule(kind, invoke, activeSignal);
  }

  async function callMany(calls) {
    if (!Array.isArray(calls)) throw new TypeError("nova.callMany requires an array");
    const list = calls;

    if (list.some(item => !isString(item?.name) || !item.name)) throw new TypeError("nova.callMany entries require a tool name");

    const thunks = list.map((item) => {
      const n = item?.name;
      const a = item?.args;

      return () => call(n, a);
    });

    const names = list.map((item) => item?.name).filter((n) => isString(n));
    const wave = await runParallelWave(thunks, { names, calls: list, definitions: names.map(name => definitions.get(name)) }, { mode: "auto", config });
    // Return a results array that also carries .mode/.reason, and is directly
    // iterable so `for (const r of await nova.callMany([...]))` works.
    const results = Array.isArray(wave.results) ? wave.results.slice() : [];
    Object.defineProperties(results, {
      mode: { value: wave.mode, enumerable: false },
      reason: { value: wave.reason, enumerable: false },
      results: { value: results, enumerable: false },
    });

    return results;
  }

  return {
    executors,
    definitions,
    natives,
    refreshTools,
    isCallable,
    externalNames,
    supportsBatchRead: () => !hostTool("read") && !executors.has("read"),
    // Windows command shims need shell handling; preserve the existing route there.
    supportsNativeArgv: () => process.platform !== "win32" && !hostTool("bash") && !executors.has("bash"),
    summarizeEdit: (target, before, after, diff) => hooks.summarizeEdit(getCwd(), target, before, after, diff),
    invalidateFiles() { vfs.invalidateObserved(); index.invalidate(); clearPathCache(); },
    describeMemory() {
      const overlays = vfs.describeOverlays();

      // No body cache: reads always hit disk, so retained VFS bytes are always zero.
      return { vfsCacheBytes: 0, indexBytes: index.getEntryBytes(), overlayFiles: overlays.files, overlayBytes: overlays.bytes };
    },
    fileOperations: {
      access: (target, mode) => fs.access(target, mode),
      readFile: async target => Buffer.from(await vfs.read(target), "utf8"),
      // VFS owns parent creation and atomic replacement, inside Pi's file queue.
      mkdir: async () => {},
      async writeFile(target, content) {
        await resolveWorkspacePath(getCwd(), target, "write", false);
        await vfs.write(target, content);
        index.touch(relativeSlash(getCwd(), target));
      },
    },
    fork(options) {
      return createHostBridge({ pi, config, getCwd: options.getCwd, registry: sharedRegistry, ledger: ledger.fork(), budget: options.budget });
    },
    close() { closed = true; vfs.closed = true; },
    bindCallContext,
    resetCallBudget,
    getTrace,
    getMutations: () => ({ ...vfs.mutations }),
    setCallListener,
    barrier: run => scheduler.schedule("write", run, activeSignal),
    beginSpeculation,
    commitSpeculation,
    rollbackSpeculation,
    getOverlayDepth: () => vfs.getOverlayDepth(),
    call,
    callMany,
    ledger,
  };
}
