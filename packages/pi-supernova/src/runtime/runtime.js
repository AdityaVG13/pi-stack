import {acquireWorker,killWorker} from './worker-pool.js';
export {warmGuestWorker,stopWarmGuestWorker} from './worker-pool.js';
import {admitGuest,prepareProgram,normalizeGuestLocation} from './program.js';

import { readProgramFile } from "./program-file.js";

import { performance } from "node:perf_hooks";
import { packageFinalReturn } from "../output/bottleneck.js";
import { truncateChars } from "../output/format.js";
import { errorMessage, isFunction, isObject, isString } from "../shared/decode.js";

import { errorContext } from "../shared/syntax-context.js";
import {validateReturnedImages} from "../shared/image.js";

const ABORT_MESSAGE = "supernova aborted";
const TIMEOUT_MESSAGE = "supernova timed out: increase the outer timeoutMs (and any shorter bash timeoutMs), or split the program; sleeps count toward the deadline";

const MEMORY_SLACK = 1.5;

const toMb = bytes => Math.max(0, bytes / 1048576);

/** Only worker-local usage can trip the guard; host structures are diagnostic. */
export function formatMemoryAttribution({ limitMb, heapBytes, externalBytes, ms, op, calls, tracked }) {
  const parts = tracked
    ? [["vfs cache", tracked.vfsCacheBytes], ["index entries", tracked.indexBytes], ["overlays", tracked.overlayBytes]]
    : [];
  const where = op ? ` during ${op} (${calls} host calls)` : ` (${calls} host calls)`;
  const seen = parts.length
    ? `; supernova-tracked host bytes (not charged to guest): ${parts.map(([name, bytes]) => `${name} ${toMb(Number(bytes) || 0).toFixed(1)}MB`).join(", ")} in ${tracked.overlayFiles ?? 0} overlay files`
    : "";

  return `guest exceeded memory limit (maxHeapMb=${limitMb}): worker heap ${toMb(heapBytes).toFixed(1)}MB + external ${toMb(externalBytes).toFixed(1)}MB in ${Math.round(ms)}ms${where}${seen}`;
}

let runSeq = 0;

const RPC_METHODS = {
  call: (nova, args, onItem) => nova.call(args[0], args[1], onItem),
  callMany: async (nova, args) => {
    const wave = await nova.callMany(args[0]);

    return Array.isArray(wave) ? { results: [...wave], mode: wave.mode, reason: wave.reason } : wave;
  },
  speculateBegin: (nova) => nova.speculateBegin(),
  speculateCommit: (nova) => nova.speculateCommit(),
  speculateRollback: (nova) => nova.speculateRollback(),
};

class GuestRun {
  constructor({ code, file, cwd, data, nova, config, signal, onTimeout, runId, timeoutMs }) {
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
    this.deliveries = new Map();
    this.inputController.signal.addEventListener("abort", () => {
      for (const delivery of this.deliveries.values()) delivery.reject(new Error("aborted"));
      this.deliveries.clear();
    }, {once:true});
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
    if (!this.accepting || this.finished) return false;

    try {
      this.handle.worker.postMessage({ ...message, runId: this.runId });
      return true;
    } catch (err) {
      try {
        this.handle.worker.postMessage({ op: "rpc:result", id: message.id, runId: this.runId, ok: false, error: "result not transferable: " + err.message });
      } catch (error) {
        this.onError(error);
      }
      return false;
    }
  }

  deliverReadItem(id, index, value) {
    if (!this.accepting) return Promise.reject(new Error("aborted"));
    const key = id + ":" + index;
    return new Promise((resolve,reject) => {
      this.deliveries.set(key,{resolve,reject});
      if (!this.postResult({op:"rpc:item",id,index,value})) {
        this.deliveries.delete(key);
        reject(new Error("read result not transferable"));
      }
    });
  }

  onReadAck(msg) {
    const key = msg.id + ":" + msg.index;
    const delivery = this.deliveries.get(key);
    if (!delivery) return;
    this.deliveries.delete(key);
    if (msg.error) delivery.reject(new Error(msg.error));
    else delivery.resolve();
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
    this.inputController.abort();
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

      const onItem = msg.streamRead && msg.method === "call" && msg.args?.[0] === "read"
        ? (index,value) => this.deliverReadItem(msg.id,index,value) : undefined;
      return method(this.nova, msg.args, onItem);
    });

    this.pending.add(work);
    work.then(
      value => this.postResult({ op: "rpc:result", id: msg.id, ok: true, value }),
      err => {
        if (!this.accepting) this.hostError ??= errorMessage(err);
        this.postResult({ op: "rpc:result", id: msg.id, ok: false, error: errorMessage(err) });
      },
    ).finally(() => this.pending.delete(work));
  }

  async onDone(msg) {
    // A completed guest cannot submit more work while attachments are decoded.
    // The outer timer stays armed; no commit occurs before validation completes.
    this.accepting = false;
    try {
      const packed = msg.output ?? packageFinalReturn(msg.value, this.logs, this.config);
      if (packed.images?.length) await validateReturnedImages(packed.images,this.inputController.signal);
      void this.complete({ ok: true, result: packed.returnValue, resultText: packed.returnText,
        returnTruncated: packed.returnTruncated, images: packed.images, undefinedReturn: msg.undefinedReturn === true,
        logs: this.logs, logTruncated: this.logTruncated || packed.logTruncated });
    } catch (err) {
      void this.complete(this.fail(err.message));
    }
  }

  guestError(msg) {
    const location = normalizeGuestLocation(this.prepared.body, msg.location);
    const where = location ? " (line " + location.line + ":" + location.col + ")" : "";
    void this.complete(this.fail(msg.message + where));
  }

  onMemory(msg) {
    const { heapUsed, external } = msg;
    if (![heapUsed, external].every(bytes => Number.isFinite(bytes) && bytes >= 0)) return;
    if (heapUsed + external <= (this.config.maxHeapMb ?? 512) * MEMORY_SLACK * 1048576) return;
    let tracked = null;

    try { tracked = isFunction(this.nova?.describeMemory) ? this.nova.describeMemory() : null; } catch {}
    // Use the same cancellation/drain path as other failures, not an early
    // finish that can return while a host command is still mutating files.
    void this.complete(this.fail(formatMemoryAttribution({
      limitMb: this.config.maxHeapMb ?? 512, heapBytes: heapUsed, externalBytes: external,
      ms: this.wall(), op: this.lastRpcMethod, calls: this.rpcCount, tracked,
    })));
  }

  dispatchGuest(msg) {
    if (msg.op === "log") this.onLog(msg);
    else if (msg.op === "logTruncated") this.logTruncated = true;
    else if (msg.op === "memory") this.onMemory(msg);
    else if (msg.op === "rpc") this.onRpc(msg);
    else if (msg.op === "rpc:ack") this.onReadAck(msg);
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
      formatResult:true,
      limits: { maxReturnChars:this.config.maxReturnChars ?? 32000, maxLogLines: this.config.maxLogLines ?? 100, maxLogLineChars: this.config.maxLogLineChars ?? 4096 } });
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

  return new GuestRun({
    code, file, cwd, data: admitted.data, nova, config, signal, onTimeout,
    runId: ++runSeq,
    timeoutMs: admitted.timeoutMs,
  }).start();
}
