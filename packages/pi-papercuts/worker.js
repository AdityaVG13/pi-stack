import { parentPort } from "node:worker_threads";
import { ACTIONS } from "./actions.js";

parentPort.on("message", ({ id, params, cwd, env, stop }) => {
  if (stop) {
    parentPort.close();

    return;
  }

  // Each request observes the caller's overrides, not the worker startup snapshot.
  // Actions are synchronous here: no request can interleave while a lock is held.
  for (const key of ["PAPERCUTS_FILE", "PAPERCUTS_AGENT", "PAPERCUTS_NOW"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }

  try { parentPort.postMessage({ id, result: ACTIONS[params.action](params, { cwd }) }); }
  catch (error) {
    parentPort.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), code: error?.code } });
  }
});
