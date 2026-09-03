
import { isString } from "./decode.js";

export function isMutatingTool(name, config) {
  const exact = new Set(config.mutatingTools || []);
  if (exact.has(name)) return true;
  const prefixes = config.mutatingPrefixes || [];
  for (const prefix of prefixes) {
    if (isString(prefix) && prefix.length > 0 && name.startsWith(prefix)) return true;
  }
  return false;
}

export async function runParallelWave(thunks, meta, options = {}) {
  const list = Array.isArray(thunks) ? thunks : [];
  if (list.length === 0) {
    return { results: [], mode: "serial", reason: "empty" };
  }
  const mode = options.mode || "auto";
  const names = Array.isArray(meta?.names) ? meta.names : [];
  const config = options.config || {};
  const anyMutating = names.some((n) => isString(n) && isMutatingTool(n, config));
  const useParallel = mode === "parallel" || (mode === "auto" && !anyMutating && list.length > 1);

  if (!useParallel) {
    const out = [];
    for (const thunk of list) {
      out.push(await thunk());
    }
    return { results: out, mode: "serial", reason: anyMutating ? "mutating" : "single-or-forced" };
  }

  const results = await Promise.all(list.map((thunk) => thunk()));
  return { results, mode: "parallel", reason: "independent-reads" };
}

export async function parallel(items) {
  const list = Array.isArray(items) ? items : [];
  return Promise.all(list.map((item) => (item instanceof Function ? item() : item)));
}

export async function pipeline(items, ...stages) {
  let current = Array.isArray(items) ? items.slice() : [];
  for (const stage of stages) {
    current = await Promise.all(current.map((item) => stage(item)));
  }
  return current;
}
