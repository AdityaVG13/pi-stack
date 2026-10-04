import { createBackgroundTerminals } from "../fs/background.js";
import {createToolRegistry} from './tool-registry.js';
import {traceArgs,finishRecord} from './trace.js';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { packageHostResult } from "../output/bottleneck.js";
import { READ_FILES } from "../shared/result.js";

import { errorMessage, isString, isFunction } from "../shared/decode.js";
import { isMutatingTool, createNativeScheduler } from "../runtime/parallel.js";
import { unknownToolMessage } from "./catalog.js";
import { resolveInvokeTarget } from "./invoke.js";
import { buildWriteDiff } from "../fs/diff.js";
import { WorkspaceIndex } from "../context/repo-index.js";
import { SeenLedger } from "../context/ledger.js";
import { CausalVfs, resolveCommitTarget } from "../fs/vfs.js";
import { resolveWorkspacePath, runCommand, clearPathCache, relativeSlash } from "../fs/workspace.js";
import { createNativeAdapters } from "../adapters/index.js";
import { resultDiff, boundedWriteDiff, writeSnapshot, resolveReadPath } from "../fs/text-ops.js";

export function createHostBridge({ pi, config, getCwd, registry, ledger: runLedger, budget, terminalIdentity }) {
  const index = registry?.index ?? new WorkspaceIndex((argv, opts) => runCommand(argv, opts));
  const ledger = runLedger ?? new SeenLedger({ window: config.seenWindow ?? 0 });

  const vfs = new CausalVfs(paths => {
    index.invalidate();
    notifyWorkspaceChanged(paths);
  }, target => resolveWorkspacePath(getCwd(), target, "commit", false, true), assertSession);

  vfs.bestEffort = true;

  const executors = registry?.executors ?? new Map();
  const definitions = registry?.definitions ?? new Map();
  const sharedRegistry = registry ?? { executors, definitions, index, callSeq: 0 };
  sharedRegistry.terminals ??= createBackgroundTerminals();
  let closed = false;
  const hooks = { terminals: sharedRegistry.terminals, terminalGeneration: terminalIdentity?.generation ?? sharedRegistry.terminals.getGeneration() };
  const ownerOf = ctx => JSON.stringify([ctx?.sessionManager?.getSessionId?.() ?? null, path.resolve(getCwd())]);
  let terminalOwner = terminalIdentity?.owner ?? ownerOf(null);
  const natives = createNativeAdapters(getCwd, vfs, config, index, ledger, hooks);
  let callCount = 0;
  let activeCtx = null;
  let activeSignal = undefined;
  let trace = [];
  const readFiles = new Set();
  // Write protection is independent of optional, bounded disk-read receipts.
  const openedPaths = new Set();
  let callListener = null;
  const scheduler = createNativeScheduler();

  // Advisory host events, not transaction participants. Observer failures
  // cannot fail reads or change committed bytes.
  function notifyWorkspace(name, paths) {
    if (!isFunction(pi?.events?.emit)) return;

    const event = Object.freeze({
      version: 1, cwd: path.resolve(getCwd()),
      paths: paths === null ? null : Object.freeze([...new Set(paths)]),
    });

    try { pi.events.emit(name, event)?.catch?.(() => {}); } catch {}
  }

  function notifyWorkspaceChanged(paths = null) { notifyWorkspace("workspace:changed", paths); }

  function rememberReads(raw, result) {
    if (!result.ok || !isFunction(pi?.events?.emit)) return;

    for (const file of raw?.[READ_FILES] ?? []) {
      if (readFiles.size === 256) break;
      readFiles.add(file);
    }
  }

  async function fileIdentities(input, existingOnly = false) {
    if (!isString(input)) return [];
    let logical;

    try { logical = resolveReadPath(getCwd(), input); }
    catch { return existingOnly ? [] : [input]; }

    let canonical;

    try { canonical = await vfs.resolvePath(logical, false); }
    catch {
      if (existingOnly && await vfs.getOverlay(logical) === undefined) return [];
      canonical = await vfs.resolvePath(logical).catch(() => logical);
    }

    // Captured tools can serve virtual paths; retain lexical identity too.
    // This is path-based protection, not an inode lease or cross-process lock.
    return logical === canonical ? [logical] : [logical, canonical];
  }

  function readPaths(args, result) {
    const paths = [];

    // A resolved missing-file probe must not forbid creation. Actual source
    // provenance also covers staged files that do not exist on disk yet.
    if (args?.query === undefined && args?.evidence !== true && isString(args?.path)) paths.push({path:args.path,existingOnly:args.resolve===true});

    if (isString(result.sourcePath)) paths.push({path:result.sourcePath,existingOnly:false});

    return paths;
  }

  async function rememberOpenedPaths(args, result) {
    if (result.streamed) return;

    const paths = Array.isArray(args?.path) && Array.isArray(result.items)
      ? args.path.flatMap((input, i) => result.itemErrors?.[i] ? [] : readPaths({...args,path:input},{sourcePath:result.sourcePaths?.[i]}))
      : result.ok ? readPaths(args, result) : [];

    const unique = new Map();

    for (const entry of paths) {
      if (!unique.has(entry.path) || !entry.existingOnly) unique.set(entry.path, entry);
    }

    const entries = [...unique.values()];

    for (let i = 0; i < entries.length; i += 8) {
      await Promise.all(entries.slice(i, i + 8).map(async entry => {
        for (const identity of await fileIdentities(entry.path, entry.existingOnly)) openedPaths.add(identity);
      }));
    }
  }

  async function assertUnreadWrite(args) {
    if (args?.replace === true || args?.append === true || !openedPaths.size) return;

    if ((await fileIdentities(args?.path)).some(identity => openedPaths.has(identity))) {
      throw new Error("file was already read this program; use edit(oldText, newText) or edit(view, ...). write({path,content,replace:true}) replaces anyway");
    }
  }

  hooks.terminalOwner = () => terminalOwner;
  hooks.workspaceChanged = notifyWorkspaceChanged;
  hooks.artifactsDir = () => {
    assertSession();

    return activeCtx?.sessionManager?.getArtifactsDir?.();
  };

  hooks.commandEnv = () => {
    assertSession();
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
    terminalOwner = terminalIdentity?.owner ?? ownerOf(ctx);
    tools.bindSession(ctx);
    activeSignal = signal;
    vfs.signal = signal;
  }

  function resetCallBudget() {
    closed = false;
    vfs.closed = false;
    callCount = 0;
    trace = [];
    readFiles.clear();
    openedPaths.clear();
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

  function assertSession() {
    if (hooks.terminalGeneration !== sharedRegistry.terminals.getGeneration() || terminalOwner !== ownerOf(activeCtx)) {
      throw new Error("host session changed; start a new call");
    }
  }

  function assertRunOpen(name) {
    if (closed) throw new Error("program is already complete");
    assertSession();

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
    if (name === "read" && args?.indexed === true) throw new Error("indexed source retrieval requires the Supernova-owned read adapter");

    if (name === "bash" && (args?.background === true || args?.action !== undefined)) throw new Error("background terminals require the Supernova-owned bash adapter, not an external override");

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
    assertSession();

    try {
      const res = await target.exec(`supernova:${name}:${callId}`, args || {}, activeSignal, undefined, target.delegated && tools.session
        ? { ...activeCtx, settings: tools.session.settings, toolNames: evalToolNames(), autoApprove: false }
        : activeCtx);

      completeRecord(record, res, fallbackDiff);

      return res;
    } finally {
      if (mutating) { vfs.invalidateObserved(); index.invalidate(); clearPathCache(); notifyWorkspaceChanged(); }
    }
  }

  async function invokeNative(target, args, record, onItem) {
    assertSession();
    vfs.bindMutationRecord(record);
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
    if (name === "write") await assertUnreadWrite(args);
    chargeCallBudget();

    const command = { apply_patch: "edit", surface: "read", evidence: "read", snap: "read" }[name] ?? name;
    const record = { name: command, adapter: name, args: traceArgs(args), time: Date.now() };
    trace.push(record);
    notifyCall(record);

    try {
      const target = resolveInvokeTarget(name, args, { hostTool, hostSession: tools.session, modern: tools.modern, executors, natives });

      if (target.kind === "override") return await invokeOverride(target, name, args, record, callId);

      if (target.kind === "native") return await invokeNative(target, args, record, onItem);

      throw new Error(unknownToolMessage(name, [...executors.keys(), ...Object.keys(natives)]));
    } catch (error) {
      failRecord(record, error);
      throw error;
    }
  }

  // Candidate discovery uses the existing permission, trace and budget boundary.
  // It cannot grant a read observation or invoke a mutating provider.
  hooks.indexedSearch = async args => {
    refreshTools();

    if (!isCallable("isearch") || isMutatingTool("isearch", config, args, definitions.get("isearch"))) throw new Error("indexed read requires a callable read-only isearch; enable/promote isearch or omit indexed:true");

    return invokeRaw("isearch", args);
  };

  function fileMutationKey(name, args) {
    if (!["edit", "write", "apply_patch"].includes(name) || !isString(args?.path)) return;

    // Overrides can mutate more than their declared path: keep them global.
    if (hostTool(name) || (!tools.modern && executors.has(name))) return;

    return async () => {
      const target = await resolveWorkspacePath(getCwd(), args.path, name, false, true);

      // Share the commit identity, including symlinks and not-yet-created files.
      return (await resolveCommitTarget(target)).target;
    };
  }

  async function call(name, args, onItem) {
    if (!isString(name) || !name) throw new Error("nova.call requires a tool name");
    const packageResult = raw => packageHostResult(raw, config, definitions.get(name)?.outputSchema !== undefined);

    const deliver = onItem ? async (index, raw) => {
      const result = packageResult(raw);

      if (name === "read") await rememberOpenedPaths({...args,path:args.path[index]}, result);
      await onItem(index, result);
      rememberReads(raw, result);
    } : undefined;

    const invoke = () => vfs.withPathScope(async () => {
      const raw = await invokeRaw(name, args, deliver);
      const result = packageResult(raw);

      if (name === "read") await rememberOpenedPaths(args, result);
      rememberReads(raw, result);

      return result;
    });

    const kind = isMutatingTool(name, config, args, definitions.get(name)) ? "write" : "read";

    return scheduler.schedule(kind, invoke, activeSignal, fileMutationKey(name, args));
  }


  return {
    executors,
    definitions,
    natives,
    refreshTools,
    isCallable,
    externalNames,
    supportsBatchRead: () => !hostTool("read") && (tools.modern || !executors.has("read")),
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

      return createHostBridge({ pi, config: runConfig, getCwd: options.getCwd, registry: sharedRegistry, ledger: ledger.fork(), budget: options.budget, terminalIdentity:options.terminalIdentity });
    },
    captureTerminalIdentity: (ctx, runCwd) => ({
      generation:sharedRegistry.terminals.getGeneration(),
      owner:JSON.stringify([ctx?.sessionManager?.getSessionId?.() ?? null, path.resolve(runCwd)]),
    }),
    shutdownTerminals: () => sharedRegistry.terminals.shutdown(),
    reopenTerminals: () => sharedRegistry.terminals.reopen(),
    close() { closed = true; vfs.closed = true; },
    bindCallContext,
    resetCallBudget,
    getTrace: () => [...trace],
    getMutations: () => ({ ...vfs.mutations }),
    setCallListener: fn => { callListener = isFunction(fn) ? fn : null; },
    barrier: run => scheduler.schedule("write", run, activeSignal),
    beginSpeculation() {
      assertSession();

      return vfs.begin();
    },
    async commitSpeculation() {
      assertSession();

      const depth = vfs.getOverlayDepth();
      const result = await vfs.commit();

      for (const record of trace) {
        if (record.mutationState !== "pending" || record.mutationDepth < depth) continue;
        record.mutationState = result.depth <= 1 ? "saved" : "pending";
        record.mutationDepth = result.depth;
      }

      // The outer success commit follows guest completion/delivery. Checkpoint
      // merges and failed programs must not publish provisional read credit.
      if (vfs.getOverlayDepth() === 0 && readFiles.size) {
        const paths = [...readFiles];
        readFiles.clear();
        notifyWorkspace("workspace:read", paths);
      }

      return result;
    },
    rollbackSpeculation() {
      const depth = vfs.getOverlayDepth();
      const result = vfs.rollback();

      for (const record of trace) {
        if (record.mutationState === "pending" && record.mutationDepth >= depth) record.mutationState = vfs.mutations.recoveryFailed ? "uncertain" : "rolled back";
      }

      if (vfs.getOverlayDepth() === 0) readFiles.clear();

      return result;
    },
    getOverlayDepth: () => vfs.getOverlayDepth(),
    call,
    ledger,
  };
}
