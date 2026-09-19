import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { isString } from "../shared/decode.js";

let cachedCwd = null;

let cachedResolvedCwd = null;

// realpath results per program: two syscalls per call otherwise dominate a cached read.
const realRoots = new Map();

const realNearest = new Map();

const PATH_CACHE_MAX = 2048;

export function clearPathCache() {
  cachedCwd = null;
  cachedResolvedCwd = null;
  realRoots.clear();
  realNearest.clear();
}

function getResolvedCwd(cwd) {
  if (cwd === cachedCwd && cachedResolvedCwd) return cachedResolvedCwd;
  cachedCwd = cwd;
  cachedResolvedCwd = path.resolve(cwd);

  return cachedResolvedCwd;
}

function assertInside(rel, message) {
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(message);
  }
}

async function realpathNearest(target) {
  let probe = target;

  while (true) {
    try {
      return await fs.realpath(probe);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
      const parent = path.dirname(probe);

      if (parent === probe) throw err;
      probe = parent;
    }
  }
}

/** Workspace-relative path with "/" separators, the form every model-facing surface uses. */
export function relativeSlash(root, absolute) {
  return (path.relative(root, absolute) || absolute).split(path.sep).join("/");
}

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec"]);

/** One rule for "is this a test file" across snap, evidence, and outlines. */
export function isTestPath(filePath) {
  const segments = filePath.split(/[\\/]/);
  const base = segments[segments.length - 1];

  return segments.some((s) => TEST_SEGMENTS.has(s)) || /\.(test|spec)\./.test(base);
}

function rejectUriPath(trimmed, opName, allowSessionRead) {
  if (/^(?:agent|artifact):\/\//i.test(trimmed)) {
    if (allowSessionRead) return trimmed;
    throw new Error(`${opName} requires a filesystem path; session resource URIs are read-only`);
  }

  const uri = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(trimmed);

  if (!uri) return trimmed;
  const scheme = uri[1];
  const rest = uri[2];
  const windowsDrive = scheme.length === 1 && (rest.startsWith("/") || rest.startsWith("\\"));

  if (!windowsDrive && (rest.startsWith("//") || rest.startsWith("/"))) {
    throw new Error(`${opName} does not accept ${scheme}: URI paths; use a workspace filesystem path`);
  }

  return trimmed;
}

/** Reject scheme:// and scheme:/ paths. A single-letter drive (C:/) stays a filesystem path. */
export function assertFilesystemPath(inputPath, opName, allowSessionRead = false) {
  if (inputPath == null || !isString(inputPath) || !inputPath.trim()) {
    throw new Error(`${opName} requires path`);
  }

  return rejectUriPath(inputPath.trim(), opName, allowSessionRead);
}

export async function resolveWorkspacePath(cwd, inputPath, opName, allowRoot = false, fresh = false) {
  const trimmed = assertFilesystemPath(inputPath, opName);
  const resolvedCwd = getResolvedCwd(cwd);
  const target = path.resolve(resolvedCwd, trimmed);
  assertInside(path.relative(resolvedCwd, target), `${opName} path escapes workspace: ${JSON.stringify(trimmed)} resolves to ${target}, outside ${resolvedCwd}. Use a workspace-relative path (for example artifacts/output.log); external destinations require a separately authorized command`);

  if (!allowRoot && target === resolvedCwd) {
    throw new Error(`${opName} path cannot be the workspace root directory`);
  }

  let realRoot = realRoots.get(resolvedCwd);

  if (!realRoot) {
    realRoot = await fs.realpath(resolvedCwd);
    realRoots.set(resolvedCwd, realRoot);
  }

  let probe = fresh ? undefined : realNearest.get(target);

  if (!probe) {
    probe = await realpathNearest(target);

    if (realNearest.size >= PATH_CACHE_MAX) realNearest.clear();
    realNearest.set(target, probe);
  }

  assertInside(path.relative(realRoot, probe), `${opName} path escapes workspace through symlink: ${JSON.stringify(trimmed)} resolves through ${probe}, outside ${realRoot}. Use a workspace-relative path without an external symlink`);

  return target;
}

