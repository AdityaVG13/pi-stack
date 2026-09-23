import { isString } from "../shared/decode.js";

/** Ordered permission rules. First decisive answer wins. */
export function toolIsCallable(name, env) {
  if (name === "supernova" || env.excluded.has(name)) return false;

  if (env.sessionInvalid()) return false;

  if (env.nativeOwned(name)) return true;

  if (env.hostSession) return env.evalAllows(name);

  return env.listed(name);
}

function isArgvOwned(name, args) {
  return name === "bash" && args?.background !== true && args?.action === undefined && Array.isArray(args?.args)
    && args.args.length === Object.keys(args.args).length && args.args.every(isString);
}

function hostExecutor(name, env) {
  const delegated = env.hostTool(name);

  if (delegated) return { exec: delegated.execute.bind(delegated), delegated };

  if (env.hostSession) return { exec: undefined, delegated };

  return { exec: env.executors.get(name), delegated };
}

export function resolveInvokeTarget(name, args, env) {
  const argvOwned = isArgvOwned(name, args);
  const { exec, delegated } = hostExecutor(name, env);

  if (exec && !argvOwned) return { kind: "override", exec, delegated, argvOwned: false };

  if (env.natives[name]) return { kind: "native", native: env.natives[name], argvOwned };

  return { kind: "unknown" };
}
