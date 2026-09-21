import {AsyncLocalStorage} from 'node:async_hooks';
import {isString,isObject,looksLikePath} from '../shared/decode.js';
import {truncateChars} from '../output/format.js';
import {gatherReadArgs,normalizeRead,decodeReadValue,assertReadPaths} from '../contract/read.js';
import {classifyEdit} from '../contract/edit.js';
import {normalizeBash} from '../contract/bash.js';

const PER_PATH_HINT = "; use Promise.allSettled(paths.map(path => read(path))) for per-path outcomes";

function unwrapValue(res) {
  if (res?.ok === false) throw new Error(String(res.value ?? res.error ?? "host tool failed"));

  if ("value" in Object(res)) return res.value;

  return res;
}

function unwrapRead(res, args) {
  const value = unwrapValue(res);

  if ((args.complete === true || args.json !== undefined) && res?.truncated) throw new Error("incomplete read: complete:true or json refuses truncated host output");

  return decodeReadItem(args, value, res);
}

function decodeReadItem(args, value, res) {
  if (!res?.typed) return decodeReadValue(args, value);
  // JSON selectors used to cross RPC as separately encoded JSON values. Keep
  // their mutable results independent, but put the copies in the guest heap.
  return res.cloneItems ? value.map(item => structuredClone(item)) : value;
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

function missingResolvedIndex(values, paths) {
  return values.findIndex((value, index) => value?.status === "not_found" && looksLikePath(paths[index]));
}

function settleReadItem(wave, index, res) {
  const job = wave[index];
  if (!job) throw new Error("invalid streamed read index: " + index);
  wave[index] = null; // Release resolver closures and their potentially large values.
  try { job.resolve(unwrapRead(res,job.args)); }
  catch (error) { job.reject(error); }
}

function settleInlineWave(wave,res,received) {
  unwrapValue(res);
  if (received || !Array.isArray(res.items) || res.items.length !== wave.length) throw new Error("invalid batch read response");
  for (let i=0;i<wave.length;i++) {
    const error = res.itemErrors?.[i];
    settleReadItem(wave,i,{...res,ok:!error,value:error ?? res.items[i],items:undefined});
  }
}

async function rpcReadWave(rpc, wave) {
  if (wave.length === 1) {
    const res = leanEnvelope(await rpc("call",["read",wave[0].args]));
    settleReadItem(wave,0,res);
    return;
  }
  const args = {...wave[0].args,path:wave.map(job=>job.args.path),_independent:true};
  let received = 0, last;
  const onItem = (index,res) => {
    if (!Number.isInteger(index) || !wave[index] || last?.index === index) throw new Error("invalid streamed read response");
    received++;
    // Keep the final read pending until the host RPC/barrier itself has settled.
    // An awaited batch must never look complete while its host call is running.
    if (received === wave.length) last = {index,res};
    else settleReadItem(wave,index,res);
  };
  const res = leanEnvelope(await rpc("call",["read",args],onItem));
  if (res?.streamed) {
    if (received !== wave.length || !last) throw new Error("incomplete streamed read response");
    settleReadItem(wave,last.index,last.res);
    return;
  }
  settleInlineWave(wave,res,received);
}

function rejectReadWave(wave, error) {
  for (const job of wave) job?.reject(error);
}

function dispatchReadWaves(pending, pendingReadWaves, rpc) {
  for (let start=0;start<pending.length;start+=64) {
    const wave = pending.slice(start,start+64);
    const delivery = rpcReadWave(rpc,wave).catch(error=>rejectReadWave(wave,error));
    pendingReadWaves.add(delivery);
    void delivery.finally(()=>pendingReadWaves.delete(delivery));
  }
}

function enqueueCompatibleRead(readState, flushReads, args) {
  const key = JSON.stringify({ ...args, path: undefined });

  if (readState.queued.length && readState.queued[0].key !== key) flushReads();

  const promise = new Promise((resolve, reject) => {
    readState.queued.push({ args, key, resolve, reject });

    if (readState.queued.length === 1) queueMicrotask(flushReads);
  });

  return swallow(promise);
}

async function readManyPaths(readOne, args, paths) {
  assertReadPaths(paths);
  const values = await Promise.all(paths.map(async item => {
    try { return await readOne({...args,path:item}); }
    catch (error) { throwReadPathError(item,error.message); }
  }));
  const missing = args.resolve ? missingResolvedIndex(values,paths) : -1;
  if (missing >= 0) throwReadPathError(paths[missing],"not_found");
  return values;
}

async function runSpeculation(fn, token, checkpointScope, drainReads, rpc) {
  let began = false;

  try {
    await drainReads();
    await rpc("speculateBegin", []);
    began = true;
    const value = await checkpointScope.run(token, fn);
    await drainReads();
    await rpc("speculateCommit", []);

    return { ok: true, committed: true, value };
  } catch (err) {
    await drainReads();

    if (began) await rpc("speculateRollback", []);

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

export function buildGuestApi(rpc, batchRead) {
  const checkpointScope = new AsyncLocalStorage();
  let checkpoint = null;

  const assertScope = () => {
    const token = checkpointScope.getStore();

    if (token ? token !== checkpoint : checkpoint !== null) throw new Error("await the active edit checkpoint before issuing other commands; completed checkpoints cannot issue commands");
  };

  // Post calls in submission order. The host alone owns file concurrency and
  // read/shell/checkpoint barriers; a second guest queue would serialize edits.
  async function checkpointEdit(fn) {
    if (checkpoint) throw new Error("edit checkpoints cannot overlap or nest; await the current checkpoint");
    const token = {};
    checkpoint = token;
    try { return await runSpeculation(fn, token, checkpointScope, drainReads, rpc); }
    finally { checkpoint = null; }
  }

  // Coalesce already-started compatible reads without rewriting JS control flow.
  const readState = { queued: [], waves: new Set() };

  function flushReads() {
    const pending = readState.queued;
    readState.queued = [];
    dispatchReadWaves(pending, readState.waves, rpc);
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

    return swallow(rpc("call", [name, args]).then(leanEnvelope));
  };

  const read = async (p, a, b) => {
    assertScope();
    const args = normalizeRead(gatherReadArgs(p, a, b));
    p = args.path;

    if (Array.isArray(p)) {
      const values = await readManyPaths(read, args, p);
      for (const item of p) if (isString(item)) noteReadPath({ path: item }, values);

      return values;
    }

    const readValue = !batchRead
      ? unwrapRead(await invoke("read", args), args)
      : await enqueueCompatibleRead(readState, flushReads, args);
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

    if (classified.kind === "checkpoint") return checkpointEdit(classified.fn);

    return unwrapValue(await invoke(classified.command, classified.args));
  };

  const bash = async (command, opts) => {
    const args = normalizeBash(command, opts);
    command = args.command;
    const res = await invoke("bash", args);

    if (res?.ok === false) throw new Error(formatBashFailure(command, res));

    return markTruncatedOutput(res, unwrapValue(res));
  };

  return { read, write, edit, bash };
}
