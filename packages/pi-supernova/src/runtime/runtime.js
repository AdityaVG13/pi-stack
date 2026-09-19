import { Worker } from "node:worker_threads";
import { readProgramFile } from "./program-file.js";
import { parse } from "acorn";
import { performance } from "node:perf_hooks";
import { packageFinalReturn } from "../output/bottleneck.js";
import { truncateChars } from "../output/format.js";
import { isFunction, isObject, isString } from "../shared/decode.js";
import { guestImportMessage, isDeniedGuestImport } from "./guest-deny-imports.js";
import { errorContext } from "../shared/syntax-context.js";

const WORKER_URL = new URL("./guest-worker.js", import.meta.url);

const ABORT_MESSAGE = "supernova aborted";
const TIMEOUT_MESSAGE = "supernova timed out: increase the outer timeoutMs (and any shorter bash timeoutMs), or split the program; sleeps count toward the deadline";

const MEMORY_POLL_MS = 50;

const MEMORY_SLACK = 1.5;

const rssBytes = isFunction(process.memoryUsage?.rss) ? () => process.memoryUsage.rss() : () => process.memoryUsage().rss;

const toMb = bytes => Math.max(0, bytes / 1048576);

/** Pure attribution for a memory-limit trip: which operation, and how much of the RSS growth supernova can account for. */
export function formatMemoryAttribution({ limitMb, rssBytes: now, startBytes, ms, op, calls, tracked }) {
  const deltaMb = toMb(now - startBytes);
  const parts = tracked
    ? [["vfs cache", tracked.vfsCacheBytes], ["index entries", tracked.indexBytes], ["overlays", tracked.overlayBytes]]
    : [];
  const trackedMb = parts.reduce((sum, [, bytes]) => sum + toMb(Number(bytes) || 0), 0);
  const untrackedMb = Math.max(0, deltaMb - trackedMb);
  const where = op ? ` during ${op} (${calls} host calls)` : ` (${calls} host calls)`;
  const seen = parts.length
    ? `; supernova-tracked host bytes: ${parts.map(([name, bytes]) => `${name} ${toMb(Number(bytes) || 0).toFixed(1)}MB`).join(", ")} in ${tracked.overlayFiles ?? 0} overlay files`
    : "";

  return `guest exceeded memory limit (maxHeapMb=${limitMb}): process RSS +${deltaMb.toFixed(1)}MB in ${Math.round(ms)}ms${where}${seen}; `
    + `~${untrackedMb.toFixed(1)}MB untracked (worker heap, transient buffers, or host/concurrent growth outside supernova)`;
}

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

function parseExpressionFunction(code) {
  try {
    const program = parse(code, PARSE_OPTIONS);
    const statements = program.body.filter(node => node.type !== "EmptyStatement");
    const statement = statements.length === 1 ? statements[0] : undefined;
    const candidate = statement?.type === "ExpressionStatement" ? statement.expression : statement;

    if (candidate && FUNCTION_TYPES.has(candidate.type)) {
      return { program, expression: candidate, expressionSource: code.slice(statement.start, statement.end).replace(/;\s*$/, "") };
    }

    return { program };
  } catch (bodyError) {
    const expressionSource = code.trimEnd().replace(/;+\s*$/, "");

    try {
      const wrapped = parse("(" + expressionSource + "\n)", PARSE_OPTIONS);
      const expression = wrapped.body[0]?.expression;

      if (!expression || !FUNCTION_TYPES.has(expression.type)) throw bodyError;

      return { expression, expressionSource };
    } catch { throw bodyError; }
  }
}

function deniedSpecifier(node) {
  if (node?.type === "Literal" && isString(node.value)) return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value?.cooked;
}

function assertGuestImports(ast) {
  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isObject(node)) return;
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
      const spec = deniedSpecifier(node.source);
      throw new Error((spec && isDeniedGuestImport(spec) ? guestImportMessage(spec) : "guest cannot import modules; use read, edit, write, or bash") + "; no commands ran");
    }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") {
      const spec = deniedSpecifier(node.arguments?.[0]);
      throw new Error((spec && isDeniedGuestImport(spec) ? guestImportMessage(spec) : "guest cannot import modules; use read, edit, write, or bash") + "; no commands ran");
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
      walk(node[key]);
    }
  }

  walk(ast);
}

function prepareProgram(code) {
  const parsed = parseExpressionFunction(code);
  assertGuestImports(parsed.program ?? parsed.expression);
  const body = parsed.expression ? "return await (" + parsed.expressionSource + "\n)();" : code;
  const returns = parsed.expression
    ? parsed.expression.type === "ArrowFunctionExpression" && parsed.expression.body.type !== "BlockStatement" || hasReturn(parsed.expression.body)
    : hasReturn(parsed.program);

  return { body, hasReturn: returns };
}

