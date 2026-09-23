import { spawnCommand, commandSpawnError } from "./workspace.js";
import { retireProcessTree } from "./process-tree.js";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

const MAX_RUNNING = 8;

const MAX_RETAINED = 32;

const OUTPUT_CHARS = 65536;

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function terminalArgv(argv) {
  // The PTY child is a process-group leader. Capture that identity before exec,
  // then close the control FD so commands cannot hold it open or forge messages.
  const command = ["/bin/sh", "-c", 'printf "group:%s\\n" "$$" >&3; /bin/stty cols 80 rows 24 || exit; exec "$@" 3>&-', "supernova-command", ...argv];

  // Node uses socketpairs for stdio; macOS script needs a real input pipe.
  // Report script's exit separately from the feeder, which may still await input.
  if (process.platform === "darwin") return ["/bin/sh", "-c", '/bin/cat | { "$@"; code=$?; printf "exit:%s\\n" "$code" >&3; }', "supernova-pty", "/usr/bin/script", "-q", "-F", "/dev/null", ...command];
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

  return ["/usr/bin/script", "-q", "-e", "-f", "-c", "exec " + command.map(quote).join(" "), "/dev/null"];
}

function notifyChanged(job) {
  // Advisory invalidation must not prevent resource cleanup or escape an event.
  try { job.changed?.(); } catch {}

  if (job.cleaned) job.changed = undefined;
}

function wake(job) {
  for (const notify of job.waiters) notify();
}

function appendOutput(job, chunk) {
  job.total += chunk.length;
  job.output = (job.output + chunk).slice(-OUTPUT_CHARS);
  wake(job);
}

function snapshot(job, cursor = 0) {
  if (cursor > job.total) throw new Error("terminal cursor is beyond available output");
  const start = job.total - job.output.length;
  const outputStart = Math.max(start, cursor);

  const result = {
    sessionId:job.id, pid:job.child.pid, status:job.status, pty:job.pty,
    exitCode:job.exitCode, signal:job.signal, outputStart, cursor:job.total,
    truncated:cursor < start, output:job.output.slice(outputStart-start),
  };

  if (job.error) result.error = job.error;

  return result;
}

function waitForChange(job, waitMs, signal) {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer);
      job.waiters.delete(changed);
      signal?.removeEventListener("abort", aborted);

      if (error) reject(error); else resolve();
    };

    const changed = () => done();
    const aborted = () => done(new Error("terminal poll aborted; job remains running"));
    const timer = setTimeout(changed, waitMs);
    job.waiters.add(changed);
    signal?.addEventListener("abort", aborted, {once:true});
  });
}

function sendInput(job, input, signal) {
  signal?.throwIfAborted();

  if (job.child.stdin.writableLength > OUTPUT_CHARS) throw new Error("terminal input queue is full; wait before writing more");

  return new Promise((resolve, reject) => {
    const done = error => {
      signal?.removeEventListener("abort", aborted);

      if (error) reject(error); else resolve();
    };

    const aborted = () => done(new Error("terminal input aborted; input may have been sent"));
    signal?.addEventListener("abort", aborted, {once:true});
    job.child.stdin.write(input, done);
  });
}

