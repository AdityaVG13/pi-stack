import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);

// PTYs and shell job control can create groups distinct from the original
// leader. Record those groups while ancestry exists, before signalling parents.
async function descendantGroups(pid) {
  const { stdout } = await exec("ps", ["-ax", "-o", "pid=,ppid=,pgid="], {timeout:1000, maxBuffer:4*1024*1024});
  const children = new Map();

  for (const line of stdout.trim().split("\n")) {
    const [child, parent, group] = line.trim().split(/\s+/).map(Number);

    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({pid:child,group});
  }

  const found = [];
  const pending = [...(children.get(pid) ?? [])];

  while (pending.length) {
    const child = pending.pop();

    if (child.group > 0) found.push(child.group);
    pending.push(...(children.get(child.pid) ?? []));
  }

  return found;
}

function signalGroups(job, signal) {
  for (const group of job.groups) {
    // Once SIGKILL was delivered, wait for reaping. Darwin can return EPERM
    // when signalling a zombie again; newly discovered groups still need a kill.
    if (signal === "SIGKILL" && job.killedGroups.has(group)) continue;

    try {
      process.kill(-group, signal);

      if (signal === "SIGKILL") job.killedGroups.add(group);
    } catch (error) {
      if (error.code === "EPERM") {
        // Even signal 0 can encounter that race. Keep ownership until ESRCH;
        // an inaccessible live group must fail at the deadline, not look gone.
        job.signalError = `cannot signal process group ${group} with ${signal}: ${error.message}`;
        continue;
      }

      if (error.code !== "ESRCH") throw error;
      job.groups.delete(group);
    }
  }
}

// Both foreground and background commands own their POSIX groups until they
// disappear, not merely until the leader exits or inherited output pipes close.
// Callers update processExited/processClosed from the real child events and may
// add PTY group identities while cleanup awaits. Windows remains best-effort.
export async function retireProcessTree(job) {
  let discoveryError;

  if (process.platform === "win32") {
    if (!job.processExited) await exec("taskkill", ["/pid", String(job.child.pid), "/t", "/f"], {timeout:2000,windowsHide:true});
  } else {
    if (!job.processExited) {
      try { for (const group of await descendantGroups(job.child.pid)) job.groups.add(group); }
      catch (error) { discoveryError = error; }
    }

    signalGroups(job, "SIGTERM");

    if (job.groups.size) await delay(150);
    signalGroups(job, "SIGKILL");
  }

  const deadline = Date.now() + 1000;

  while (true) {
    if (process.platform !== "win32") signalGroups(job, 0);

    if (job.processClosed && (process.platform === "win32" || job.groups.size === 0)) break;

    if (Date.now() >= deadline) throw new Error("owned process group or output pipes did not close" + (job.signalError ? ": " + job.signalError : ""));

    if (process.platform !== "win32") signalGroups(job, "SIGKILL");
    await delay(10);
  }

  if (discoveryError) throw new Error("descendant discovery failed: " + discoveryError.message);
}