function spawnWorker(config) {
  const maxHeapMb = config.maxHeapMb ?? 512;
  // An inline bootstrap accepts inherited --input-type from stdin/eval SDK hosts.
  // Keep Node's automatic flag inheritance: explicitly copying execArgv can
  // reintroduce process-only V8 flags that Worker rejects under node --test.
  const worker = new Worker("import(" + JSON.stringify(WORKER_URL.href) + ")", { eval: true, resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } });
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

  // Pipeline the successor while this run executes. A consumed worker's
  // replacement starts at once; a cold start's replacement waits for ready,
  // so the two constructions never overlap. The finish-time warm usually
  // becomes a no-op, so steady-state spawn count is unchanged.
  if (reusable) warmGuestWorker(config).catch(() => {});
  else handle.ready.then(() => warmGuestWorker(config).catch(() => {}), () => {});

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

export function stopWarmGuestWorker() {
  return killWorker(idleWorker);
}

const RPC_METHODS = {
  call: (nova, args) => nova.call(args[0], args[1]),
  callMany: async (nova, args) => {
    const wave = await nova.callMany(args[0]);

    return Array.isArray(wave) ? { results: [...wave], mode: wave.mode, reason: wave.reason } : wave;
  },
  speculateBegin: (nova) => nova.speculateBegin(),
  speculateCommit: (nova) => nova.speculateCommit(),
  speculateRollback: (nova) => nova.speculateRollback(),
};

function admitData(data, cap) {
  if (data === undefined) return { data };

  try {
    const encoded = JSON.stringify(data);

    if (encoded === undefined) return { error: "data must be JSON-serializable" };
    if (encoded.length > cap) return { error: "data exceeds " + cap + " characters (serialized JSON: " + encoded.length + " UTF-16 characters); no commands ran. Split literal inputs across invocations; large text can use write({path,content,append:true}) chunks without omitting content" };

    return { data: JSON.parse(encoded) };
  } catch { return { error: "data must be JSON-serializable" }; }
}

function admitCode({ code, file, cap }) {
  if ((code === undefined) === (file === undefined)) return { error: "supply exactly one of code or file; no commands ran" };
  if (file === undefined && (!isString(code) || !code.trim())) return { error: "code must be a non-empty string" };
  if (file === undefined && code.length > cap) return { error: "code exceeds " + cap + " characters; split large writes into write({path,content,append:true}) chunks" };
}

function admitTimeout(config) {
  const requestedTimeout = Number(config.timeoutMs === undefined ? 60000 : config.timeoutMs);

  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) return { error: "timeoutMs must be a positive finite number" };

  return { timeoutMs: Math.max(1, Math.min(2_147_483_647, Math.floor(requestedTimeout))) };
}

function admitGuest({ code, file, data, config }) {
  const cap = config.maxCodeChars ?? 48000;
  const codeError = admitCode({ code, file, cap });

  if (codeError) return codeError;
  const admitted = admitData(data, cap);

  if (admitted.error) return admitted;
  const timeout = admitTimeout(config);

  if (timeout.error) return timeout;

  return { data: admitted.data, timeoutMs: timeout.timeoutMs };
}

class GuestRun {
  constructor({ code, file, cwd, data, nova, config, signal, onTimeout, runId, timeoutMs, rssLimit, rssStart }) {
    this.code = code;
    this.file = file;
    this.cwd = cwd;
    this.data = data;
    this.nova = nova;
    this.config = config;
    this.signal = signal;
    this.onTimeout = onTimeout;
    this.runId = runId;
    this.timeoutMs = timeoutMs;
    this.rssLimit = rssLimit;
    this.rssStart = rssStart;
    this.started = performance.now();
    this.logs = [];
    this.logTruncated = false;
    this.handle = undefined;
    this.finished = false;
    this.accepting = true;
    this.completing = false;
    this.hostError = undefined;
    this.notifyingHost = false;
    this.aborting = false;
    this.abortOutcome = undefined;
    this.pending = new Set();
    this.inputController = new AbortController();
    this.rpcCount = 0;
    this.lastRpcMethod = null;
  }

  wall() {
    return Math.round(performance.now() - this.started);
  }

  fail(error) {
    return { ok: false, error: truncateChars(String(error), this.config.maxReturnChars ?? 32000, "error").text, logs: this.logs, logTruncated: this.logTruncated, wallMs: this.wall() };
  }

