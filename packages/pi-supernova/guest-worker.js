import { parentPort } from "node:worker_threads";
import { parallel as runParallel, pipeline as runPipeline } from "./parallel.js";
import { isString, isFunction, isObject } from "./decode.js";

// Guest programs run here, off the host thread. The host can terminate() this
// worker mid-loop, so a runaway "while (true) {}" or process.exit() in guest
// code cannot take the harness down with it.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const compiledCache = new Map();
const COMPILED_CACHE_MAX = 256;
const PARAMS = [
  "nova", "tools", "console", "parallel", "pipeline",
  "read", "write", "edit", "patch", "surface", "snap", "bash", "exec", "speculate",
];
// V8 and JSC both place the body on the line after the synthesized header.
const BODY_LINE_OFFSET = 2;

function skipLeadingComments(src) {
  let i = 0;
  for (;;) {
    while (/\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return src.length;
      i = nl + 1;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return src.length;
      i = end + 2;
    } else {
      return i;
    }
  }
}

function skipString(src, j, quote) {
  for (j++; j < src.length && src[j] !== quote; j++) if (src[j] === "\\") j++;
  return j;
}

function skipBalancedParens(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return j + 1;
      continue;
    }
    if ("\"'\u0060".includes(ch)) j = skipString(src, j, ch);
  }
  return -1;
}

/** True when src (after comments) is a single arrow or function expression. */
function isFunctionExpression(src) {
  let i = skipLeadingComments(src);
  const rest = src.slice(i);
  if (/^(async\s+)?function\b/.test(rest)) return true;
  const asyncMatch = /^async\s+/.exec(rest);
  if (asyncMatch) i += asyncMatch[0].length;
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(src.slice(i))) return true;
  if (src[i] !== "(") return false;
  const after = skipBalancedParens(src, i);
  if (after < 0) return false;
  return /^\s*=>/.test(src.slice(after));
}

function wrapBody(code) {
  const trimmed = String(code).trim();
  if (!trimmed) throw new Error("code must be a non-empty string");
  if (isFunctionExpression(trimmed)) return "const __fn = (" + trimmed + ");\nreturn await __fn();";
  return trimmed;
}

function compile(code) {
  const body = wrapBody(code);
  let compiled = compiledCache.get(body);
  if (compiled) return compiled;
  compiled = new AsyncFunction(...PARAMS, body);
  if (compiledCache.size >= COMPILED_CACHE_MAX) {
    compiledCache.delete(compiledCache.keys().next().value);
  }
  compiledCache.set(body, compiled);
  return compiled;
}

/** Best-effort guest line:col from an error stack (V8 "<anonymous>:L:C", JSC "eval code").*/
function guestLocation(err) {
  const stack = String(err?.stack);
  const m = /(?:<anonymous>:|(?:eval code|anonymous)(?:@|:))(\d+):(\d+)/.exec(stack);
  if (!m) return null;
  const line = Number(m[1]) - BODY_LINE_OFFSET;
  if (line < 1) return null;
  return { line, col: Number(m[2]) };
}

const MAX_DEPTH = 64;
const MAX_TYPED_ARRAY = 4096;

function plainFromBinary(value) {
  const bytes = value.byteLength;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (value.length > MAX_TYPED_ARRAY) return "[" + value.constructor.name + " " + bytes + " bytes]";
  return Array.from(value, (x) => (typeof x === "bigint" ? x.toString() + "n" : x));
}

function plainFromMap(value, seen, depth) {
  const allStringKeys = [...value.keys()].every((k) => typeof k === "string");
  if (!allStringKeys) return [...value].map(([k, v]) => [toPlain(k, seen, depth + 1), toPlain(v, seen, depth + 1)]);
  const out = {};
  for (const [k, v] of value) out[k] = toPlain(v, seen, depth + 1);
  return out;
}

