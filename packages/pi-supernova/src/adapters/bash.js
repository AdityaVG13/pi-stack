import * as fs from "node:fs/promises";
import { isString } from "../shared/decode.js";
import { normalizeBash } from "../contract/bash.js";
import { sourceForReferences } from "../fs/source-window.js";
import { resolveWorkspacePath, runCommand, clearPathCache } from "../fs/workspace.js";

export function createBash(ctx) {
  const { getCwd, vfs, config, index, ledger, hooks } = ctx;
  function combineBashText(stdout, stderr) {
    return stdout && stderr ? stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr : stdout || stderr;
  }

  function isLiteralArgv(params) {
    return Array.isArray(params?.args) && process.platform !== "win32" && params.args.length === Object.keys(params.args).length && params.args.every(isString);
  }

  function bashCommand(params, literal) {
    if (params?.command !== undefined && !isString(params.command)) throw new Error("bash command must be a string");
    if (literal && (!isString(params.command) || params.args.some(arg => !isString(arg)))) throw new Error("bash argv requires a command string and an array of string args");
    const command = String(params?.command ?? "");

    if (!command.trim()) throw new Error("bash requires command");

    return command;
  }

  function parseBash(params) {
    const literal = isLiteralArgv(params);
    const command = bashCommand(params, literal);

    return { literal, command, argv: literal ? [command, ...params.args] : ["bash", "-c", command] };
  }

  async function bash(params, signal) {
      params = normalizeBash(params);
      const cwd = getCwd();
      const { literal, command, argv } = parseBash(params);
      const targetCwd = params?.cwd ? await resolveWorkspacePath(cwd, params.cwd, "bash cwd", true) : cwd;

      if (params?.cwd !== undefined) {
        const st = await fs.stat(targetCwd).catch(() => null);

        if (!st?.isDirectory()) throw new Error("bash cwd is not a directory: " + params.cwd);
      }

      const transactionBarrier = await vfs.prepareExternalMutation("bash");
      let res;

      try {
        res = await runCommand(argv, {
          cwd: targetCwd,
          env: hooks.commandEnv(),
          commandLabel: command,
          timeoutMs: params?.timeoutMs === undefined ? config.timeoutMs : params.timeoutMs,
          signal,
          maxOutputChars: config.maxCallResultChars,
        });
      } catch (error) {
        if (!signal?.aborted) error.message += await sourceForReferences(cwd, targetCwd, error.message, signal, ledger);
        throw error;
      } finally {
        vfs.invalidateObserved();
        index.invalidate();
        clearPathCache();
        hooks.workspaceChanged();
      }

      const { stdout, stderr } = res;
      let text = combineBashText(stdout, stderr);

      if (res.exitCode !== 0) {
        if (!literal && /\bbash: (?:-c: )?line \d+: (?:syntax error|unexpected EOF)/.test(stderr)) {
          text += '\nhint: Bash could not parse the command. For embedded scripts use literal argv, e.g. bash({command:"python3",args:["-c",data.script]}), or a quoted heredoc for shell pipelines. Do not blindly retry: earlier commands may have run.';
        }
        text += await sourceForReferences(cwd, targetCwd, text, signal, ledger);
      }

      return {
        content: [{ type: "text", text }],
        details: { exitCode: res.exitCode, signal: res.signal, outputTruncated: res.outputTruncated, transactionBarrier },
        isError: res.exitCode !== 0,
      };
  }

  return { bash };
}
