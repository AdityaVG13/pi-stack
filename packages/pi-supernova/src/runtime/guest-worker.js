import { parentPort } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import * as nodeModule from "node:module";
import { isString, isObject, isFunction, toPlain, looksLikePath } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";
import { gatherReadArgs, normalizeRead, decodeReadValue, assertReadPaths } from "../contract/read.js";
import { classifyEdit } from "../contract/edit.js";
import { normalizeBash } from "../contract/bash.js";
import { guestImportMessage, isDeniedGuestImport } from "./guest-deny-imports.js";

const { register, registerHooks } = nodeModule;

if (isFunction(registerHooks)) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isDeniedGuestImport(specifier)) {
        const error = new Error(guestImportMessage(specifier));
        error.code = "ERR_GUEST_IMPORT";
        throw error;
      }

      return nextResolve(specifier, context);
    },
  });
} else if (isFunction(register)) {
  try {
    register("./guest-deny-imports.js", import.meta.url);
  } catch {
    // Hosts whose module.register cannot run loader hooks lose the deny list;
    // the guest remains trusted code, not a sandbox boundary.
  }
}

// Guest programs run here, off the host thread. The host can terminate() this
// worker mid-loop, so a runaway "while (true) {}" or process.exit() in guest
// code cannot take the harness down with it.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const PARAMS = ["console", "read", "edit", "write", "bash"];

const BODY_LINE_OFFSET = 2;

const QUERY_URI = /^(agent|artifact):\/\/.*\?/i;

const PER_PATH_HINT = "; use Promise.allSettled(paths.map(path => read(path))) for per-path outcomes";

/** Best-effort guest line:col from an error stack (V8 "<anonymous>:L:C", JSC "eval code").*/
function guestLocation(err) {
  const stack = String(err?.stack);
  const m = /(?:<anonymous>:|(?:eval code|anonymous)(?:@|:))(\d+):(\d+)/.exec(stack);

  if (!m) return null;
  const line = Number(m[1]) - BODY_LINE_OFFSET;

  if (line < 1) return null;

  return { line, col: Number(m[2]) };
}

let activeRunId = 0;

let runActive = false;

let rpcSeq = 0;

const pendingRpc = new Map();

function post(msg) {
  parentPort.postMessage(msg);
}

function callRpc(runId, method, args) {
  if (!runActive || runId !== activeRunId) return Promise.reject(new Error("program is already complete"));

  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pendingRpc.set(id, { resolve, reject });

    try {
      post({ op: "rpc", id, runId, method, args });
    } catch (err) {
      pendingRpc.delete(id);
      reject(new Error("nova." + method + " arguments are not transferable: " + err?.message));
    }
  });
}

function unwrapValue(res) {
  if (res?.ok === false) throw new Error(String(res.value ?? res.error ?? "host tool failed"));

  if ("value" in Object(res)) return res.value;

  return res;
}

function unwrapRead(res, args) {
  const value = unwrapValue(res);

  if ((args.complete === true || args.json !== undefined) && res?.truncated) throw new Error("incomplete read: complete:true or json refuses truncated host output");

  return value;
}

/** Keep details/truncated reachable but out of the returned literal unless they carry signal. */
function leanEnvelope(res) {
  if (!isObject(res)) return res;

  if ("details" in res) Object.defineProperty(res, "details", { value: res.details, enumerable: false, writable: true });

  for (const key of Object.keys(res)) if (res[key] === undefined) delete res[key];

  if (res.truncated === false) delete res.truncated;

  return res;
}

function swallow(promise) {
  promise.catch(() => {});

  return promise;
}

function throwReadPathError(target, detail) {
  throw new Error(`read failed for ${target}: ${detail}${PER_PATH_HINT}`);
}

function isQueryUri(item) {
  return QUERY_URI.test(item);
}

function firstItemErrorIndex(res) {
  return res?.itemErrors?.findIndex(error => error != null) ?? -1;
}

function missingResolvedIndex(values, paths) {
  return values.findIndex((value, index) => value?.status === "not_found" && looksLikePath(paths[index]));
}