function plainFromCollection(value, seen, depth) {
  if (Array.isArray(value)) return value.map((x) => toPlain(x, seen, depth + 1));
  if (value instanceof Set) return [...value].map((x) => toPlain(x, seen, depth + 1));
  if (value instanceof Map) return plainFromMap(value, seen, depth);
  const out = {};
  for (const k of Object.keys(value)) out[k] = toPlain(value[k], seen, depth + 1);
  return out;
}

/** Convert any guest value to structured-clone-safe, JSON-shaped data. */
function toPlain(value, seen = new Set(), depth = 0) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return value.toString() + "n";
  if (t === "function") return "[Function" + (value.name ? " " + value.name : "") + "]";
  if (t === "symbol") return value.toString();
  if (depth > MAX_DEPTH) return "[Depth]";
  if (seen.has(value)) return "[Circular]";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    if (value.cause !== undefined) out.cause = toPlain(value.cause, seen, depth + 1);
    return out;
  }
  if (value instanceof Promise) return "[Promise]";
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return plainFromBinary(value);
  if (isFunction(value.toJSON)) return toPlain(value.toJSON(), seen, depth + 1);
  seen.add(value);
  try {
    return plainFromCollection(value, seen, depth);
  } finally {
    seen.delete(value);
  }
}

// ---- RPC to the host thread ----

let activeRunId = 0;
let rpcSeq = 0;
const pendingRpc = new Map();

function post(msg) {
  parentPort.postMessage(msg);
}

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pendingRpc.set(id, { resolve, reject });
    try {
      post({ op: "rpc", id, runId: activeRunId, method, args });
    } catch (err) {
      pendingRpc.delete(id);
      reject(new Error("nova." + method + " arguments are not transferable: " + err?.message));
    }
  });
}

function unwrapValue(res) {
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

function buildGuestApi(available) {
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
    surface: async (filePath) => unwrapJsonValue(await rpc("surface", [filePath])),
    snap: async (query, targetPath) => unwrapJsonValue(await rpc("snap", [query, targetPath])),
    has: (name) => availableSet.has(name),
  };

  const read = async (p, offset, limit) => {
    if (Array.isArray(p)) {
      const res = await nova.call("read", { path: p, offset, limit });
      if (Array.isArray(res?.items)) return res.items;
      // Captured host executor without batch support: fan out.
      return Promise.all(p.map((item) => read(item, offset, limit)));
    }
    return unwrapValue(await nova.call("read", { path: p, offset, limit }));
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

  return { nova, read, write, edit, patch, surface: nova.surface, snap: nova.snap, bash, exec, speculate: nova.speculate };
}

function makeConsole(runId, limits) {
  let count = 0;
  const emit = (...args) => {
    if (count >= limits.maxLogLines) return;
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
    post({ op: "log", runId, line: line.length > limits.maxLogLineChars ? line.slice(0, limits.maxLogLineChars) + "…" : line });
  };
  return { log: emit, warn: emit, error: emit, info: emit, debug: emit };
}

function postFailure(runId, err, location) {
  const message = err instanceof Error ? err.message : String(err);
  post({ op: "error", runId, message, location });
}

async function handleRun(msg) {
  const { runId, code, limits, available } = msg;
  activeRunId = runId;
  let compiled;
  try {
    compiled = compile(code);
  } catch (err) {
    postFailure(runId, err);
    return;
  }
  const api = buildGuestApi(available);
  const scopedConsole = makeConsole(runId, limits);
  try {
    const value = await compiled(
      api.nova, api.nova, scopedConsole, runParallel, runPipeline,
      api.read, api.write, api.edit, api.patch, api.surface, api.snap, api.bash, api.exec, api.speculate,
    );
    if (runId !== activeRunId) return;
    let plain;
    try {
      plain = toPlain(value);
    } catch (err) {
      plain = "[unserializable: " + (err?.message || err) + "]";
    }
    post({ op: "done", runId, value: plain, undefinedReturn: value === undefined, hasReturn: /\breturn\b/.test(code) });
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
