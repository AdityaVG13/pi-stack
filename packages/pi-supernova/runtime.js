import { Worker } from "node:worker_threads";
import { parse } from "acorn";
import { performance } from "node:perf_hooks";
import { packageFinalReturn } from "./bottleneck.js";
import { isFunction, isObject, isString } from "./decode.js";

const WORKER_URL = new URL("./guest-worker.js", import.meta.url);
const ABORT_MESSAGE = "supernova timed out or aborted: pass timeoutMs to allow longer runs, or split the program";
const MEMORY_POLL_MS = 50;
const MEMORY_SLACK = 1.5;
const rssBytes = isFunction(process.memoryUsage?.rss) ? () => process.memoryUsage.rss() : () => process.memoryUsage().rss;
let idleWorker = null;
let runSeq = 0;

const PARSE_OPTIONS = { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function hasReturn(node) {
  if (!isObject(node)) return false;
  if (node.type === "ReturnStatement") return true;
  if (FUNCTION_TYPES.has(node.type)) return false;
  return Object.values(node).some(value => Array.isArray(value) ? value.some(hasReturn) : hasReturn(value));
}

function prepareProgram(code) {
  let program;
  let expression;
  let expressionSource;
  try {
    program = parse(code, PARSE_OPTIONS);
    const statements = program.body.filter(node => node.type !== "EmptyStatement");
    const statement = statements.length === 1 ? statements[0] : undefined;
    const candidate = statement?.type === "ExpressionStatement" ? statement.expression : statement;
    if (candidate && FUNCTION_TYPES.has(candidate.type)) {
      expression = candidate;
      expressionSource = code.slice(0, statement.end).replace(/;\s*$/, "");
    }
  } catch (bodyError) {
    expressionSource = code.trimEnd().replace(/;+\s*$/, "");
    try {
      const wrapped = parse("(" + expressionSource + "\n)", PARSE_OPTIONS);
      expression = wrapped.body[0]?.expression;
      if (!expression || !FUNCTION_TYPES.has(expression.type)) throw bodyError;
    } catch { throw bodyError; }
  }
  const body = expression ? "return await (" + expressionSource + "\n)();" : code;
  const returns = expression
    ? expression.type === "ArrowFunctionExpression" && expression.body.type !== "BlockStatement" || hasReturn(expression.body)
    : hasReturn(program);
  return { body, hasReturn: returns };
}

function spawnWorker(config) {
  const maxHeapMb = config.maxHeapMb ?? 512;
  const worker = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } });
  const handle = { worker, maxHeapMb, dead: false, ready: null };
  // This listener also owns errors between readiness and a run's listeners.
  worker.on("error", () => { handle.dead = true; });
  worker.on("exit", () => {
    handle.dead = true;
    if (idleWorker === handle) idleWorker = null;
  });
  handle.ready = new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onFail);
      worker.off("exit", onFail);
    };
    const onMessage = (msg) => {
      if (msg?.op !== "ready") return;
      cleanup();
      resolve();
    };
    const onFail = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error("guest worker exited before ready (code " + err + ")"));
    };
    worker.on("message", onMessage);
    worker.on("error", onFail);
    worker.on("exit", onFail);
  });
  handle.ready.catch(() => {});
  return handle;
}

function killWorker(handle) {
  if (!handle) return;
  if (idleWorker === handle) idleWorker = null;
  handle.dead = true;
  return handle.worker.terminate();
}

function acquireWorker(config) {
  const candidate = idleWorker;
  idleWorker = null;
  const reusable = candidate && !candidate.dead && candidate.maxHeapMb === (config.maxHeapMb ?? 512);
  if (candidate && !reusable) void killWorker(candidate);
  const handle = reusable ? candidate : spawnWorker(config);
  handle.worker.ref?.();
  return handle;
}

/** Only pristine workers may be prewarmed. A used worker is never pooled. */
export function warmGuestWorker(config = {}) {
  if (idleWorker && !idleWorker.dead) return idleWorker.ready;
  const handle = spawnWorker(config);
  idleWorker = handle;
  handle.ready.then(() => {
    if (idleWorker === handle) handle.worker.unref?.();
  }, () => {});
  return handle.ready;
}

const RPC_METHODS = {
  call: (nova, args) => nova.call(args[0], args[1]),
  callMany: async (nova, args) => {
    const wave = await nova.callMany(args[0]);
    return Array.isArray(wave) ? { results: [...wave], mode: wave.mode, reason: wave.reason } : wave;
  },
  search: (nova, args) => nova.search(args[0], args[1]),
  describe: (nova, args) => nova.describe(args[0]),
  speculateBegin: (nova) => nova.speculateBegin(),
  speculateCommit: (nova) => nova.speculateCommit(),
  speculateRollback: (nova) => nova.speculateRollback(),
};

