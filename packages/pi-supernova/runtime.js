import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { packageFinalReturn } from "./bottleneck.js";
import { isFunction, isObject } from "./decode.js";

// Guest code runs in a worker thread (see guest-worker.js). The host thread
// owns the bridge and answers nova.* RPCs; a hard timeout or abort terminates
// the worker, which is the only way to stop a synchronous loop.

const WORKER_URL = new URL("./guest-worker.js", import.meta.url);
const ABORT_MESSAGE = "supernova timed out or aborted: pass timeoutMs to allow longer runs, or split the program";
// Bun ignores worker resourceLimits, so a process-RSS watchdog backs up the V8 heap cap.
const MEMORY_POLL_MS = 50;
const MEMORY_SLACK = 1.5;

const rssBytes = isFunction(process.memoryUsage?.rss) ? () => process.memoryUsage.rss() : () => process.memoryUsage().rss;

let idleWorker = null;
let runSeq = 0;

function spawnWorker(config) {
  const { maxHeapMb = 512 } = config;
  const worker = new Worker(WORKER_URL, {
    resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
  });
  const handle = { worker, dead: false, ready: null };
  handle.ready = new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      if (msg?.op === "ready") {
        cleanup();
        resolve();
      }
    };
    const onFail = (err) => {
      cleanup();
      handle.dead = true;
      reject(err instanceof Error ? err : new Error("guest worker exited before ready (code " + err + ")"));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onFail);
      worker.off("exit", onFail);
    };
    worker.on("message", onMessage);
    worker.on("error", onFail);
    worker.on("exit", onFail);
  });
  handle.ready.catch(() => {});
  worker.on("exit", () => {
    handle.dead = true;
    if (idleWorker === handle) idleWorker = null;
  });
  return handle;
}

function setIdleRef(handle, idle) {
  const fn = idle ? handle.worker.unref : handle.worker.ref;
  if (isFunction(fn)) fn.call(handle.worker);
}

function acquireWorker(config) {
  const handle = idleWorker && !idleWorker.dead ? idleWorker : spawnWorker(config);
  idleWorker = null;
  setIdleRef(handle, false);
  return handle;
}

function releaseWorker(handle) {
  if (handle.dead) return;
  if (idleWorker && idleWorker !== handle) {
    void handle.worker.terminate();
    return;
  }
  idleWorker = handle;
  setIdleRef(handle, true);
}

function killWorker(handle) {
  handle.dead = true;
  if (idleWorker === handle) idleWorker = null;
  void handle.worker.terminate();
}

/** Pre-spawn the guest worker so the first program does not pay startup cost. */
export function warmGuestWorker(config) {
  if (idleWorker && !idleWorker.dead) return idleWorker.ready;
  const handle = spawnWorker(config || {});
  idleWorker = handle;
  // Keep the loop alive only until the worker reports ready; an idle worker must not pin the process.
  handle.ready.then(
    () => { if (idleWorker === handle) setIdleRef(handle, true); },
    () => {},
  );
  return handle.ready;
}

const RPC_METHODS = {
  call: (nova, args) => {
    if (!isFunction(nova?.call)) throw new Error("nova.call unavailable");
    return nova.call(args[0], args[1]);
  },
  callMany: async (nova, args) => {
    if (!isFunction(nova?.callMany)) throw new Error("nova.callMany unavailable");
    const wave = await nova.callMany(args[0]);
    if (Array.isArray(wave)) return { results: [...wave], mode: wave.mode, reason: wave.reason };
    return wave;
  },
  search: (nova, args) => {
    if (!isFunction(nova?.search)) throw new Error("nova.search unavailable");
    return nova.search(args[0], args[1]);
  },
  describe: (nova, args) => {
    if (!isFunction(nova?.describe)) throw new Error("nova.describe unavailable");
    return nova.describe(args[0]);
  },
  speculateBegin: (nova) => nova?.speculateBegin?.(),
  speculateCommit: (nova) => nova?.speculateCommit?.(),
  speculateRollback: (nova) => nova?.speculateRollback?.(),
};

async function dispatchRpc(nova, method, args) {
  const fn = RPC_METHODS[method];
  if (!fn) throw new Error("unknown nova method: " + method);
  return fn(nova, args);
}

async function loadAvailable(nova) {
  if (!isFunction(nova?.names)) return [];
  try {
    return await nova.names();
  } catch {
    return [];
  }
}

