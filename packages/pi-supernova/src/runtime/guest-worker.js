import {buildGuestApi} from "./guest-api.js";
import {packageFinalReturn} from "../output/final.js";
import { parentPort } from "node:worker_threads";

import * as nodeModule from "node:module";
import { errorMessage, isString, isObject, isFunction, toPlain } from "../shared/decode.js";
import { truncateChars,formatReturn,displayExceeds,formatBoundedValue } from "../output/format.js";

import { guestImportMessage, isDeniedGuestImport } from "./guest-deny-imports.js";

const { register, registerHooks } = nodeModule;
// heapUsed/external belong to this worker; rss includes the entire Pi/OMP host.
const memoryUsage = process.memoryUsage.bind(process);

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

/** Only match the guest source, never an anonymous callback in the host bridge. */
function guestLocation(err) {
  const stack = String(err?.stack);
  const m = /^\s+at (async )?[^\n]*\(supernova-guest\.js:(\d+):(\d+)\)$/m.exec(stack);

  if (!m) return null;
  const line = Number(m[2]) - BODY_LINE_OFFSET;

  if (line < 1) return null;

  return { line, col: Number(m[3]), awaited: Boolean(m[1]) };
}

let activeRunId = 0;

let runActive = false;

let rpcSeq = 0;

const pendingRpc = new Map();

function post(msg) {
  parentPort.postMessage(msg);
}

function reportMemory(runId) {
  if (!runActive || runId !== activeRunId) return;
  const { heapUsed, external } = memoryUsage();
  // arrayBuffers is already included in external; do not double-charge it.
  post({ op: "memory", runId, heapUsed, external });
}

function callRpc(runId, method, args, onItem) {
  if (!runActive || runId !== activeRunId) return Promise.reject(new Error("program is already complete"));

  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pendingRpc.set(id, { resolve, reject, onItem });

    try {
      reportMemory(runId);
      post({ op: "rpc", id, runId, method, args, streamRead: Boolean(onItem) });
    } catch (err) {
      pendingRpc.delete(id);
      reject(new Error("nova." + method + " arguments are not transferable: " + err?.message));
    }
  });
}

function encodeConsoleArg(a, limit) {
  if (isString(a)) {
    const raw = truncateChars(a,limit,"log");
    const encoded = truncateChars(formatReturn(raw.text),limit,"log");
    encoded.truncated ||= raw.truncated;
    return encoded;
  }
  try {
    const plain = toPlain(a);
    if (displayExceeds(plain,limit)) return {text:formatBoundedValue(plain,limit,"log"),truncated:true};
    const encoded = JSON.stringify(plain);
    return truncateChars(encoded === undefined ? String(plain) : encoded,limit,"log");
  } catch { return truncateChars(formatReturn(String(a)),limit,"log"); }
}

function compileGuest(prepared, data) {
  const bindings = data === undefined ? PARAMS : [...PARAMS, "data"];

  return { fn: new AsyncFunction(...bindings, prepared.body + "\n//# sourceURL=supernova-guest.js"), hasReturn: prepared.hasReturn };
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

function handleReadItem(msg) {
  const pending = pendingRpc.get(msg.id);
  if (!pending?.onItem || !runActive || msg.runId !== activeRunId) return;
  let error;
  try { pending.onItem(msg.index,msg.value); }
  catch (err) { error = errorMessage(err); pending.reject(err); pendingRpc.delete(msg.id); }
  reportMemory(activeRunId);
  post({op:"rpc:ack",id:msg.id,index:msg.index,runId:activeRunId,error});
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
    let line = "", first = true;
    for (const arg of args) {
      const room = limits.maxLogLineChars-line.length-(first ? 0 : 1);
      if (room <= 0) { markTruncated(); break; }
      const encoded = encodeConsoleArg(arg,room);
      if (encoded.truncated) markTruncated();
      line += (first ? "" : " ")+encoded.text;
      first = false;
    }
    const clipped = truncateChars(line, limits.maxLogLineChars, "log");

    if (clipped.truncated) markTruncated();
    post({ op: "log", runId, line: clipped.text, truncated: clipped.truncated });
  };

  return { log: emit, warn: emit, error: emit, info: emit, debug: emit };
}

function postFailure(runId, err, location) {
  runActive = false;
  const message = errorMessage(err);
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
  const { runId, prepared, limits, batchRead = true } = msg;
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

  const api = buildGuestApi((method, args, onItem) => callRpc(runId, method, args, onItem), batchRead);
  const scopedConsole = makeConsole(runId, limits);
  const memoryTimer = setInterval(() => reportMemory(runId), 50);

  try {
    const value = await compiled.fn(
      scopedConsole, api.read, api.edit, api.write, api.bash, msg.data,
    );

    if (runId !== activeRunId) return;
    const plain = plainGuestValue(value);
    // Reduce model output while it is still covered by worker memory/deadlines.
    // Only a bounded display and retained images cross back to the Pi/OMP host.
    const result = msg.formatResult ? {output:packageFinalReturn(plain,[],limits)} : {value:plain};
    reportMemory(runId);
    runActive = false;
    post({ op:"done",runId,...result,undefinedReturn:value === undefined && !compiled.hasReturn,hasReturn:compiled.hasReturn });
  } catch (err) {
    if (runId !== activeRunId) return;
    postFailure(runId, err, guestLocation(err));
  } finally { clearInterval(memoryTimer); }
}

parentPort.on("message", (msg) => {
  if (!isObject(msg)) return;

  if (msg.op === "rpc:item") { handleReadItem(msg); return; }

  if (msg.op === "rpc:result") {
    handleRpcResult(msg);

    return;
  }

  if (msg.op === "run") void handleRun(msg);
});

post({ op: "ready" });
