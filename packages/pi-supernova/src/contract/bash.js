import { isString, isObject } from "../shared/decode.js";

const ARGV_ERROR = "bash argv requires a command string and an array of string args";

function quoteShellArg(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

/** Normalize guest bash(command, opts) / bash({command, args}) into host args. */
function normalizeArgv(args) {
  if (args.args === undefined) return;
  if (!isString(args.command) || !Array.isArray(args.args)) throw new Error(ARGV_ERROR);

  for (let i = 0; i < args.args.length; i++) {
    if (!isString(args.args[i])) {
      const type = args.args[i] === undefined ? "undefined" : "not a string";
      throw new Error(`${ARGV_ERROR}; args[${i}] is ${type}; check the supplied data fields and pass each argument as a string`);
    }
  }
  args.args = args.args.map((arg, i) => {
    if (arg.includes("\0")) throw new Error(`bash args[${i}] must not contain null bytes`);
    return String(arg);
  });

  if (process.platform === "win32") {
    delete args._directArgv;
    args.command = [args.command, ...args.args].map(quoteShellArg).join(" ");
    delete args.args;
  } else args._directArgv = true;
}

const BASH_OPTION_KEYS = ["command", "args", "cwd", "timeout", "timeoutMs", "_directArgv"];

/** Unknown options used to be dropped silently: env/maxOutputChars never applied. */
function assertBashOptions(args) {
  const unknown = Object.keys(args).filter(key => !BASH_OPTION_KEYS.includes(key));

  if (unknown.length) throw new Error("bash does not accept option " + unknown.map(key => JSON.stringify(key)).join(", ") + "; supported options are command, args, cwd, timeout, timeoutMs");
}
export function normalizeBash(command, opts) {
  const args = isObject(command) ? { ...opts, ...command } : { command, ...opts };
  assertBashOptions(args);
  if (!isString(args.command) || !args.command.trim()) throw new Error("bash requires a non-empty command string");
  if (args.command.includes("\0")) throw new Error("bash command must not contain null bytes");
  normalizeArgv(args);

  if (args.timeout !== undefined && args.timeoutMs === undefined) args.timeoutMs = args.timeout * 1000;
  // Reject before the host's external-mutation barrier can flush staged files.
  if (args.timeoutMs !== undefined) {
    const timeout = Number(args.timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("command timeoutMs must be a positive finite number");
    args.timeoutMs = Math.max(1, Math.min(2_147_483_647, Math.floor(timeout)));
  }

  return args;
}
