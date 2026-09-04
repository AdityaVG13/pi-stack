import { parentPort } from "node:worker_threads";
import { parallel as runParallel, pipeline as runPipeline } from "./parallel.js";
import { isString, isObject, toPlain } from "./decode.js";
import { truncateChars } from "./format.js";

// Guest programs run here, off the host thread. The host can terminate() this
// worker mid-loop, so a runaway "while (true) {}" or process.exit() in guest
// code cannot take the harness down with it.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const PARAMS = ["nova", "console", "parallel", "pipeline", "read", "write", "edit", "patch", "surface", "snap", "evidence", "bash", "exec", "speculate"];
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
      await rpc("speculateBegin", []);
      try {
        const value = await fn();
        await rpc("speculateCommit", []);
        return { ok: true, committed: true, value };
      } catch (err) {
        await rpc("speculateRollback", []);
        return { ok: false, committed: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    surface: async (filePath) => unwrapJsonValue(await rpc("call", ["surface", { path: filePath }])),
    evidence: async (query, opts) => unwrapJsonValue(await rpc("call", ["evidence", { query, ...opts }])),
    snap: async (query, targetPath) => unwrapJsonValue(await rpc("call", ["snap", { query, path: targetPath }])),
    has: (name) => availableSet.has(name),
  };

  // read(path, offset?, limit?) or read(path, { about, offset, limit, maxChars })
  const readArgs = (p, a, b) => (isObject(a) && !Array.isArray(a) ? { path: p, ...a } : { path: p, offset: a, limit: b });
  const read = async (p, a, b) => {
    if (Array.isArray(p)) {
      if (!batchRead) return Promise.all(p.map(item => read(item, a, b)));
      const res = await nova.call("read", readArgs(p, a, b));
      unwrapValue(res);
      if (Array.isArray(res?.items)) return res.items;
      // Captured host executor without batch support: fan out.
      return Promise.all(p.map((item) => read(item, a, b)));
    }
    return unwrapValue(await nova.call("read", readArgs(p, a, b)));
  };
  const write = async (p, content) => unwrapValue(await nova.call("write", { path: p, content }));
  const edit = async (p, oldText, newText) => unwrapValue(await nova.call("edit", { path: p, oldText, newText }));
  const patch = async (p, diff) => unwrapValue(await nova.call("apply_patch", { path: p, patch: diff }));
  const bash = async (command, opts) => {
    const res = await nova.call("bash", { command, ...opts });
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
      api.nova, scopedConsole, runParallel, runPipeline,
      api.read, api.write, api.edit, api.patch, api.surface, api.snap, api.evidence, api.bash, api.exec, api.speculate,
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
