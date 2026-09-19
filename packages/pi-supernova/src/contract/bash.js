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
  args.args = args.args.map(String);

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
  normalizeArgv(args);

  if (args.timeout !== undefined && args.timeoutMs === undefined) args.timeoutMs = args.timeout * 1000;

  return args;
}
