import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalNewPath } from "../fs/commit.js";
import { readResult } from "../shared/result.js";
import { truncateChars } from "../output/format.js";

const BASH_CAPTURE_CHARS = 2 * 1024 * 1024;

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
      const targetCwd = await commandCwd(params, cwd, vfs);

      const transactionBarrier = await vfs.prepareExternalMutation("bash");
      let res;

      try {
        res = await runCommand(argv, {
          cwd: targetCwd,
          env: hooks.commandEnv(),
          commandLabel: command,
          timeoutMs: params?.timeoutMs === undefined ? config.timeoutMs : params.timeoutMs,
          signal,
          maxOutputChars: BASH_CAPTURE_CHARS,
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

      if (res.outputTruncated) throw new Error("bash output exceeds " + BASH_CAPTURE_CHARS + " character capture limit; redirect output to a file and read it with complete:true or json");

      const { stdout, stderr } = res;
      let text = combineBashText(stdout, stderr);

      if (res.exitCode !== 0) {
        if (!literal && /\bbash: (?:-c: )?line \d+: (?:syntax error|unexpected EOF)/.test(stderr)) {
          text += '\nhint: Bash could not parse the command. For embedded scripts use literal argv, e.g. bash({command:"python3",args:["-c",data.script]}), or a quoted heredoc for shell pipelines. Do not blindly retry: earlier commands may have run.';
        }

        text += await sourceForReferences(cwd, targetCwd, text, signal, ledger);
      }

      // Computation owns the complete captured value; traces/model output get
      // only a bounded preview. Never feed a clipped JSON string to the guest.
      const result = readResult(text, { exitCode: res.exitCode, signal: res.signal, outputTruncated: false, transactionBarrier },
        truncateChars(text, config.maxCallResultChars, "command output").text);

      result.isError = res.exitCode !== 0;

      return result;
  }

  async function background(params, signal) {
    const manager = hooks.terminals;
    const owner = hooks.terminalOwner();
    vfs.assertExternalAllowed("bash");
    const mutating = params.background === true || params.action === "write" || params.action === "stop";
    let targetCwd;

    if (params.background === true) {
      await manager.validateStart(params, hooks.terminalGeneration);
      targetCwd = await commandCwd(params, getCwd(), vfs);
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

// Admit only directories that the pending file set will materialize. Checking
// before the barrier keeps invalid cwd requests from committing unrelated files.
async function stagedDirectory(target, vfs) {
  const pending = await vfs.getOverlayPaths();

  if (!pending.length) return false;
  const directory = await canonicalNewPath(target);
  let found = false;

  for (const logicalPath of pending) {
    const file = await canonicalNewPath(logicalPath);

    if (file === directory) return false;

    if (file.startsWith(directory + path.sep)) found = true;
  }

  return found;
}

async function commandCwd(params, cwd, vfs) {
  const target = params.cwd ? await resolveWorkspacePath(cwd, params.cwd, "bash cwd", true) : cwd;

  if (params.cwd !== undefined) {
    const stat = await fs.stat(target).catch(() => null);

    if (!stat?.isDirectory() && (stat || !await stagedDirectory(target, vfs))) throw new Error("bash cwd is not a directory: " + params.cwd);
  }

  return target;
}
