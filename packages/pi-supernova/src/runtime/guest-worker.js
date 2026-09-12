import { parentPort } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { isString, isObject, isFunction, isNumber, toPlain, looksLikePath } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";
import { sessionJsonArgs, validateJsonRead } from "../fs/json-read.js";

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

function unwrapRead(res, args) {
  const value = unwrapValue(res);

  if ((args.complete === true || args.json !== undefined) && res?.truncated) throw new Error("incomplete read: complete:true or json refuses truncated host output");

  return value;
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

function quoteShellArg(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function buildGuestApi(available, batchRead, runId, _nativeArgv) {
  const rpc = (method, args) => callRpc(runId, method, args);
  const availableSet = new Set(available);
  const checkpointScope = new AsyncLocalStorage();
  let checkpoint = null;

  const assertScope = () => {
    const token = checkpointScope.getStore();

    if (token ? token !== checkpoint : checkpoint !== null) throw new Error("await the active edit checkpoint before issuing other commands; completed checkpoints cannot issue commands");
  };

  const nova = {
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
        ? nova.call("read", wave[0].args).then(res => ({ values: [unwrapRead(res, wave[0].args)], errors: [] }))
        : nova.call("read", args).then(res => { unwrapRead(res, args);

 return { values: res.items, errors: res.itemErrors ?? [] }; });

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

  const invoke = (name, args) => { assertScope(); flushReads();

 return nova.call(name, args); };

  const readArgs = (p, a, b) => isObject(p) && !Array.isArray(p)
    ? { ...p, path: p.path ?? p.query }
    : isObject(a) && !Array.isArray(a) ? { path: p, ...a } : { path: p, offset: a, limit: b };

  const read = async (p, a, b) => {
    assertScope();
    const args = sessionJsonArgs(readArgs(p, a, b));
    if (isString(args.path) && args.resolve === undefined && args.json === undefined && !looksLikePath(args.path) && !/^(?:agent|artifact):\/\//i.test(args.path)) {
      args.resolve = true;
    }
    validateJsonRead(args);
    const decode = value => args.resolve || args.json !== undefined ? JSON.parse(value) : value;

    if (args.complete === true && (args.outline || args.evidence || args.about)) throw new Error("complete:true requires a raw file read, not an outline or evidence view");
    const evidencePath = isObject(p) && !Array.isArray(p) ? p.path : args.about ? p : undefined;
    p = args.path;

    if (args.evidence) return unwrapJsonValue(await invoke("evidence", { ...args, path: evidencePath, query: args.about ?? args.query ?? p }));

    if (args.outline) return unwrapJsonValue(await invoke("surface", args));

    if (Array.isArray(p)) {
      if (p.length > 64) throw new Error("read accepts at most 64 paths per batch");

      for (const item of p) if (!isString(item) || !item.trim()) throw new Error("read paths must be non-empty strings");
      const readEach = () => Promise.all(p.map(item => read({ ...args, path: item })));

      if (!batchRead || args.resolve || p.some(item => /^(agent|artifact):\/\/.*\?/i.test(item))) return readEach();
      const res = await invoke("read", args);
      const failed = res?.itemErrors?.findIndex(error => error != null) ?? -1;

      if (failed >= 0) throw new Error(`read failed for ${p[failed]}: ${res.itemErrors[failed]}; use Promise.allSettled(paths.map(path => read(path))) for per-path outcomes`);
      unwrapRead(res, args);

      if (Array.isArray(res?.items)) return res.items.map(decode);

      // Captured host executor without batch support: fan out.
      return readEach();
    }

    if (!batchRead) {
      const res = await invoke("read", args);
      unwrapRead(res, args);

      return decode(unwrapRead(res, args));
    }

    const key = JSON.stringify({ ...args, path: undefined });

    if (queuedReads.length && queuedReads[0].key !== key) flushReads();

    return new Promise((resolve, reject) => {
      queuedReads.push({ args, key, resolve, reject });

      if (queuedReads.length === 1) queueMicrotask(flushReads);
    }).then(decode);
  };

  const write = async (p, content) => unwrapValue(await invoke("write", isObject(p) ? p : { path: p, content }));

  const viewSpan = (value) => {
    const start = isNumber(value.start) ? value.start : Array.isArray(value.lines) ? value.lines[0] : value.line;
    const end = isNumber(value.end) ? value.end : Array.isArray(value.lines) && value.lines.length > 1 ? value.lines[1] : start;

    if (!isNumber(start) || !isNumber(end) || start < 1 || end < start) return null;

    return { start: Math.floor(start), end: Math.floor(end) };
  };

  const isView = (value) => isObject(value) && !Array.isArray(value) && isString(value.path) && value.path.trim() && isString(value.text) && (value.status === undefined || value.status === "found") && viewSpan(value);

  const edit = async (p, oldText, newText) => {
    if (isFunction(p)) return nova.speculate(p);
    const usage = 'invalid edit signature; use edit(path,oldText,newText), edit({path,edits:[{oldText,newText}]}), or edit({path,patch:"@@ -1 +1 @@\n-old\n+new\n"})';

    if (isView(p) && isString(oldText) && (newText === undefined || isString(newText))) {
      if (isNumber(p.nextOffset)) throw new Error("edit view is incomplete");
      const span = viewSpan(p);
      const args = { path: p.path, viewStart: span.start, viewEnd: span.end, viewText: p.text, newText: newText === undefined ? oldText : newText };

      if (newText !== undefined) args.oldText = oldText;

      return unwrapValue(await invoke("edit", args));
    }

    if (isObject(p) && (Array.isArray(p) || oldText !== undefined || newText !== undefined)) throw new Error(usage);

    if (!isObject(p) && isObject(oldText) && !Array.isArray(oldText)) throw new Error(usage);
    const args = isObject(p) ? p : Array.isArray(oldText) ? { path: p, edits: oldText } : { path: p, oldText, newText };

    if (!isString(args.path) || !args.path.trim()) throw new Error(usage);
    const modes = Number(args.patch !== undefined) + Number(args.edits !== undefined) + Number(args.oldText !== undefined || args.newText !== undefined);

    if (modes !== 1 || (Array.isArray(oldText) && newText !== undefined)) throw new Error(usage);

    if (args.patch !== undefined) {
      if (!isString(args.patch) || !args.patch.trim()) throw new Error(usage);
    } else {
      const edits = args.edits === undefined ? [args] : args.edits;

      if (!Array.isArray(edits) || !edits.length) throw new Error(usage);

      for (const e of edits) if (!isString(e?.oldText) || !e.oldText.length || !isString(e?.newText)) throw new Error(usage + "; replacements require non-empty oldText and string newText");
    }

    return unwrapValue(await invoke(args.patch === undefined ? "edit" : "apply_patch", args));
  };

  const bash = async (command, opts) => {
    const args = isObject(command) ? { ...command } : { command, ...opts };

    if (args.args !== undefined) {
      if (!isString(args.command) || !Array.isArray(args.args)) throw new Error("bash argv requires a command string and an array of string args");

      for (let i = 0; i < args.args.length; i++) if (!isString(args.args[i])) throw new Error("bash argv requires a command string and an array of string args");

      // Literal argv is a Supernova-owned contract. Host bash tools often ignore
      // `args` and would run only `command` (bare `ssh`). Windows still needs a shell.
      if (process.platform === "win32") {
        delete args._directArgv;
        args.command = [args.command, ...args.args].map(quoteShellArg).join(" ");
        delete args.args;
      } else args._directArgv = true;
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

  return { read, write, edit, bash };
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
    // Existing programs may declare their own data variable; bind it only when supplied.
    const bindings = msg.data === undefined ? PARAMS : [...PARAMS, "data"];
    compiled = { fn: new AsyncFunction(...bindings, prepared.body), hasReturn: prepared.hasReturn };
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