export async function runGuestProgram({ code, nova = {}, config = {}, signal, onTimeout }) {
  const started = performance.now();
  const wall = () => Math.round(performance.now() - started);
  const logs = [];
  const fail = (error) => ({ ok: false, error, logs, logTruncated, wallMs: wall() });
  let logTruncated = false;
  if (!isString(code) || !code.trim()) return fail("code must be a non-empty string");
  if (code.length > (config.maxCodeChars ?? 48000)) return fail("code exceeds " + (config.maxCodeChars ?? 48000) + " characters");
  if (signal?.aborted) return fail(ABORT_MESSAGE);
  const runId = ++runSeq;
  const timeoutMs = config.timeoutMs ?? 60000;
  const rssLimit = rssBytes() + (config.maxHeapMb ?? 512) * MEMORY_SLACK * 1048576;

  return new Promise((resolve) => {
    let handle;
    let finished = false;
    let accepting = true;
    let completing = false;
    let hostError;
    let notifyingHost = false;
    const pending = new Set();
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(memTimer);
      signal?.removeEventListener("abort", signalAbort);
      handle?.worker.off("message", onMessage);
      handle?.worker.off("error", onError);
      handle?.worker.off("exit", onExit);
    };
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      accepting = false;
      cleanup();
      void killWorker(handle);
      resolve({ ...outcome, wallMs: wall() });
    };
    const cancelHost = () => {
      notifyingHost = true;
      try { nova.cancel?.(); } catch {} finally { notifyingHost = false; }
    };
    const abort = () => {
      if (finished) return;
      cancelHost();
      try { onTimeout?.(); } catch {}
      finish(fail(ABORT_MESSAGE));
    };
    const signalAbort = () => { if (!notifyingHost) abort(); };
    const timer = setTimeout(abort, Math.min(timeoutMs, 2147483647));
    const memTimer = setInterval(() => {
      if (rssBytes() <= rssLimit) return;
      cancelHost();
      finish(fail("guest exceeded memory limit (maxHeapMb=" + (config.maxHeapMb ?? 512) + ")"));
    }, MEMORY_POLL_MS);
    signal?.addEventListener("abort", signalAbort, { once: true });

    const postResult = (message) => {
      if (!accepting || finished) return;
      try {
        handle.worker.postMessage({ ...message, runId });
      } catch (err) {
        try {
          handle.worker.postMessage({ op: "rpc:result", id: message.id, runId, ok: false, error: "result not transferable: " + err.message });
        } catch (error) {
          onError(error);
        }
      }
    };
    const complete = async (outcome) => {
      if (finished || completing) return;
      completing = true;
      accepting = false;
      // Stop timers and detached guest continuations before settling host work.
      handle?.worker.off("error", onError);
      handle?.worker.off("exit", onExit);
      void killWorker(handle);
      if (!outcome.ok) cancelHost();
      await Promise.allSettled(pending);
      if (finished) return;
      finish(outcome.ok && hostError ? fail(hostError) : outcome);
    };
    const onError = (err) => { void complete(fail("guest crashed: " + err.message)); };
    const onExit = (exitCode) => { void complete(fail("guest exited (code " + exitCode + ")")); };
    const onMessage = (msg) => {
      if (finished || !accepting || !isObject(msg) || msg.runId !== runId) return;
      if (msg.op === "log") {
        if (logs.length < (config.maxLogLines ?? 100)) logs.push(msg.line);
        else logTruncated = true;
        logTruncated ||= msg.truncated === true;
      } else if (msg.op === "logTruncated") {
        logTruncated = true;
      } else if (msg.op === "rpc") {
        const method = Object.hasOwn(RPC_METHODS, msg.method) && RPC_METHODS[msg.method];
        const work = Promise.resolve().then(() => {
          if (!method) throw new Error("unknown nova method: " + msg.method);
          return method(nova, msg.args);
        });
        pending.add(work);
        work.then(
          value => postResult({ op: "rpc:result", id: msg.id, ok: true, value }),
          err => {
            // An awaited, handled host error must not poison the whole program.
            if (!accepting) hostError ??= err instanceof Error ? err.message : String(err);
            postResult({ op: "rpc:result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
          },
        ).finally(() => pending.delete(work));
      } else if (msg.op === "done") {
        try {
          const packed = packageFinalReturn(msg.value, logs, config);
          void complete({ ok: true, result: packed.returnValue, resultText: packed.returnText,
            returnTruncated: packed.returnTruncated, undefinedReturn: msg.undefinedReturn === true,
            logs: packed.logs, logTruncated: logTruncated || packed.logTruncated });
        } catch (err) {
          void complete(fail(err.message));
        }
      } else if (msg.op === "error") {
        const where = msg.location ? " (line " + msg.location.line + ":" + msg.location.col + ")" : "";
        void complete(fail(msg.message + where));
      }
    };

    void (async () => {
      try {
        if (signal?.aborted) return abort();
        handle = acquireWorker(config);
        await handle.ready;
        if (finished || signal?.aborted) return abort();
        const available = isFunction(nova.names) ? await nova.names() : [];
        if (finished || signal?.aborted) return abort();
        handle.worker.on("message", onMessage);
        handle.worker.on("error", onError);
        handle.worker.on("exit", onExit);
        const prepared = prepareProgram(code);
        if (wall() >= timeoutMs) return abort();
        handle.worker.postMessage({ op: "run", runId, prepared, available,
          batchRead: nova.batchRead !== false,
          limits: { maxLogLines: config.maxLogLines ?? 100, maxLogLineChars: config.maxLogLineChars ?? 4096 } });
      } catch (err) {
        cancelHost();
        finish(fail("guest worker failed to start: " + err.message));
      }
    })();
  });
}
