import { isString, isObject } from "../shared/decode.js";

const ARGV_ERROR = "bash argv requires a command string and an array of string args";

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

  args._directArgv = true;
}

const BASH_OPTION_KEYS = ["command", "args", "cwd", "timeout", "timeoutMs", "_directArgv", "background", "pty"];

/** Unknown options used to be dropped silently: env/maxOutputChars never applied. */
function assertBashOptions(args) {
  const unknown = Object.keys(args).filter(key => !BASH_OPTION_KEYS.includes(key));

  if (unknown.length) throw new Error("bash does not accept option " + unknown.map(key => JSON.stringify(key)).join(", ") + "; supported options are command, args, cwd, timeout, timeoutMs, background, pty");
}

export function normalizeBash(command, opts) {
  const args = isObject(command) ? { ...opts, ...command } : { command, ...opts };

  if (args.action !== undefined || args.sessionId !== undefined) return normalizeTerminalControl(args);
  assertBashOptions(args);

  for (const key of ["background", "pty"]) {
    if (args[key] !== undefined && args[key] !== true && args[key] !== false) throw new Error(`bash ${key} must be boolean`);
  }

  if (args.pty !== undefined && args.background !== true) throw new Error("bash pty requires background:true");

  if (!isString(args.command) || !args.command.trim()) throw new Error("bash requires a non-empty command string");

  if (args.command.includes("\0")) throw new Error("bash command must not contain null bytes");
  normalizeArgv(args);

  normalizeTimeout(args);

  return args;
}

function normalizeTerminalControl(args) {
  const fields = {
    list: ["action"],
    poll: ["action", "sessionId", "cursor", "waitMs"],
    write: ["action", "sessionId", "input"],
    stop: ["action", "sessionId"],
  };

  if (!Object.hasOwn(fields, args.action)) throw new Error("bash terminal action must be list, poll, write or stop");
  const unknown = Object.keys(args).filter(key => !fields[args.action].includes(key));

  if (unknown.length) throw new Error(`bash ${args.action} does not accept option ${unknown.join(", ")}`);

  if (args.action !== "list" && (!isString(args.sessionId) || !args.sessionId.trim())) throw new Error("bash terminal action requires sessionId");

  if (args.action === "write" && (!isString(args.input) || args.input.length > 16384)) throw new Error("bash terminal input must be a string of at most 16384 characters");

  if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) throw new Error("bash terminal cursor must be a non-negative safe integer");

  if (args.waitMs !== undefined && (!Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 30000)) throw new Error("bash terminal waitMs must be an integer from 0 to 30000");

  return args;
}

function normalizeTimeout(args) {
  if (args.timeout !== undefined && args.timeoutMs === undefined) args.timeoutMs = args.timeout * 1000;

  // Reject before the host's external-mutation barrier can flush staged files.
  if (args.timeoutMs !== undefined) {
    const timeout = Number(args.timeoutMs);

    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("command timeoutMs must be a positive finite number");
    args.timeoutMs = Math.max(1, Math.min(2_147_483_647, Math.floor(timeout)));
  }

}
