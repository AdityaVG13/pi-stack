import { isFunction } from "./decode.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "find", "ls", "snap", "evidence", "surface", "asgrep_search", "asgrep_status", "ast_grep", "web_search"]);
const READ_ONLY_LSP = new Set(["definition", "references", "hover", "symbols", "diagnostics", "implementation", "type_definition", "incoming_calls", "outgoing_calls"]);

export function isMutatingTool(name, config = {}, args = {}, definition) {
  if ((config.mutatingTools ?? []).includes(name)) return true;
  if ((config.mutatingPrefixes ?? []).some(prefix => prefix && name.startsWith(prefix))) return true;
  if (definition?.annotations?.readOnlyHint === true) return false;
  if (name === "lsp") {
    const action = args.action ?? args.operation;
    if (READ_ONLY_LSP.has(action)) return false;
    if (["rename", "rename_file"].includes(action)) return args.apply !== false;
    if (action === "code_actions") return args.apply === true;
    return true;
  }
  if (name === "todo") return args.op !== "view";
  if (name === "hub") return !["list", "ps", "logs", "describe"].includes(args.op);
  return !READ_ONLY_TOOLS.has(name);
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(name + " requires an array");
  return value;
}

export async function runParallelWave(thunks, meta, options = {}) {
  const list = requireArray(thunks, "parallel wave");
  if (list.some(item => !isFunction(item))) throw new TypeError("parallel wave requires functions");
  if (!list.length) return { results: [], mode: "serial", reason: "empty" };
  const { mode = "auto", config = {} } = options;
  const names = meta?.names ?? [];
  const mutating = names.length !== list.length || names.some((name, i) => isMutatingTool(name, config, meta?.calls?.[i]?.args, meta?.definitions?.[i]));
  if (!mutating && (mode === "parallel" || (mode === "auto" && list.length > 1))) {
    // Do not finish a wave while its already-started host calls are still running.
    const settled = await Promise.allSettled(list.map(thunk => Promise.resolve().then(thunk)));
    const failure = settled.find(item => item.status === "rejected");
    if (failure) throw failure.reason;
    return { results: settled.map(item => item.value), mode: "parallel", reason: "independent-reads" };
  }
  const results = [];
  for (const thunk of list) results.push(await thunk());
  return { results, mode: "serial", reason: mutating ? "mutating" : "single-or-forced" };
}

export async function parallel(items) {
  return Promise.all(requireArray(items, "parallel").map(item => isFunction(item) ? item() : item));
}

export async function pipeline(items, ...stages) {
  let current = requireArray(items, "pipeline");
  if (stages.some(stage => !isFunction(stage))) throw new TypeError("pipeline stages must be functions");
  for (const stage of stages) current = await Promise.all(current.map(item => stage(item)));
  return current;
}
