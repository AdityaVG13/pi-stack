import {Worker} from 'node:worker_threads';

const WORKER_URL = new URL("./guest-worker.js", import.meta.url);

let idleWorker = null;

function spawnWorker(config) {
  const maxHeapMb = config.maxHeapMb ?? 512;
  // An inline bootstrap accepts inherited --input-type from stdin/eval SDK hosts.
  // Keep Node's automatic flag inheritance: explicitly copying execArgv can
  // reintroduce process-only V8 flags that Worker rejects under node --test.
  const worker = new Worker("import(" + JSON.stringify(WORKER_URL.href) + ")", { eval: true, resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } });
  const handle = { worker, maxHeapMb, dead: false, ready: null };
  // This listener also owns errors between readiness and a run's listeners.
  worker.on("error", () => { handle.dead = true; });
  worker.on("exit", () => {
    handle.dead = true;

    if (idleWorker === handle) idleWorker = null;
  });
  handle.ready = new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onFail);
      worker.off("exit", onFail);
    };

    const onMessage = (msg) => {
      if (msg?.op !== "ready") return;
      cleanup();
      resolve();
    };

    const onFail = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error("guest worker exited before ready (code " + err + ")"));
    };

    worker.on("message", onMessage);
    worker.on("error", onFail);
    worker.on("exit", onFail);
  });
  handle.ready.catch(() => {});

  return handle;
}

function killWorker(handle) {
  if (!handle) return;

  if (idleWorker === handle) idleWorker = null;
  handle.dead = true;

  return handle.worker.terminate();
}

function acquireWorker(config) {
  const candidate = idleWorker;
  idleWorker = null;
  const reusable = candidate && !candidate.dead && candidate.maxHeapMb === (config.maxHeapMb ?? 512);

  if (candidate && !reusable) void killWorker(candidate);
  const handle = reusable ? candidate : spawnWorker(config);
  handle.worker.ref?.();

  // Pipeline the successor while this run executes. A consumed worker's
  // replacement starts at once; a cold start's replacement waits for ready,
  // so the two constructions never overlap. The finish-time warm usually
  // becomes a no-op, so steady-state spawn count is unchanged.
  if (reusable) warmGuestWorker(config).catch(() => {});
  else handle.ready.then(() => warmGuestWorker(config).catch(() => {}), () => {});

  return handle;
}

/** Only pristine workers may be prewarmed. A used worker is never pooled. */
export function warmGuestWorker(config = {}) {
  if (idleWorker && !idleWorker.dead) return idleWorker.ready;
  const handle = spawnWorker(config);
  idleWorker = handle;
  handle.ready.then(() => {
    if (idleWorker === handle) handle.worker.unref?.();
  }, () => {});

  return handle.ready;
}

export function stopWarmGuestWorker() {
  return killWorker(idleWorker);
}
export { acquireWorker, killWorker };