async function prepareRun(options, fail) {
  const { code, config, signal, nova } = options;
  if (!String(code || "").trim()) return { failed: fail("code must be a non-empty string") };
  const maxCode = config.maxCodeChars ?? 48000;
  if (code.length > maxCode) return { failed: fail("code exceeds " + maxCode + " characters") };
  if (signal?.aborted) return { failed: fail(ABORT_MESSAGE) };
  const handle = acquireWorker(config);
  try {
    await handle.ready;
  } catch (err) {
    return { failed: fail("guest worker failed to start: " + err?.message) };
  }
  const available = await loadAvailable(nova);
  return { handle, worker: handle.worker, available };
}

function startWatchdogs({ timeoutMs, rssLimit, signal, onAbort, onMemoryExceeded }) {
  const timer = setTimeout(onAbort, timeoutMs);
  if (timer.unref) timer.unref();
  const memTimer = setInterval(() => {
    if (rssBytes() <= rssLimit) return;
    onMemoryExceeded(rssBytes());
  }, MEMORY_POLL_MS);
  if (memTimer.unref) memTimer.unref();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    clearTimeout(timer);
    clearInterval(memTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };
}

const MESSAGE_HANDLERS = {
  log: (msg, ctx) => {
    ctx.logs.push(msg.line);
  },
  rpc: (msg, ctx) => {
    dispatchRpc(ctx.nova, msg.method, msg.args).then(
      (value) => ctx.postResult({ op: "rpc:result", id: msg.id, ok: true, value }),
      (err) => ctx.postResult({ op: "rpc:result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  },
  done: (msg, ctx) => {
    const packaged = packageFinalReturn(msg.value, ctx.logs, ctx.config);
    ctx.finish(
      {
        ok: true,
        result: packaged.returnValue,
        resultText: packaged.returnText,
        returnTruncated: packaged.returnTruncated,
        undefinedReturn: msg.undefinedReturn === true && msg.hasReturn === false,
        logs: packaged.logs,
        logTruncated: packaged.logTruncated,
        wallMs: ctx.wall(),
      },
      true,
    );
  },
  error: (msg, ctx) => {
    const where = msg.location ? " (line " + msg.location.line + ":" + msg.location.col + ")" : "";
    ctx.finish(ctx.fail(msg.message + where, ctx.logs), true);
  },
};

export async function runGuestProgram(options) {
  const { code, nova, config, signal, onTimeout } = options;
  const started = performance.now();
  const wall = () => Math.round(performance.now() - started);
  const fail = (error, logs = []) => ({ ok: false, error, logs, wallMs: wall() });
  const prepared = await prepareRun(options, fail);
  if (prepared.failed) return prepared.failed;
  const { handle, worker, available } = prepared;
  const logs = [];
  const runId = ++runSeq;
  const { timeoutMs = 60000, maxHeapMb = 512 } = config;
  const rssLimit = rssBytes() + maxHeapMb * MEMORY_SLACK * 1048576;
  return await new Promise((resolve) => {
    let finished = false;
    let stop;
    const finish = (outcome, keepWorker) => {
      if (finished) return;
      finished = true;
      stop();
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (keepWorker) releaseWorker(handle);
      else killWorker(handle);
      resolve(outcome);
    };
    const abort = () => {
      try {
        onTimeout?.();
      } catch {}
      finish(fail(ABORT_MESSAGE, logs), false);
    };
    const postResult = (msg) => {
      if (finished) return;
      try {
        worker.postMessage(msg);
      } catch (err) {
        worker.postMessage({ op: "rpc:result", id: msg.id, ok: false, error: "result not transferable: " + err?.message });
      }
    };
    const ctx = { logs, nova, config, wall, fail, finish, postResult };
    const onMessage = (msg) => {
      if (!isObject(msg)) return;
      if (msg.runId !== runId) {
        if (msg.op === "rpc") postResult({ op: "rpc:result", id: msg.id, ok: false, error: "stale run" });
        return;
      }
      const handler = MESSAGE_HANDLERS[msg.op];
      if (handler) handler(msg, ctx);
    };
    const onError = (err) => finish(fail("guest crashed: " + err?.message, logs), false);
    const onExit = (runCode) => finish(fail("guest exited (code " + runCode + ")", logs), false);
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    stop = startWatchdogs({
      timeoutMs,
      rssLimit,
      signal,
      onAbort: abort,
      onMemoryExceeded: (rss) => {
        finish(fail(`guest exceeded memory limit (maxHeapMb=${maxHeapMb}, process rss grew to ${Math.round(rss / 1048576)} MB)`, logs), false);
        try {
          onTimeout?.();
        } catch {}
      },
    });
    const { maxLogLines = 100, maxLogLineChars = 4096 } = config;
    worker.postMessage({
      op: "run",
      runId,
      code,
      limits: { maxLogLines, maxLogLineChars },
      available,
    });
  });
}
