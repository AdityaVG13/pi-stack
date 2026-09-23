import * as fs from "node:fs/promises";
import { readResult } from "../shared/result.js";

import { normalizeBash } from "../contract/bash.js";
import { sourceForReferences } from "../fs/source-window.js";
import { resolveWorkspacePath, runCommand, clearPathCache } from "../fs/workspace.js";

export function createBash(ctx) {
  const { getCwd, vfs, config, index, ledger, hooks } = ctx;

  function combineBashText(stdout, stderr) {
    return stdout && stderr ? stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr : stdout || stderr;
  }

  async function bash(params, signal) {
      params = normalizeBash(params);

      if (params.background === true || params.action !== undefined) return background(params, signal);
      const cwd = getCwd();
      const command = String(params.command);
      const literal = Array.isArray(params.args);
      const argv = literal ? [command, ...params.args] : ["bash", "-c", command];
      const targetCwd = await commandCwd(params, cwd);

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

  async function background(params, signal) {
    const manager = hooks.terminals;
    const owner = hooks.terminalOwner();
    vfs.assertExternalAllowed("bash");
    const mutating = params.background === true || params.action === "write" || params.action === "stop";
    let targetCwd;

    if (params.background === true) {
      await manager.validateStart(params, hooks.terminalGeneration);
      targetCwd = await commandCwd(params, getCwd());
    } else manager.validateControl(params, owner, hooks.terminalGeneration);
    const transactionBarrier = mutating ? await vfs.prepareExternalMutation("bash") : false;

    try {
      const value = params.background === true
        ? await manager.start(Array.isArray(params.args) ? [params.command,...params.args] : ["bash","-c",params.command], {
          ...params, cwd:targetCwd, owner, env:hooks.commandEnv(), signal, generation:hooks.terminalGeneration,
          // Asynchronous completion must not erase an active program's CAS observations.
          changed:()=>{index.invalidate(); hooks.workspaceChanged();},
        })
        : await manager.control(params, owner, signal, hooks.terminalGeneration);

      // A completed job's nonzero exit is status data, not a failure to poll it.
      return readResult(value, {background:true,transactionBarrier}, Array.isArray(value) ? `${value.length} background terminals` : `terminal ${value.sessionId}: ${value.status}`);
    } finally {
      if (mutating) { vfs.invalidateObserved(); hooks.workspaceChanged(); }

      index.invalidate();
      clearPathCache();
    }
  }

  return { bash };
}

async function commandCwd(params, cwd) {
  const target = params.cwd ? await resolveWorkspacePath(cwd, params.cwd, "bash cwd", true) : cwd;

  if (params.cwd !== undefined) {
    const stat = await fs.stat(target).catch(() => null);

    if (!stat?.isDirectory()) throw new Error("bash cwd is not a directory: " + params.cwd);
  }

  return target;
}
