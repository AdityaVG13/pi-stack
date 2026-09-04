
import { packageFinalReturn } from "./bottleneck.js";
import { parallel as runParallel, pipeline as runPipeline } from "./parallel.js";
import { performance } from "node:perf_hooks";
import { isString, isFunction, isObject } from "./decode.js";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const compiledCache = new Map();
const COMPILED_CACHE_MAX = 256;

function wrapBody(code) {
  const trimmed = String(code || "").trim();
  if (!trimmed) throw new Error("code must be a non-empty string");

  if (/^(async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed)) {
    return `const __fn = (${trimmed});\nreturn await __fn();`;
  }
  if (/^async\s+function\b/.test(trimmed) || /^function\b/.test(trimmed)) {
    return `const __fn = (${trimmed});\nreturn await __fn();`;
  }
  return trimmed;
}

export async function runGuestProgram(options) {
  const { code, nova, config, signal, onTimeout } = options;
  const maxCode = config.maxCodeChars ?? 48000;
  if (code.length > maxCode) {
    return {
      ok: false,
      error: `code exceeds ${maxCode} characters`,
      logs: [],
      wallMs: 0,
    };
  }

  const logs = [];
  const started = performance.now();
  const timeoutMs = config.timeoutMs ?? 60000;

  const scopedConsole = {
    log: (...args) => pushLog(logs, args, config),
    warn: (...args) => pushLog(logs, args, config),
    error: (...args) => pushLog(logs, args, config),
    info: (...args) => pushLog(logs, args, config),
  };

  let body;
  try {
    body = wrapBody(code);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
      wallMs: Math.round(performance.now() - started),
    };
  }

  let compiled = compiledCache.get(body);
  if (!compiled) {
    try {
      compiled = new AsyncFunction(
        "nova",
        "tools",
        "console",
        "parallel",
        "pipeline",
        "read",
        "write",
        "edit",
        "patch",
        "surface",
        "snap",
        "bash",
        "exec",
        "speculate",
        body,
      );
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        wallMs: Math.round(performance.now() - started),
      };
    }
    if (compiledCache.size >= COMPILED_CACHE_MAX) {
      const first = compiledCache.keys().next().value;
      if (first !== undefined) compiledCache.delete(first);
    }
    compiledCache.set(body, compiled);
  }

  const abortError = new Error("supernova timed out or aborted");
  const timeoutPromise = sleepReject(timeoutMs, abortError, signal, () => {
    try {
      onTimeout?.();
    } catch {
    }
  });

  const unwrapValue = (res) => {
    if (res && isObject(res) && "value" in res) {
      if (res.details?.isSnap && isString(res.value)) {
        try {
          return JSON.parse(res.value);
        } catch {
          return res.value;
        }
      }
      if (res.details?.batch && Array.isArray(res.details?.items)) {
        return res.details.items;
      }
      return res.value;
    }
    return res;
  };

  const unwrapJsonValue = (res) => {
    const value = unwrapValue(res);
    if (!isString(value)) return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };

  const guestRead = async (p, off, lim) => {
    if (Array.isArray(p)) {
      return await Promise.all(p.map((item) => guestRead(item, off, lim)));
    }
    const res = await nova.call("read", { path: p, offset: off, limit: lim });
    return unwrapValue(res);
  };
  const guestWrite = async (p, c) => unwrapValue(await nova.call("write", { path: p, content: c }));
  const guestEdit = async (p, oldOrDiff, newText) => {
    const res = await nova.call("edit", { path: p, oldText: oldOrDiff, newText });
    return unwrapValue(res);
  };
  const guestPatch = async (p, d) => unwrapValue(await nova.call("apply_patch", { path: p, patch: d }));
  const guestSurface = async (p) => {
    const res = await (isFunction(nova.surface) ? nova.surface(p) : nova.call("surface", { path: p }));
    return unwrapJsonValue(res);
  };
  const guestSnap = async (q, p) => {
    const res = await (isFunction(nova.snap) ? nova.snap(q, p) : nova.call("snap", { query: q, path: p }));
    return unwrapJsonValue(res);
  };
  const guestBash = async (cmd, opts) => {
    const res = await nova.call("bash", { command: cmd, ...opts });
    if (res?.ok === false) {
      const detail = isString(res?.details) ? res.details : "";
      throw new Error(res?.value || detail || `command failed: ${cmd}`);
    }
    return unwrapValue(res);
  };
  const quoteShellArg = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const guestExec = async (cmd, args, opts) => {
    const argv = [cmd, ...(Array.isArray(args) ? args : [])].map(quoteShellArg).join(" ");
    return guestBash(argv, opts);
  };
  const guestSpeculate = async (fn) => (isFunction(nova.speculate) ? nova.speculate(fn) : fn());

  let settled = false;
  const runPromise = Promise.resolve(
    compiled(
      nova,
      nova,
      scopedConsole,
      runParallel,
      runPipeline,
      guestRead,
      guestWrite,
      guestEdit,
      guestPatch,
      guestSurface,
      guestSnap,
      guestBash,
      guestExec,
      guestSpeculate,
    ),
  );
  runPromise.catch((err) => {
    if (!settled) return;
    pushLog(logs, [`[late guest error] ${err instanceof Error ? err.message : String(err)}`], config);
  });
  timeoutPromise.catch(() => {
  });

  try {
    const resultValue = await Promise.race([runPromise, timeoutPromise]);
    settled = true;
    const packaged = packageFinalReturn(resultValue, logs, config);
    return {
      ok: true,
      result: packaged.returnValue,
      resultText: packaged.returnText,
      returnTruncated: packaged.returnTruncated,
      logs: packaged.logs,
      logTruncated: packaged.logTruncated,
      wallMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    settled = true;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
      wallMs: Math.round(performance.now() - started),
    };
  } finally {
    settled = true;
    timeoutPromise.clear();
  }
}

function pushLog(logs, args, config) {
  const maxLines = config.maxLogLines ?? 100;
  if (logs.length >= maxLines) return;
  const line = args
    .map((a) => {
      if (isString(a)) return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  logs.push(line);
}

function sleepReject(ms, error, signal, onFire) {
  let timer;
  let onAbort;
  const fire = (reject) => {
    try {
      onFire?.();
    } catch {
    }
    reject(error);
  };
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => fire(reject), ms);
    if (timer.unref) timer.unref();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        fire(reject);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  promise.clear = () => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  };
  return promise;
}