async function rpcReadWave(rpc, wave) {
  if (wave.length === 1) {
    const res = leanEnvelope(await rpc("call", ["read", wave[0].args]));

    return { values: [unwrapRead(res, wave[0].args)], errors: [] };
  }
  const args = { ...wave[0].args, path: wave.map(job => job.args.path), _independent: true };
  const res = leanEnvelope(await rpc("call", ["read", args]));
  unwrapRead(res, args);

  return { values: res.items, errors: res.itemErrors ?? [] };
}

function settleReadWave(wave, values, errors) {
  if (!Array.isArray(values) || values.length !== wave.length) throw new Error("invalid batch read response");

  for (let i = 0; i < wave.length; i++) {
    if (errors[i]) wave[i].reject(new Error(errors[i]));
    else wave[i].resolve(values[i]);
  }
}

function rejectReadWave(wave, error) {
  for (const job of wave) job.reject(error);
}

function dispatchReadWaves(pending, pendingReadWaves, enqueueHost, rpc) {
  for (let start = 0; start < pending.length; start += 64) {
    const wave = pending.slice(start, start + 64);
    const delivery = enqueueHost(() => rpcReadWave(rpc, wave))
      .then(({ values, errors }) => settleReadWave(wave, values, errors))
      .catch(error => rejectReadWave(wave, error));

    pendingReadWaves.add(delivery);
    void delivery.finally(() => pendingReadWaves.delete(delivery));
  }
}

function enqueueCompatibleRead(readState, flushReads, args, decode) {
  const key = JSON.stringify({ ...args, path: undefined });

  if (readState.queued.length && readState.queued[0].key !== key) flushReads();

  const promise = new Promise((resolve, reject) => {
    readState.queued.push({ args, key, resolve, reject });

    if (readState.queued.length === 1) queueMicrotask(flushReads);
  }).then(decode);

  return swallow(promise);
}

async function readManyPaths(readOne, invoke, batchRead, args, paths, decode) {
  assertReadPaths(paths);
  const readEach = async () => {
    const values = await Promise.all(paths.map(item => readOne({ ...args, path: item })));
    const missing = args.resolve ? missingResolvedIndex(values, paths) : -1;

    if (missing >= 0) throwReadPathError(paths[missing], "not_found");

    return values;
  };

  const guardedReadEach = () => swallow(readEach());

  if (!batchRead || args.resolve || paths.some(isQueryUri)) return guardedReadEach();
  const res = await invoke("read", args);
  const failed = firstItemErrorIndex(res);

  if (failed >= 0) throwReadPathError(paths[failed], res.itemErrors[failed]);
  unwrapRead(res, args);

  if (Array.isArray(res?.items)) return res.items.map(decode);

  return guardedReadEach();
}

function attachCallManyMeta(wave) {
  const results = Array.isArray(wave?.results) ? wave.results : Array.isArray(wave) ? wave : [];
  Object.defineProperties(results, {
    mode: { value: wave?.mode, enumerable: false },
    reason: { value: wave?.reason, enumerable: false },
    results: { value: results, enumerable: false },
  });

  return results;
}

async function runSpeculation(fn, token, checkpointScope, drainReads, enqueueHost, rpc) {
  let began = false;

  try {
    await drainReads();
    await enqueueHost(() => rpc("speculateBegin", []));
    began = true;
    const value = await checkpointScope.run(token, fn);
    await drainReads();
    await enqueueHost(() => rpc("speculateCommit", []));

    return { ok: true, committed: true, value };
  } catch (err) {
    await drainReads();

    if (began) await enqueueHost(() => rpc("speculateRollback", []));

    throw err;
  }
}

function formatBashFailure(command, res) {
  let exitCode;

  try {
    exitCode = JSON.parse(res.details).exitCode;
  } catch {}

  const output = String(res.value).trimEnd();
  const suffix = Number.isInteger(exitCode) ? " (exit " + exitCode + ")" : "";

  return "command failed" + suffix + ": " + truncateChars(command, 240, "command").text + (output ? "\n" + output : "");
}

