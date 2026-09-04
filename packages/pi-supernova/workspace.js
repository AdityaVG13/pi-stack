import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { isString } from "./decode.js";

let cachedCwd = null;
let cachedResolvedCwd = null;
// realpath results per program: two syscalls per call otherwise dominate a cached read.
const realRoots = new Map();
const realNearest = new Map();
const PATH_CACHE_MAX = 2048;

export function clearPathCache() {
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

export async function resolveWorkspacePath(cwd, inputPath, opName, allowRoot = false) {
  if (inputPath == null || !isString(inputPath) || !inputPath.trim()) {
    throw new Error(`${opName} requires path`);
  }
  const resolvedCwd = getResolvedCwd(cwd);
  const target = path.resolve(resolvedCwd, inputPath.trim());
  assertInside(path.relative(resolvedCwd, target), `${opName} path escapes workspace: paths resolve relative to ${resolvedCwd}`);
  if (!allowRoot && target === resolvedCwd) {
    throw new Error(`${opName} path cannot be the workspace root directory`);
  }
  let realRoot = realRoots.get(resolvedCwd);
  if (!realRoot) {
    realRoot = await fs.realpath(resolvedCwd);
    realRoots.set(resolvedCwd, realRoot);
  }
  let probe = realNearest.get(target);
  if (!probe) {
    probe = await realpathNearest(target);
    if (realNearest.size >= PATH_CACHE_MAX) realNearest.clear();
    realNearest.set(target, probe);
  }
  assertInside(path.relative(realRoot, probe), `${opName} path escapes workspace through symlink`);
  return target;
}

export async function runCommand(argv, options = {}) {
  options.signal?.throwIfAborted();
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputChars = options.maxOutputChars ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputTruncated = false;
    let terminationError;
    let escalation;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const signalTree = signal => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        killer.on("error", () => child.kill(signal));
      } else {
        try { process.kill(-child.pid, signal); } catch (err) { if (err.code !== "ESRCH") child.kill(signal); }
      }
    };
    const terminate = error => {
      if (settled || terminationError) return;
      terminationError = error;
      signalTree("SIGTERM");
      // Keep ownership after the direct child exits: descendants may ignore SIGTERM.
      escalation = setTimeout(() => { signalTree("SIGKILL"); fail(error); }, 150);
    };
    const onAbort = () => terminate(new Error("aborted"));
    const timer = setTimeout(() => terminate(new Error("command timed out after " + timeoutMs + "ms: " + argv.join(" "))), timeoutMs);
    const append = (current, chunk) => {
      const remaining = Math.max(0, maxOutputChars - stdout.length - stderr.length);
      if (chunk.length > remaining) outputTruncated = true;
      return remaining ? current + chunk.slice(0, remaining) : current;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled || terminationError) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? (128 + (constants.signals[signal] ?? 1)), signal, outputTruncated });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