function commandTimeoutMs(options) {
  const requestedTimeout = Number(options.timeoutMs === undefined ? 60_000 : options.timeoutMs);

  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error("command timeoutMs must be a positive finite number");

  return Math.max(1, Math.min(2_147_483_647, Math.floor(requestedTimeout)));
}

function spawnCommand(argv, options, cwd) {
  return spawn(argv[0], argv.slice(1), {
    cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
}

function signalProcessTree(child, signal) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", () => child.kill(signal));
  } else {
    try { process.kill(-child.pid, signal); } catch (err) { if (err.code !== "ESRCH") child.kill(signal); }
  }
}

function failCommand(state, error) {
  if (state.settled) return;
  state.settled = true;
  state.cleanup();
  // Keep bounded diagnostic output when a command times out or is cancelled.
  error.stdout = state.stdout;
  error.stderr = state.stderr;
  error.outputTruncated = state.outputTruncated;
  const output = [state.stdout, state.stderr].filter(Boolean).join("\n").trimEnd();

  if (output) error.message += "\n" + output;

  if (state.outputTruncated) error.message += "\n[output truncated]";
  state.reject(error);
}

function terminateCommand(state, error) {
  if (state.settled || state.terminationError) return;
  state.terminationError = error;
  signalProcessTree(state.child, "SIGTERM");
  // Keep ownership after the direct child exits: descendants may ignore SIGTERM.
  state.escalation = setTimeout(() => { signalProcessTree(state.child, "SIGKILL"); failCommand(state, error); }, 150);
}

function appendCommandOutput(state, current, chunk) {
  const remaining = Math.max(0, state.maxOutputChars - state.stdout.length - state.stderr.length);

  if (chunk.length > remaining) state.outputTruncated = true;

  return remaining ? current + chunk.slice(0, remaining) : current;
}

function onCommandClose(state, code, signal) {
  if (state.settled) return;

  if (state.terminationError) {
    // A closed pipe alone says nothing about descendants. Only ESRCH proves
    // the owned POSIX group is gone; otherwise retain the escalation timer.
    if (process.platform !== "win32" && state.child.pid) {
      try { process.kill(-state.child.pid, 0); }
      catch (error) { if (error.code === "ESRCH") failCommand(state, state.terminationError); }
    }

    return;
  }

  state.settled = true;
  state.cleanup();
  state.resolve({ stdout: state.stdout, stderr: state.stderr, exitCode: code ?? (128 + (constants.signals[signal] ?? 1)), signal, outputTruncated: state.outputTruncated });
}

function attachCommandIO(state, options, argv, timeoutMs) {
  const { child } = state;
  const onAbort = () => terminateCommand(state, new Error("aborted"));
  state.cleanup = () => {
    clearTimeout(state.timer);
    clearTimeout(state.escalation);
    options.signal?.removeEventListener("abort", onAbort);
  };
  state.timer = setTimeout(() => terminateCommand(state, new Error("command timed out after " + timeoutMs + "ms: " + (options.commandLabel ?? argv.join(" ")))), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { state.stdout = appendCommandOutput(state, state.stdout, chunk); });
  child.stderr.on("data", chunk => { state.stderr = appendCommandOutput(state, state.stderr, chunk); });
  child.on("error", error => {
    if (error?.code === "EACCES" || error?.code === "EPERM") failCommand(state, new Error("cannot execute " + argv[0] + ": permission denied (is it executable?)"));
    else if (error?.code === "ENOENT") failCommand(state, new Error("command not found: " + argv[0]));
    else if (error?.code === "ENOTDIR") failCommand(state, new Error("cannot run " + argv[0] + ": the working directory is not a directory"));
    else failCommand(state, error);
  });
  child.on("close", (code, signal) => onCommandClose(state, code, signal));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  if (options.signal?.aborted) onAbort();
}

export async function runCommand(argv, options = {}) {
  options.signal?.throwIfAborted();
  const cwd = options.cwd || process.cwd();
  const timeoutMs = commandTimeoutMs(options);
  const maxOutputChars = options.maxOutputChars ?? 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawnCommand(argv, options, cwd);
    attachCommandIO({
      child, resolve, reject, stdout: "", stderr: "", settled: false,
      outputTruncated: false, terminationError: undefined, escalation: undefined,
      maxOutputChars, timer: undefined, cleanup() {},
    }, options, argv, timeoutMs);
  });
}