function markTruncatedOutput(res, text) {
  if (res?.truncated && isString(text) && !text.includes("truncated")) return text + "\n…[output truncated]…";

  return text;
}

function encodeConsoleArg(a) {
  if (isString(a)) return a;

  try {
    const plain = toPlain(a);
    const encoded = JSON.stringify(plain);

    return encoded === undefined ? String(plain) : encoded;
  } catch {
    return String(a);
  }
}

function compileGuest(prepared, data) {
  const bindings = data === undefined ? PARAMS : [...PARAMS, "data"];

  return { fn: new AsyncFunction(...bindings, prepared.body), hasReturn: prepared.hasReturn };
}

function plainGuestValue(value) {
  try { return toPlain(value); }
  catch (err) { return "[unserializable: " + (err?.message || err) + "]"; }
}

function handleRpcResult(msg) {
  const pending = pendingRpc.get(msg.id);

  if (!pending) return;
  pendingRpc.delete(msg.id);

  if (msg.ok) pending.resolve(msg.value);
  else pending.reject(new Error(msg.error));
}

function buildGuestApi(available, batchRead, runId, _nativeArgv) {
  const rpc = (method, args) => callRpc(runId, method, args);
  const checkpointScope = new AsyncLocalStorage();
  let checkpoint = null;

  const assertScope = () => {
    const token = checkpointScope.getStore();

    if (token ? token !== checkpoint : checkpoint !== null) throw new Error("await the active edit checkpoint before issuing other commands; completed checkpoints cannot issue commands");
  };

  let operationTail = Promise.resolve();

  const enqueueHost = operation => {
    const next = operationTail.then(operation);
    operationTail = next.then(() => {}, () => {});

    return next;
  };

  const nova = {
    call(name, args) {
      assertScope(); flushReads();

      return swallow(enqueueHost(() => rpc("call", [name, args]).then(leanEnvelope)));
    },
    callMany(calls) {
      assertScope(); flushReads();

      return swallow(enqueueHost(async () => attachCallManyMeta(await rpc("callMany", [calls]))));
    },
    async speculate(fn) {
      if (checkpoint) throw new Error("edit checkpoints cannot overlap or nest; await the current checkpoint");
      const token = {};
      checkpoint = token;

      try { return await runSpeculation(fn, token, checkpointScope, drainReads, enqueueHost, rpc); }
      finally { checkpoint = null; }
    },
  };

  // Coalesce already-started compatible reads without rewriting JS control flow.
  const readState = { queued: [], waves: new Set() };

  function flushReads() {
    const pending = readState.queued;
    readState.queued = [];
    dispatchReadWaves(pending, readState.waves, enqueueHost, rpc);
  }

  async function drainReads() {
    for (;;) {
      flushReads();
      const waves = [...readState.waves];

      if (!waves.length) return;
      await Promise.allSettled(waves);
    }
  }

  const invoke = (name, args) => {
    assertScope(); flushReads();

    return swallow(nova.call(name, args));
  };

  const read = async (p, a, b) => {
    assertScope();
    const args = normalizeRead(gatherReadArgs(p, a, b));
    const decode = value => decodeReadValue(args, value);
    p = args.path;

    if (Array.isArray(p)) {
      const values = await readManyPaths(read, invoke, batchRead, args, p, decode);
      for (const item of p) if (isString(item)) noteReadPath({ path: item }, values);

      return values;
    }

    const readValue = !batchRead
      ? decode(unwrapRead(await invoke("read", args), args))
      : await enqueueCompatibleRead(readState, flushReads, args, decode);
    noteReadPath(args, readValue);

    return readValue;
  };

  const readFiles = new Set();

  function noteReadPath(args, value) {
    if (isString(args.path) && looksLikePath(args.path)) readFiles.add(args.path);
    if (isObject(value) && isString(value.path) && looksLikePath(value.path)) readFiles.add(value.path);
  }

  const write = async (p, content) => {
    const args = isObject(p) ? p : { path: p, content };

    if (args.append !== true && args.replace !== true && isString(args.path) && readFiles.has(args.path)) {
      throw new Error("file was already read this program; use edit(oldText, newText) or edit(view, ...). write({path,content,replace:true}) replaces anyway");
    }

    return unwrapValue(await invoke("write", args));
  };

  const edit = async (p, oldText, newText) => {
    const classified = classifyEdit(p, oldText, newText);

    if (classified.kind === "checkpoint") return nova.speculate(classified.fn);

    return unwrapValue(await invoke(classified.command, classified.args));
  };

  const bash = async (command, opts) => {
    const args = normalizeBash(command, opts);
    command = args.command;
    const res = await invoke("bash", args);

    if (res?.ok === false) throw new Error(formatBashFailure(command, res));

    return markTruncatedOutput(res, unwrapValue(res));
  };

  return { read, write, edit, bash, nova };
}

