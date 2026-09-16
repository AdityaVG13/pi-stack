import { isFunction, isObject } from "../shared/decode.js";

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

function takeScheduledWave(queue, first, maxParallelReads) {
  const wave = [first];

  if (first.name !== "read") return wave;

  while (wave.length < maxParallelReads && queue[0]?.name === "read") {
    const next = queue.shift();

    if (!next.cancelled) wave.push(next);
  }

  return wave;
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

function runScheduledWave(wave) {
  // Settle each promise separately: one failed read must not discard its
  // siblings or release a write barrier while other reads are still active.
  return Promise.all(wave.map(runScheduledJob));
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

/** FIFO read waves with mutation barriers; callers keep independent promises. */
export function createNativeScheduler({ maxParallelReads = 8 } = {}) {
  if (!Number.isInteger(maxParallelReads) || maxParallelReads < 1) throw new Error("maxParallelReads must be a positive integer");
  const queue = [];
  const stats = { calls: 0, readWaves: 0, peakParallelReads: 0 };
  let draining = false;

  async function drain() {
    try {
      while (queue.length) {
        const first = queue.shift();

        if (first.cancelled) continue;
        const wave = takeScheduledWave(queue, first, maxParallelReads);

        if (first.name === "read") {
          stats.readWaves++;
          stats.peakParallelReads = Math.max(stats.peakParallelReads, wave.length);
        }

        await runScheduledWave(wave);
      }
    } finally { draining = false; }
  }

  return {
    stats,
    schedule(name, run, signal) {
      if (!NATIVE_TOOLS.includes(name) || !isFunction(run)) {
        return Promise.reject(new Error("scheduler requires a native tool and an executor"));
      }

      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
      stats.calls++;

      return new Promise((resolve, reject) => {
        const job = { name, run, signal, resolve, reject, started: false, cancelled: false };
        attachJobAbort(job, signal, reject);
        queue.push(job);

        if (!draining) {
          draining = true;
          // Pi submits sibling tools in the same turn without model-side code.
          // Collect those submissions before selecting the first read wave.
          queueMicrotask(() => { void drain(); });
        }
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
