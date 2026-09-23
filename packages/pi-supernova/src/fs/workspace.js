import {remapReadError} from "./file-io.js";
import { retireProcessTree } from "./process-tree.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { isString } from "../shared/decode.js";
import { truncateChars } from "../output/format.js";

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
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") await remapReadError(err, target);
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

export function commandSpawnError(error, command) {
  if (error?.code === "EACCES" || error?.code === "EPERM") return new Error("cannot execute " + command + ": permission denied (is it executable?)");

  if (error?.code === "ENOENT") return new Error("command not found: " + command);

  if (error?.code === "ENOTDIR") return new Error("cannot run " + command + ": the working directory is not a directory");

  return error;
}

export function spawnCommand(argv, options, cwd = options.cwd) {
  try {
    return spawn(argv[0], argv.slice(1), {
      cwd, env: options.env ?? process.env, stdio: options.stdio ?? ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide:true,
    });
  } catch (error) { throw commandSpawnError(error,argv[0]); }
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
  if (state.settled) return;
  state.terminationError ??= error;

  if (state.stopping) return;
  clearTimeout(state.timer);
  state.stopping = retireProcessTree(state).then(()=>{
    if (state.terminationError) {
      failCommand(state,state.terminationError);

      return;
    }

    state.settled = true;
    state.cleanup();
    state.resolve({ stdout:state.stdout, stderr:state.stderr,
      exitCode:state.exitCode ?? (128 + (constants.signals[state.signal] ?? 1)),
      signal:state.signal, outputTruncated:state.outputTruncated });
  }).catch(cause=>{
    state.child.stdout.destroy();
    state.child.stderr.destroy();
    const prefix = state.terminationError ? state.terminationError.message + "; " : "";
    failCommand(state,new Error(prefix + "command cleanup failed: " + cause.message));
  });
}

function appendCommandOutput(state, current, chunk) {
  const remaining = Math.max(0, state.maxOutputChars - state.stdout.length - state.stderr.length);

  if (chunk.length > remaining) state.outputTruncated = true;

  return remaining ? current + chunk.slice(0, remaining) : current;
}

function attachCommandIO(state, options, argv, timeoutMs) {
  const { child } = state;
  const onAbort = () => terminateCommand(state, new Error("aborted"));
  state.cleanup = () => {
    clearTimeout(state.timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  state.timer = setTimeout(() => terminateCommand(state, new Error(
    "command timed out after " + timeoutMs + "ms: " + truncateChars(options.commandLabel ?? argv.join(" "), 240, "command").text
    + "\nhint: Increase this bash timeoutMs and the outer supernova timeoutMs, or split the work. Sleeps and every command in a shell chain share the same limit."
  )), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { state.stdout = appendCommandOutput(state, state.stdout, chunk); });
  child.stderr.on("data", chunk => { state.stderr = appendCommandOutput(state, state.stderr, chunk); });
  child.on("error", error => failCommand(state,commandSpawnError(error,argv[0])));
  child.once("exit", (code, signal) => {
    state.processExited = true;
    state.exitCode = code;
    state.signal = signal;
    // An orphan can retain the pipes forever. Begin retirement at leader exit,
    // then wait for close and group disappearance before reporting completion.
    terminateCommand(state);
  });
  child.once("close", () => { state.processClosed = true; });
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
      outputTruncated: false, terminationError: undefined, stopping: undefined,
      groups:new Set(child.pid ? [child.pid] : []), killedGroups:new Set(),
      maxOutputChars, timer: undefined, cleanup() {},
    }, options, argv, timeoutMs);
  });
}
