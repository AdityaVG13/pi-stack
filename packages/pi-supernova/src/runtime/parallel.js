import { isFunction, isObject, isString } from "../shared/decode.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "find", "ls", "snap", "evidence", "surface", "asgrep_search", "asgrep_status", "ast_grep", "web_search"]);

const READ_ONLY_LSP = new Set(["definition", "references", "hover", "symbols", "diagnostics", "implementation", "type_definition", "incoming_calls", "outgoing_calls"]);

const NATIVE_TOOLS = ["read", "edit", "write", "bash"];

const SPECIAL_MUTATION = {
  todo: args => args.op !== "view",
  hub: args => !["list", "ps", "logs", "describe"].includes(args.op),
};

function configuredMutating(name, config) {
  if ((config.mutatingTools ?? []).includes(name)) return true;

  if ((config.mutatingPrefixes ?? []).some(prefix => prefix && name.startsWith(prefix))) return true;

  return false;
}

function lspMutates(args) {
  const action = args.action ?? args.operation;

  if (READ_ONLY_LSP.has(action)) return false;

  if (["rename", "rename_file"].includes(action)) return args.apply !== false;

  if (action === "code_actions") return args.apply === true;

  return true;
}

export function isMutatingTool(name, config = {}, args = {}, definition) {
  if (!isObject(args)) args = {};
  name = String(name);

  if (configuredMutating(name, config)) return true;

  if (definition?.annotations?.readOnlyHint === true) return false;

  if (name === "lsp") return lspMutates(args);
  const special = SPECIAL_MUTATION[name];

  if (special) return special(args);

  return !READ_ONLY_TOOLS.has(name);
}

function compatibleScheduledJob(job, active) {
  return [...active].every(running =>
    (job.name === "read" && running.name === "read") ||
    (isString(job.key) && isString(running.key) && job.key !== running.key));
}

async function prepareScheduledJob(job) {
  if (!job.resolveKey) return;
  // Key lookup is advisory. Invalid paths still run in isolation so the real
  // adapter reports the error through its normal trace/permission checks.
  try { job.key = await job.resolveKey(); } catch {}
  job.resolveKey = undefined;
}

async function runScheduledJob(job) {
  if (job.cancelled) return;
  job.started = true;
  job.signal?.removeEventListener("abort", job.abort);

  try {
    job.signal?.throwIfAborted();
    const result = await job.run();
    job.signal?.throwIfAborted();
    job.resolve(result);
  } catch (error) { job.reject(error); }
}

function attachJobAbort(job, signal, reject) {
  job.abort = () => {
    if (job.started) return;
    job.cancelled = true;
    signal.removeEventListener("abort", job.abort);
    reject(signal.reason ?? new Error("aborted"));
  };

  signal?.addEventListener("abort", job.abort, { once: true });
}

/** FIFO admission: concurrent reads or disjoint native files, otherwise a barrier. */
export function createNativeScheduler({ maxParallelReads = 8 } = {}) {
  if (!Number.isInteger(maxParallelReads) || maxParallelReads < 1) throw new Error("maxParallelReads must be a positive integer");
  const queue = [];
  const active = new Set();
  const stats = { calls: 0, readWaves: 0, peakParallelReads: 0 };
  let draining = false;

  function start(job) {
    if (job.name === "read") {
      if (!active.size) stats.readWaves++;
      stats.peakParallelReads = Math.max(stats.peakParallelReads, active.size + 1);
    }
    active.add(job);
    // Each promise settles independently. Barriers still wait for every active
    // sibling, including when Promise.all in the guest has already rejected.
    void runScheduledJob(job).finally(() => { active.delete(job); void drain(); });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && active.size < maxParallelReads) {
        const job = queue[0];
        if (job.cancelled) { queue.shift(); continue; }
        // Resolve identities after shell/override barriers, which may change
        // symlinks. Check synchronously: a finishing job must not lose its wakeup.
        if (job.resolveKey && [...active].some(running => !isString(running.key))) break;
        await prepareScheduledJob(job);
        if (job.cancelled) continue;
        if (!compatibleScheduledJob(job, active)) break;
        queue.shift();
        start(job);
      }
    } finally { draining = false; }
  }

  return {
    stats,
    schedule(name, run, signal, resolveKey) {
      if (!NATIVE_TOOLS.includes(name) || !isFunction(run)) {
        return Promise.reject(new Error("scheduler requires a native tool and an executor"));
      }

      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
      stats.calls++;

      return new Promise((resolve, reject) => {
        const job = { name, run, signal, resolve, reject, resolveKey, started: false, cancelled: false };
        attachJobAbort(job, signal, reject);
        queue.push(job);

        void drain();
      });
    },
  };
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(name + " requires an array");

  return value;
}

function waveMutates(list, meta, config) {
  const names = meta?.names ?? [];

  return names.length !== list.length || names.some((name, i) => isMutatingTool(name, config, meta?.calls?.[i]?.args, meta?.definitions?.[i]));
}

function shouldRunParallel(mutating, mode, length) {
  return !mutating && (mode === "parallel" || (mode === "auto" && length > 1));
}

async function settleParallel(list) {
  // Do not finish a wave while its already-started host calls are still running.
  const settled = await Promise.allSettled(list.map(thunk => Promise.resolve().then(thunk)));
  const failure = settled.find(item => item.status === "rejected");

  if (failure) throw failure.reason;

  return { results: settled.map(item => item.value), mode: "parallel", reason: "independent-reads" };
}

async function runSerial(list, mutating) {
  const results = [];

  for (const thunk of list) results.push(await thunk());

  return { results, mode: "serial", reason: mutating ? "mutating" : "single-or-forced" };
}

export async function runParallelWave(thunks, meta, options = {}) {
  const list = requireArray(thunks, "parallel wave");

  if (list.some(item => !isFunction(item))) throw new TypeError("parallel wave requires functions");

  if (!list.length) return { results: [], mode: "serial", reason: "empty" };
  const { mode = "auto", config = {} } = options;
  const mutating = waveMutates(list, meta, config);

  if (shouldRunParallel(mutating, mode, list.length)) return settleParallel(list);

  return runSerial(list, mutating);
}
