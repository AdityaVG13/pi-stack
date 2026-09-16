import { isString, isObject } from "../shared/decode.js";

const ARGV_ERROR = "bash argv requires a command string and an array of string args";

function quoteShellArg(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

/** Normalize guest bash(command, opts) / bash({command, args}) into host args. */
function normalizeArgv(args) {
  if (args.args === undefined) return;
  if (!isString(args.command) || !Array.isArray(args.args)) throw new Error(ARGV_ERROR);

  for (let i = 0; i < args.args.length; i++) if (!isString(args.args[i])) throw new Error(ARGV_ERROR);
  args.args = args.args.map(String);

  if (process.platform === "win32") {
    delete args._directArgv;
    args.command = [args.command, ...args.args].map(quoteShellArg).join(" ");
    delete args.args;
  } else args._directArgv = true;
}

export function normalizeBash(command, opts) {
  const args = isObject(command) ? { ...command } : { command, ...opts };
  normalizeArgv(args);

  if (args.timeout !== undefined && args.timeoutMs === undefined) args.timeoutMs = args.timeout * 1000;

  return args;
}
