import { Worker } from "node:worker_threads";

// A lazy, registration-owned worker keeps synchronous parsing and durable fsync off
// the UI thread. Nothing is started at extension registration or for schema.
export function createActionExecutor(url = new URL("./worker.js", import.meta.url)) {
  let current, nextId = 0;

  function start() {
    // Shipped ESM needs no host eval/test/loader flags in the worker.
    const worker = new Worker(url, { execArgv: [] });
    const session = { worker, pending: new Map(), closing: false };
    session.closed = new Promise(resolve => {
      worker.on("exit", code => {
        for (const request of session.pending.values()) request.reject(new Error(`Papercuts worker exited before returning a receipt (${code})`));
        session.pending.clear();

        if (current === session) current = undefined;
        resolve();
      });
    });
    worker.on("error", error => {
      for (const request of session.pending.values()) request.reject(error);
      session.pending.clear();

      if (current === session) current = undefined;
    });
    worker.on("message", ({ id, result, error }) => {
      const request = session.pending.get(id);

      if (!request) return;
      session.pending.delete(id);

      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
      else request.resolve(result);

      if (!session.pending.size && !session.closing) worker.unref();
    });
    worker.unref();

    return session;
  }

  function run(params, cwd, signal) {
    if (signal?.aborted) return Promise.reject(new Error("Papercuts cancelled before dispatch"));

    if (current?.closing) return Promise.reject(Object.assign(new Error("Papercuts is shutting down; no new work accepted"), { code: "busy" }));
    const session = current ??= start();
    const id = ++nextId;
    const env = { PAPERCUTS_FILE: process.env.PAPERCUTS_FILE, PAPERCUTS_AGENT: process.env.PAPERCUTS_AGENT, PAPERCUTS_NOW: process.env.PAPERCUTS_NOW };

    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
      session.worker.ref();

      try { session.worker.postMessage({ id, params, cwd, env }); }
      catch (error) {
        session.pending.delete(id);

        if (!session.pending.size) session.worker.unref();
        reject(error);
      }
    });
  }

  function close() {
    if (!current) return Promise.resolve();
    const session = current;

    if (!session.closing) {
      session.closing = true;
      session.worker.ref();
      // FIFO delivery drains accepted transactions before closing. Never terminate
      // a worker in the middle of append/fsync/prune, including on cancellation.
      session.worker.postMessage({ stop: true });
    }

    return session.closed;
  }

  return { run, close };
}