  cleanup() {
    this.inputController.abort();
    clearTimeout(this.timer);
    clearInterval(this.memTimer);
    this.signal?.removeEventListener("abort", this.signalAbort);
    this.handle?.worker.off("message", this.onMessage);
    this.handle?.worker.off("error", this.onError);
    this.handle?.worker.off("exit", this.onExit);
  }

  finish(outcome) {
    if (this.finished) return;
    this.finished = true;
    this.accepting = false;
    this.cleanup();
    void killWorker(this.handle);
    this.resolve({ ...outcome, wallMs: this.wall() });
  }

  cancelHost() {
    this.notifyingHost = true;

    try { this.nova.cancel?.(); } catch {} finally { this.notifyingHost = false; }
  }

  abort(timedOut = false) {
    if (this.finished || this.aborting) return;
    this.aborting = true;
    this.accepting = false;
    this.abortOutcome = this.fail((timedOut ? TIMEOUT_MESSAGE : ABORT_MESSAGE) + " (ran " + this.wall() + "ms of " + this.timeoutMs + "ms)");
    this.cancelHost();

    if (timedOut) { try { this.onTimeout?.(); } catch {} }

    // Stop the guest immediately, then use the bounded host drain to retain
    // shell diagnostics and wait for process-tree termination before returning.
    void this.complete(this.abortOutcome);
  }

  postResult(message) {
    if (!this.accepting || this.finished) return;

    try {
      this.handle.worker.postMessage({ ...message, runId: this.runId });
    } catch (err) {
      try {
        this.handle.worker.postMessage({ op: "rpc:result", id: message.id, runId: this.runId, ok: false, error: "result not transferable: " + err.message });
      } catch (error) {
        this.onError(error);
      }
    }
  }

