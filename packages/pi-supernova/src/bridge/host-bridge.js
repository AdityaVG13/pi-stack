import {createToolRegistry} from './tool-registry.js';
import {traceArgs,finishRecord} from './trace.js';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { packageHostResult } from "../output/bottleneck.js";

import { errorMessage, isString, isFunction } from "../shared/decode.js";
import { isMutatingTool, runParallelWave, createNativeScheduler } from "../runtime/parallel.js";
import { unknownToolMessage } from "./catalog.js";
import { resolveInvokeTarget } from "./invoke.js";
import { buildWriteDiff } from "../fs/diff.js";
import { WorkspaceIndex } from "../context/repo-index.js";
import { SeenLedger } from "../context/ledger.js";
import { CausalVfs, resolveCommitTarget } from "../fs/vfs.js";
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

  const tools = createToolRegistry({pi,config,registry,natives,executors,definitions});
  const {refreshTools,isCallable,externalNames,hostTool,evalToolNames} = tools;

  function bindCallContext(ctx, signal) {
    activeCtx = ctx || null;
    tools.bindSession(ctx);
    activeSignal = signal;
    vfs.signal = signal;
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
        ? { ...activeCtx, settings: tools.session.settings, toolNames: evalToolNames(), autoApprove: false }
        : activeCtx);

      completeRecord(record, res, fallbackDiff);

      return res;
    } finally {
      if (mutating) { vfs.invalidateObserved(); index.invalidate(); clearPathCache(); notifyWorkspaceChanged(); }
    }
  }

  async function invokeNative(target, args, record, onItem) {
    const res = await target.native(target.argvOwned ? { ...args, args: args.args.map(String) } : args || {}, activeSignal, onItem);
    completeRecord(record, res);

    return res;
  }

  function failRecord(record, error) {
    record.ok = false;
    record.ms = Date.now() - record.time;
    record.error = errorMessage(error);
    notifyCall(record);
  }

  async function invokeRaw(name, args, onItem) {
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
      const target = resolveInvokeTarget(name, args, { hostTool, hostSession: tools.session, executors, natives });

      if (target.kind === "override") return await invokeOverride(target, name, args, record, callId);
      if (target.kind === "native") return await invokeNative(target, args, record, onItem);

      throw new Error(unknownToolMessage(name, [...executors.keys(), ...Object.keys(natives)]));
    } catch (error) {
      failRecord(record, error);
      throw error;
    }
  }

  function fileMutationKey(name, args) {
    if (!["edit", "write", "apply_patch"].includes(name) || !isString(args?.path)) return;
    // Overrides can mutate more than their declared path: keep them global.
    if (hostTool(name) || executors.has(name)) return;

    return async () => {
      const target = await resolveWorkspacePath(getCwd(), args.path, name, false, true);
      // Share the commit identity, including symlinks and not-yet-created files.
      return (await resolveCommitTarget(target)).target;
    };
  }

  async function call(name, args, onItem) {
    if (!isString(name) || !name) throw new Error("nova.call requires a tool name");
    const deliver = onItem ? (index, raw) => onItem(index, packageHostResult(raw, config)) : undefined;
    const invoke = async () => packageHostResult(await invokeRaw(name, args, deliver), config);
    const kind = isMutatingTool(name, config, args, definitions.get(name)) ? "write" : "read";

    return scheduler.schedule(kind, invoke, activeSignal, fileMutationKey(name, args));
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
      const runConfig = options.timeoutMs === undefined ? config : { ...config, timeoutMs: Number(options.timeoutMs) };

      return createHostBridge({ pi, config: runConfig, getCwd: options.getCwd, registry: sharedRegistry, ledger: ledger.fork(), budget: options.budget });
    },
    close() { closed = true; vfs.closed = true; },
    bindCallContext,
    resetCallBudget,
    getTrace: () => [...trace],
    getMutations: () => ({ ...vfs.mutations }),
    setCallListener: fn => { callListener = isFunction(fn) ? fn : null; },
    barrier: run => scheduler.schedule("write", run, activeSignal),
    beginSpeculation: () => vfs.begin(),
    commitSpeculation: async () => await vfs.commit(),
    rollbackSpeculation: () => vfs.rollback(),
    getOverlayDepth: () => vfs.getOverlayDepth(),
    call,
    callMany,
    ledger,
  };
}