function makeConsole(runId, limits) {
  let count = 0;
  let truncated = false;

  const markTruncated = () => {
    if (!truncated) post({ op: "logTruncated", runId });
    truncated = true;
  };

  const emit = (...args) => {
    if (count >= limits.maxLogLines) { markTruncated();

 return; }

    count++;
    const line = args.map(encodeConsoleArg).join(" ");
    const clipped = truncateChars(line, limits.maxLogLineChars, "log");

    if (clipped.truncated) markTruncated();
    post({ op: "log", runId, line: clipped.text, truncated: clipped.truncated });
  };

  return { log: emit, warn: emit, error: emit, info: emit, debug: emit };
}

function postFailure(runId, err, location) {
  runActive = false;
  const message = err instanceof Error ? err.message : String(err);
  post({ op: "error", runId, message, location });
}

function denyBuiltin(id) {
  if (isDeniedGuestImport(id)) throw new Error(guestImportMessage(id));
}

let sealedRealm = false;

function sealGuestRealm() {
  if (sealedRealm) return;
  sealedRealm = true;
  if (isFunction(process.getBuiltinModule)) {
    const orig = process.getBuiltinModule.bind(process);
    process.getBuiltinModule = (id) => {
      denyBuiltin(id);

      return orig(id);
    };
  }

  if (isFunction(process.binding)) {
    process.binding = (id) => {
      throw new Error(guestImportMessage(String(id)));
    };
  }

  if (isFunction(process.dlopen)) {
    process.dlopen = () => {
      throw new Error("guest cannot load native modules; use read, edit, write, or bash");
    };
  }

  if (isFunction(process.kill)) {
    // Signals are process-wide: process.kill escapes the worker thread and can
    // terminate the host, so it stays out of the guest. Stop things with bash.
    process.kill = () => {
      throw new Error("process.kill is not available in guest programs; stop processes with bash");
    };
  }
}

async function handleRun(msg) {
  const { runId, prepared, limits, available, batchRead = true } = msg;
  activeRunId = runId;
  runActive = true;
  let compiled;
  sealGuestRealm();

  try {
    // Existing programs may declare their own data variable; bind it only when supplied.
    compiled = compileGuest(prepared, msg.data);
  } catch (err) {
    postFailure(runId, new Error("JavaScript syntax error: " + err.message + "; no commands ran. When passing data, do not redeclare its binding."));

    return;
  }

  const api = buildGuestApi(available, batchRead, runId, msg.nativeArgv === true);
  const scopedConsole = makeConsole(runId, limits);

  try {
    const value = await compiled.fn(
      scopedConsole, api.read, api.edit, api.write, api.bash, msg.data,
    );

    if (runId !== activeRunId) return;
    const plain = plainGuestValue(value);
    runActive = false;
    post({ op: "done", runId, value: plain, undefinedReturn: value === undefined && !compiled.hasReturn, hasReturn: compiled.hasReturn });
  } catch (err) {
    if (runId !== activeRunId) return;
    postFailure(runId, err, guestLocation(err));
  }
}

parentPort.on("message", (msg) => {
  if (!isObject(msg)) return;

  if (msg.op === "rpc:result") {
    handleRpcResult(msg);

    return;
  }

  if (msg.op === "run") void handleRun(msg);
});

post({ op: "ready" });
