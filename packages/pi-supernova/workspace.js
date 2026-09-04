import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
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
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputChars = options.maxOutputChars ?? 2 * 1024 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputTruncated = false;
    let onAbort;

    const cleanup = () => {
      clearTimeout(timer);
      if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const append = (current, chunk) => {
      const remaining = Math.max(0, maxOutputChars - current.length);
      if (chunk.length > remaining) outputTruncated = true;
      return remaining > 0 ? current + chunk.slice(0, remaining) : current;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error(`command timed out after ${timeoutMs}ms: ${argv.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? 0, outputTruncated });
    });
    if (options.signal) {
      onAbort = () => {
        child.kill("SIGTERM");
        fail(new Error("aborted"));
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
