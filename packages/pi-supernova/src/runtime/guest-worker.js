import { parentPort } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { isString, isObject, isFunction, toPlain } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";

// Guest programs run here, off the host thread. The host can terminate() this
// worker mid-loop, so a runaway "while (true) {}" or process.exit() in guest
// code cannot take the harness down with it.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const PARAMS = ["console", "read", "edit", "write", "bash"];
const BODY_LINE_OFFSET = 2;
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

function unwrapJsonValue(res) {
  const value = unwrapValue(res);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Keep details/truncated reachable but out of the returned literal unless they carry signal. */
function leanEnvelope(res) {
  if (!isObject(res)) return res;
  if ("details" in res) Object.defineProperty(res, "details", { value: res.details, enumerable: false, writable: true });
  for (const key of Object.keys(res)) if (res[key] === undefined) delete res[key];
  if (res.truncated === false) delete res.truncated;
  return res;
}

function buildGuestApi(available, batchRead, runId) {
  const rpc = (method, args) => callRpc(runId, method, args);
  const availableSet = new Set(available);
  const checkpointScope = new AsyncLocalStorage();
  let checkpoint = null;
  const assertScope = () => {
    const token = checkpointScope.getStore();
    if (token ? token !== checkpoint : checkpoint !== null) throw new Error("await the active edit checkpoint before issuing other commands; completed checkpoints cannot issue commands");
  };
  const nova = {
    search: (query, limit) => rpc("search", [query, limit]),
    describe: (name) => rpc("describe", [name]),
    call: async (name, args) => leanEnvelope(await rpc("call", [name, args])),
    async callMany(calls) {
      const wave = await rpc("callMany", [calls]);
      const results = Array.isArray(wave?.results) ? wave.results : Array.isArray(wave) ? wave : [];
      Object.defineProperties(results, {
        mode: { value: wave?.mode, enumerable: false },
        reason: { value: wave?.reason, enumerable: false },
        results: { value: results, enumerable: false },
      });
      return results;
    },
    async speculate(fn) {
      if (checkpoint) throw new Error("edit checkpoints cannot overlap or nest; await the current checkpoint");
      const token = {};
      checkpoint = token;
      let began = false;
      try {
        flushReads();
        await rpc("speculateBegin", []);
        began = true;
        const value = await checkpointScope.run(token, fn);
        flushReads();
        await rpc("speculateCommit", []);
        return { ok: true, committed: true, value };
      } catch (err) {
        flushReads();
        if (began) await rpc("speculateRollback", []);
        return { ok: false, committed: false, error: err instanceof Error ? err.message : String(err) };
      } finally { checkpoint = null; }
    },
    surface: async (filePath) => unwrapJsonValue(await rpc("call", ["surface", { path: filePath }])),
    evidence: async (query, opts) => unwrapJsonValue(await rpc("call", ["evidence", { query, ...opts }])),
    snap: async (query, targetPath) => unwrapJsonValue(await rpc("call", ["snap", { query, path: targetPath }])),
    has: (name) => availableSet.has(name),
  };

  // Coalesce already-started compatible reads without rewriting JS control flow.
  let queuedReads = [];
  function flushReads() {
    const pending = queuedReads;
    queuedReads = [];
    for (let start = 0; start < pending.length; start += 64) {
      const wave = pending.slice(start, start + 64);
      const args = { ...wave[0].args, path: wave.map(job => job.args.path), _independent: true };
      const run = wave.length === 1
        ? nova.call("read", wave[0].args).then(res => ({ values: [unwrapValue(res)], errors: [] }))
        : nova.call("read", args).then(res => { unwrapValue(res); return { values: res.items, errors: res.itemErrors ?? [] }; });
      void run.then(({ values, errors }) => {
        if (!Array.isArray(values) || values.length !== wave.length) throw new Error("invalid batch read response");
        for (let i = 0; i < wave.length; i++) {
          const value = values[i];
          if (errors[i]) wave[i].reject(new Error(errors[i]));
          else wave[i].resolve(value);
        }
      }).catch(error => { for (const job of wave) job.reject(error); });
    }
  }
  const invoke = (name, args) => { assertScope(); flushReads(); return nova.call(name, args); };
  const readArgs = (p, a, b) => isObject(p) && !Array.isArray(p)
    ? { ...p, path: p.path ?? p.query }
    : isObject(a) && !Array.isArray(a) ? { path: p, ...a } : { path: p, offset: a, limit: b };
  const read = async (p, a, b) => {
    assertScope();
    const args = readArgs(p, a, b);
    const evidencePath = isObject(p) && !Array.isArray(p) ? p.path : args.about ? p : undefined;
    p = args.path;
    if (args.evidence) return unwrapJsonValue(await invoke("evidence", { ...args, path: evidencePath, query: args.about ?? args.query ?? p }));
    if (args.outline) return unwrapJsonValue(await invoke("surface", args));
    if (Array.isArray(p)) {
      if (p.length > 64) throw new Error("read accepts at most 64 paths per batch");
      if (p.some(item => !isString(item) || !item.trim())) throw new Error("read paths must be non-empty strings");
      const readEach = () => Promise.all(p.map(async item => {
        try { return await read({ ...args, path: item }); }
        catch (error) { return `[read error: ${item}] ${error.message}`; }
      }));
      if (!batchRead) return readEach();
      const res = await invoke("read", args);
      unwrapValue(res);
      if (Array.isArray(res?.items)) return res.items;
      // Captured host executor without batch support: fan out.
      return readEach();
    }
    if (!batchRead) return unwrapValue(await invoke("read", args));
    const key = JSON.stringify({ ...args, path: undefined });
    if (queuedReads.length && queuedReads[0].key !== key) flushReads();
    return new Promise((resolve, reject) => {
      queuedReads.push({ args, key, resolve, reject });
      if (queuedReads.length === 1) queueMicrotask(flushReads);
    });
  };
  const write = async (p, content) => unwrapValue(await invoke("write", isObject(p) ? p : { path: p, content }));
  const edit = async (p, oldText, newText) => {
    if (isFunction(p)) return nova.speculate(p);
    const args = isObject(p) ? p : Array.isArray(oldText) ? { path: p, edits: oldText } : { path: p, oldText, newText };
    return unwrapValue(await invoke(args.patch === undefined ? "edit" : "apply_patch", args));
  };
  const patch = async (p, diff) => unwrapValue(await nova.call("apply_patch", { path: p, patch: diff }));
  const bash = async (command, opts) => {
    const args = isObject(command) ? { ...command } : { command, ...opts };
    if (args.args !== undefined) {
      if (!isString(args.command) || !Array.isArray(args.args) || args.args.some(arg => !isString(arg))) throw new Error("bash argv requires a command string and an array of string args");
      args.command = [args.command, ...args.args].map(quoteShellArg).join(" ");
    }
    command = args.command;
    if (args.timeout !== undefined && args.timeoutMs === undefined) args.timeoutMs = args.timeout * 1000;
    const res = await invoke("bash", args);
    if (res?.ok === false) {
      let exitCode;
      try {
        exitCode = JSON.parse(res.details).exitCode;
      } catch {}
      const output = String(res.value).trimEnd();
      const suffix = Number.isInteger(exitCode) ? " (exit " + exitCode + ")" : "";
      throw new Error("command failed" + suffix + ": " + command + (output ? "\n" + output : ""));
    }
    let text = unwrapValue(res);
    if (res?.truncated && isString(text) && !text.includes("truncated")) text += "\n…[output truncated]…";
    return text;
  };
  const quoteShellArg = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const exec = async (cmd, args, opts) => {
    const command = String(cmd ?? "").trim();
    if (!command) throw new Error("exec requires command");
    // exec("git status") is a shell line; exec("git", ["status"]) is argv.
    if (!Array.isArray(args) || args.length === 0) return bash(command, opts);
    return bash([command, ...args].map(quoteShellArg).join(" "), opts);
  };

  return { nova, read, write, edit, patch, surface: nova.surface, snap: nova.snap, evidence: nova.evidence, bash, exec, speculate: nova.speculate };
}

function makeConsole(runId, limits) {
  let count = 0;
  let truncated = false;
  const markTruncated = () => {
    if (!truncated) post({ op: "logTruncated", runId });
    truncated = true;
  };
  const emit = (...args) => {
    if (count >= limits.maxLogLines) { markTruncated(); return; }
    count++;
    const line = args
      .map((a) => {
        if (isString(a)) return a;
        try {
          return JSON.stringify(toPlain(a));
        } catch {
          return String(a);
        }
      })
      .join(" ");
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

async function handleRun(msg) {
  const { runId, prepared, limits, available, batchRead = true } = msg;
  activeRunId = runId;
  runActive = true;
  let compiled;
  try {
    compiled = { fn: new AsyncFunction(...PARAMS, prepared.body), hasReturn: prepared.hasReturn };
  } catch (err) {
    postFailure(runId, err);
    return;
  }
  const api = buildGuestApi(available, batchRead, runId);
  const scopedConsole = makeConsole(runId, limits);
  try {
    const value = await compiled.fn(
      scopedConsole, api.read, api.edit, api.write, api.bash,
    );
    if (runId !== activeRunId) return;
    let plain;
    try {
      plain = toPlain(value);
    } catch (err) {
      plain = "[unserializable: " + (err?.message || err) + "]";
    }
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
    const pending = pendingRpc.get(msg.id);
    if (!pending) return;
    pendingRpc.delete(msg.id);
    if (msg.ok) pending.resolve(msg.value);
    else pending.reject(new Error(msg.error));
    return;
  }
  if (msg.op === "run") void handleRun(msg);
});

post({ op: "ready" });