  async drainPending(outcome) {
    if (this.pending.size || !outcome.ok) this.cancelHost();
    if (!this.pending.size) return;
    let timer;

    try {
      await Promise.race([Promise.allSettled(this.pending), new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
    } finally { clearTimeout(timer); }
    if (this.pending.size && outcome.ok) this.hostError ??= "program completed with a host call still running";
  }

  async complete(outcome) {
    if (this.finished || this.completing) return;
    this.completing = true;
    this.accepting = false;
    this.handle?.worker.off("error", this.onError);
    this.handle?.worker.off("exit", this.onExit);
    void killWorker(this.handle);
    await this.drainPending(outcome);
    if (this.finished) return;
    if (this.abortOutcome) {
      const diagnostic = this.hostError && this.hostError !== "aborted" ? "\n" + this.hostError : "";
      outcome = this.fail(this.abortOutcome.error + diagnostic);
    }
    this.finish(outcome.ok && this.hostError ? this.fail(this.hostError) : outcome);
  }

  onError = (err) => { void this.complete(this.fail("guest crashed: " + err.message)); };

  onExit = (exitCode) => { void this.complete(this.fail("guest exited (code " + exitCode + ")")); };

  onLog(msg) {
    if (this.logs.length < (this.config.maxLogLines ?? 100)) this.logs.push(msg.line);
    else this.logTruncated = true;
    this.logTruncated ||= msg.truncated === true;
  }

  onRpc(msg) {
    const method = Object.hasOwn(RPC_METHODS, msg.method) && RPC_METHODS[msg.method];
    this.rpcCount++;
    this.lastRpcMethod = isString(msg.method) ? msg.method : null;
    const work = Promise.resolve().then(() => {
      if (!method) throw new Error("unknown nova method: " + msg.method);

      return method(this.nova, msg.args);
    });

    this.pending.add(work);
    work.then(
      value => this.postResult({ op: "rpc:result", id: msg.id, ok: true, value }),
      err => {
        if (!this.accepting) this.hostError ??= err instanceof Error ? err.message : String(err);
        this.postResult({ op: "rpc:result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      },
    ).finally(() => this.pending.delete(work));
  }

  onDone(msg) {
    try {
      const packed = packageFinalReturn(msg.value, this.logs, this.config);
      void this.complete({ ok: true, result: packed.returnValue, resultText: packed.returnText,
        returnTruncated: packed.returnTruncated, images: packed.images, undefinedReturn: msg.undefinedReturn === true,
        logs: packed.logs, logTruncated: this.logTruncated || packed.logTruncated });
    } catch (err) {
      void this.complete(this.fail(err.message));
    }
  }

  guestError(msg) {
    const where = msg.location ? " (line " + msg.location.line + ":" + msg.location.col + ")" : "";
    void this.complete(this.fail(msg.message + where));
  }

  dispatchGuest(msg) {
    if (msg.op === "log") this.onLog(msg);
    else if (msg.op === "logTruncated") this.logTruncated = true;
    else if (msg.op === "rpc") this.onRpc(msg);
    else if (msg.op === "done") this.onDone(msg);
    else if (msg.op === "error") this.guestError(msg);
  }

  onMessage = (msg) => {
    if (this.finished || !this.accepting || !isObject(msg) || msg.runId !== this.runId) return;
    this.dispatchGuest(msg);
  };

  signalAbort = () => { if (!this.notifyingHost) this.abort(); };

  async loadCode() {
    if (this.file !== undefined) this.code = await readProgramFile(this.file, this.cwd, this.config.maxCodeChars ?? 48000, this.inputController.signal);
    if (this.finished) return false;
    if (!this.code.trim()) { this.finish(this.fail("code must be a non-empty string; no commands ran")); return false; }

    try { this.prepared = prepareProgram(this.code); }
    catch (error) {
      const guidance = this.file === undefined
        ? " Put literal file/script content in the tool's data parameter and use write(data.path,data.content) or bash({command,args:data.args})."
        : " Fix " + this.file + " and re-run.";

      this.finish(this.fail("JavaScript syntax error" + (this.file === undefined ? "" : " in " + this.file) + ": " + error.message + "; no commands ran." + guidance + errorContext(this.code, error)));
      return false;
    }

    return true;
  }

  async attachWorker() {
    if (this.wall() >= this.timeoutMs) { this.abort(true); return false; }
    this.handle = acquireWorker(this.config);
    await this.handle.ready;
    if (this.finished || this.signal?.aborted) { this.abort(); return false; }
    let available = isFunction(this.nova.names) ? await this.nova.names() : [];

    if (!Array.isArray(available)) available = [];
    if (this.finished || this.signal?.aborted) { this.abort(); return false; }
    this.handle.worker.on("message", this.onMessage);
    this.handle.worker.on("error", this.onError);
    this.handle.worker.on("exit", this.onExit);
    if (this.wall() >= this.timeoutMs) { this.abort(true); return false; }
    this.available = available;

    return true;
  }

  postRun() {
    this.handle.worker.postMessage({ op: "run", runId: this.runId, prepared: this.prepared, data: this.data, available: this.available,
      batchRead: this.nova.batchRead !== false,
      nativeArgv: this.nova.nativeArgv === true,
      limits: { maxLogLines: this.config.maxLogLines ?? 100, maxLogLineChars: this.config.maxLogLineChars ?? 4096 } });
  }

  async boot() {
    try {
      if (this.signal?.aborted) return this.abort();
      if (!await this.loadCode()) return;
      if (!await this.attachWorker()) return;
      this.postRun();
    } catch (err) {
      if (this.finished) return;
      this.cancelHost();
      this.finish(this.fail("program failed to start: " + err.message + "; no commands ran"));
    }
  }

  start() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.timer = setTimeout(() => this.abort(true), Math.min(this.timeoutMs, 2147483647));
      this.memTimer = setInterval(() => {
        const now = rssBytes();

        if (now <= this.rssLimit) return;
        this.cancelHost();
        let tracked = null;

        try { tracked = isFunction(this.nova?.describeMemory) ? this.nova.describeMemory() : null; } catch {}
        this.finish(this.fail(formatMemoryAttribution({
          limitMb: this.config.maxHeapMb ?? 512, rssBytes: now, startBytes: this.rssStart ?? now,
          ms: this.wall(), op: this.lastRpcMethod, calls: this.rpcCount, tracked,
        })));
      }, MEMORY_POLL_MS);
      this.signal?.addEventListener("abort", this.signalAbort, { once: true });
      void this.boot();
    });
  }
}

export async function runGuestProgram({ code, file, cwd = process.cwd(), data, nova = {}, config = {}, signal, onTimeout }) {
  const admitted = admitGuest({ code, file, data, config });
  const fail = (error) => ({ ok: false, error: truncateChars(String(error), config.maxReturnChars ?? 32000, "error").text, logs: [], logTruncated: false, wallMs: 0 });

  if (admitted.error) return fail(admitted.error);
  if (signal?.aborted) return fail(ABORT_MESSAGE);
  const rssStart = rssBytes();

  return new GuestRun({
    code, file, cwd, data: admitted.data, nova, config, signal, onTimeout,
    runId: ++runSeq,
    timeoutMs: admitted.timeoutMs,
    rssLimit: rssStart + (config.maxHeapMb ?? 512) * MEMORY_SLACK * 1048576, rssStart,
  }).start();
}
