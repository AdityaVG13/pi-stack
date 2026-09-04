
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
async function runSerial(list) {
  const out = [];
  for (const thunk of list) out.push(await thunk());
  return out;
}
function shouldParallelize(mode, anyMutating, count) {
  if (mode === "parallel") return true;
  if (mode !== "auto") return false;
  if (anyMutating) return false;
  return count > 1;
}
export async function runParallelWave(thunks, meta, options = {}) {
  const list = Array.isArray(thunks) ? thunks : [];
  if (list.length === 0) return { results: [], mode: "serial", reason: "empty" };
  const { mode = "auto", config = {} } = options;
  const names = Array.isArray(meta?.names) ? meta.names : [];
  const anyMutating = names.some((n) => isString(n) && isMutatingTool(n, config));
  if (shouldParallelize(mode, anyMutating, list.length)) {
    const results = await Promise.all(list.map((thunk) => thunk()));
    return { results, mode: "parallel", reason: "independent-reads" };
  }
  const results = await runSerial(list);
  if (anyMutating) return { results, mode: "serial", reason: "mutating" };
  return { results, mode: "serial", reason: "single-or-forced" };
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