export function createBackgroundTerminals() {
  const jobs = new Map();
  let closed = false;
  let generation = 0;
  let closing;

  function lookup(id, owner) {
    const job = jobs.get(id);

    if (!job || job.owner !== owner) throw new Error("unknown background terminal session: " + id);

    return job;
  }

  function assertCapacity(expectedGeneration) {
    if (closed || expectedGeneration !== generation) throw new Error("background terminal session changed or closed; start a new call");

    if ([...jobs.values()].filter(job=>!job.cleaned).length >= MAX_RUNNING) throw new Error("background terminal limit reached (8 running); stop a session first");
  }

  async function validateStart(params, expectedGeneration = generation) {
    assertCapacity(expectedGeneration);

    if (params.pty) {
      if (!["darwin","linux"].includes(process.platform)) throw new Error("PTY background terminals require macOS or Linux; use pty:false for pipes");
      await access("/usr/bin/script", constants.X_OK).catch(()=>{throw new Error("PTY background terminals require executable /usr/bin/script; use pty:false for pipes");});
    }
  }

  async function terminate(job, status) {
    if (job.stopping) return job.stopping;

    if (job.cleaned) return;
    job.stopping = (async () => {
      clearTimeout(job.timer);
      await retireProcessTree(job);
      job.cleaned = true;
      job.error = job.processError;
      job.status = job.error ? "failed" : status;
      notifyChanged(job);
      wake(job);
    })().catch(error => {
      job.stopping = null; // A later stop/shutdown must be able to retry cleanup.
      job.status = "failed";
      job.error = "terminal cleanup failed: " + error.message;
      notifyChanged(job);
      wake(job);
      throw error;
    });

    return job.stopping;
  }

  async function start(argv, options) {
    const startedGeneration = options.generation ?? generation;
    await validateStart(options, startedGeneration);
    options.signal?.throwIfAborted();
    // Capacity and lifecycle can change while the PTY capability check awaits.
    assertCapacity(startedGeneration);

    while (jobs.size >= MAX_RETAINED) {
      const old = [...jobs.values()].find(job=>job.cleaned);

      if (!old) break;
      jobs.delete(old.id);
    }

    const command = options.pty ? terminalArgv(argv) : argv;

    const child = spawnCommand(command, {
      cwd:options.cwd, env:options.pty ? {...options.env,TERM:options.env.TERM || "xterm-256color"} : options.env,
      stdio:options.pty ? ["pipe","pipe","pipe","pipe"] : ["pipe","pipe","pipe"],
    });

    const job = {
      id:randomUUID(), owner:options.owner, child, pty:options.pty === true,
      status:"running", output:"", total:0, exitCode:null, signal:null,
      waiters:new Set(), changed:options.changed, groups:new Set(child.pid ? [child.pid] : []), killedGroups:new Set(), cleaned:false,
    };

    jobs.set(job.id,job);
    child.stdin.on("error",()=>{}); // EPIPE is delivered to each write callback, never uncaught.

    if (job.pty) {
      let control = "";
      child.stdio[3].setEncoding("utf8");
      child.stdio[3].on("data",chunk=>{
        control += chunk;

        if (control.length > 128) {
          job.processError = "invalid PTY control message";
          void terminate(job,"failed").catch(()=>{});

          return;
        }

        let newline;

        while ((newline = control.indexOf("\n")) >= 0) {
          const message = control.slice(0,newline);
          control = control.slice(newline+1);

          if (/^group:[1-9]\d*$/.test(message)) job.groups.add(Number(message.slice(6)));
          else if (/^exit:\d+$/.test(message)) {
            job.commandExitCode = Number(message.slice(5));
            void terminate(job,"exited").catch(()=>{});
          } else job.processError = "invalid PTY control message";
        }
      });
      child.stdio[3].on("error",error=>{
        job.processError = error.message;
        void terminate(job,"failed").catch(()=>{});
      });
    }

    for (const stream of [child.stdout,child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data",chunk=>appendOutput(job,chunk));
    }

    child.once("exit",(code,signal)=>{
      job.processExited = true;
      job.exitCode = job.commandExitCode ?? code;
      job.signal = job.commandExitCode === undefined ? signal : null;
      void terminate(job,"exited").catch(()=>{});
    });
    child.once("close",(code,signal)=>{
      job.processClosed = true;
      job.exitCode = job.commandExitCode ?? code;
      job.signal = job.commandExitCode === undefined ? signal : null;
    });

    try {
      await new Promise((resolve,reject)=>{
        child.once("spawn",resolve);
        child.once("error",error=>{const mapped=commandSpawnError(error,command[0]);job.error=mapped.message;reject(mapped);});
      });

      if (options.signal?.aborted || closed || startedGeneration !== generation) {
        await terminate(job,"stopped");
        throw new Error("background terminal start aborted");
      }
    } catch (error) {
      if (!child.pid || job.cleaned) jobs.delete(job.id);
      throw error;
    }

    job.timer = setTimeout(()=>{void terminate(job,"timed_out").catch(()=>{});},options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    job.timer.unref?.();

    return snapshot(job);
  }

  function validateControl(params, owner, expectedGeneration = generation) {
    if (expectedGeneration !== generation) throw new Error("background terminal session changed; start a new call");

    if (params.action === "list") return;
    const job = lookup(params.sessionId,owner);

    if (params.action === "write" && (job.status !== "running" || job.stopping)) throw new Error("background terminal is not running");

    if (params.cursor !== undefined && params.cursor > job.total) throw new Error("terminal cursor is beyond available output");
  }

  async function control(params, owner, signal, expectedGeneration = generation) {
    validateControl(params,owner,expectedGeneration);
    signal?.throwIfAborted();

    if (params.action === "list") return [...jobs.values()].flatMap(job=>job.owner === owner ? [snapshot(job,job.total)] : []);
    const job = lookup(params.sessionId,owner);

    if (params.action === "write") await sendInput(job,params.input,signal);
    else if (params.action === "stop") await terminate(job,"stopped");
    else if (job.status === "running" && (params.cursor ?? 0) === job.total && params.waitMs) await waitForChange(job,params.waitMs,signal);

    // Polls, writes and stops can cross a session shutdown while awaiting I/O.
    // Do not return a result owned by the session that just closed.
    // Polls, writes and stops can cross a session shutdown while awaiting I/O.
    // Do not return a result owned by the session that just closed.
    if (expectedGeneration !== generation) throw new Error("background terminal session changed; start a new call");

    return snapshot(job,params.cursor);
  }

  function shutdown() {
    if (closing) return closing;
    closed = true;
    generation++;
    const retiring = [...jobs.values()];
    closing = Promise.allSettled(retiring.map(job=>terminate(job,"stopped"))).then(results=>{
      for (const job of retiring) if (job.cleaned) jobs.delete(job.id);
      const failure = results.find(result=>result.status === "rejected");

      if (failure) throw failure.reason;
    }).finally(()=>{closing=undefined;});

    return closing;
  }

  function reopen() {
    if (closing || [...jobs.values()].some(job=>!job.cleaned)) throw new Error("background terminal session cleanup is incomplete");
    closed = false;
  }

  return {start, control, validateStart, validateControl, shutdown, reopen, getGeneration:()=>generation};
}
