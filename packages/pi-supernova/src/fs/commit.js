import fs from 'node:fs/promises';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileSignature,sameSignature,sameFileVersion,textSignature} from './file-io.js';

// realpath() cannot resolve a missing leaf. Canonicalize its nearest existing
// ancestor so two symlink spellings still share one commit destination.
async function canonicalNewPath(target) {
  let ancestor = path.dirname(target);

  for (;;) {
    try { return path.join(await fs.realpath(ancestor), path.relative(ancestor, target)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);

      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function resolveExistingFile(logicalPath) {
  const target = await fs.realpath(logicalPath);
  const stat = await fs.stat(target);

  if (!stat.isFile()) throw new Error("cannot write to a non-file: " + logicalPath);

  if (stat.nlink > 1) throw new Error("cannot replace a hard-linked file without splitting its aliases: " + logicalPath);

  return { target, stat };
}

export async function resolveCommitTarget(logicalPath) {
  try {
    return await resolveExistingFile(logicalPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;

    return { target: await canonicalNewPath(logicalPath), stat: undefined };
  }
}

async function collectMissingAncestors(parent) {
  const missing = [];
  let probe = parent;

  for (;;) {
    try { await fs.stat(probe); break; } catch (err) {
      if (err.code !== "ENOENT") throw err;
      missing.push(probe);
      probe = path.dirname(probe);
    }
  }

  return missing;
}

async function writeTemporary(entry, content, stat) {
  try {
    await fs.writeFile(entry.temporary, content, { encoding: "utf8", flag: "wx", mode: stat ? stat.mode & 0o7777 : 0o666 });
  } catch (error) {
    // Never leak the temporary name: name the destination and the real cause.
    if (error?.code === "EACCES" || error?.code === "EPERM") throw new Error("permission denied writing " + entry.target + ": the directory or file is not writable");

    if (error?.code === "EROFS") throw new Error("cannot write " + entry.target + ": the file system is read-only");

    if (error?.code === "ENOSPC") throw new Error("cannot write " + entry.target + ": no space left on device");

    throw error;
  }

  if (stat) await fs.chmod(entry.temporary, stat.mode & 0o7777);
}

async function stageReplacement(entry, content, stat, target) {
  const replacement = writeTemporary(entry, content, stat);
  // These touch separate staging files. Settle both before cleanup, even
  // on failure: Promise.all could leave a late backup after rollback.
  const staging = [replacement];

  if (stat) staging.push(fs.copyFile(target, entry.backup, fs.constants.COPYFILE_EXCL));
  const outcomes = await Promise.allSettled(staging);
  const failure = outcomes.find(outcome => outcome.status === "rejected");

  if (failure) throw failure.reason;
}

function makeStageEntry(logicalPath, target, content, parent, stat) {
  const token = ".supernova-" + randomUUID();

  return { logicalPath, target, content, temporary: path.join(parent, token + ".new"), backup: path.join(parent, token + ".bak"), existed: !!stat, observed: stat, replaced: false };
}

// Windows readers and antivirus can briefly deny replacement. Bound retries and
// renew the destination/ownership guard after waiting; never replay a stale CAS.
async function renameWithSharingRetry(from, to, validate) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);

      return;
    }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error.code) || attempt >= 2) throw error;
    }

    await new Promise(resolve => setTimeout(resolve, 10));
    await validate();
  }
}

async function assertPublishedContent(entry) {
  const expected = textSignature(entry.content);
  const stat = await fs.stat(entry.target);

  // Recovery must not destroy changes made after our publication. Check
  // cheap type/size differences before hashing a possibly replaced file.
  if (!stat.isFile() || stat.size !== expected.size || !sameSignature(await fileSignature(entry.target, undefined, stat), expected)) {
    throw new Error("destination changed after publication; left unchanged");
  }
}

async function assertStageReady(vfs, entry) {
  vfs.assertCurrent?.();
  vfs.signal?.throwIfAborted();
  let current;

  try { current = await fs.stat(entry.target); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (!current || !sameFileVersion(entry.observed, current)) throw new Error("write conflict: file changed during commit staging: " + entry.logicalPath + "; read it again before retrying");

  // Windows metadata can alias a rewrite while staging releases its handles.
  if (process.platform === "win32") await assertExpectedSignature(vfs, entry.logicalPath, entry.target, current);
  vfs.assertCurrent?.();
  vfs.signal?.throwIfAborted();
}

async function recoverReplaced(staged) {
  const recoveryErrors = [];

  for (const entry of staged.toReversed()) {
    if (!entry.replaced) continue;

    try {
      await assertPublishedContent(entry);

      if (entry.existed) await renameWithSharingRetry(entry.backup, entry.target, () => assertPublishedContent(entry));
      else await fs.unlink(entry.target);
    } catch (err) {
      // Keep the backup if recovery fails; never delete the remaining original.
      entry.keepBackup = entry.existed;
      recoveryErrors.push(entry.target + ": " + err.message + (entry.existed ? " (backup: " + entry.backup + ")" : ""));
    }
  }

  return recoveryErrors;
}

async function cleanupStaged(staged, failed, createdDirs) {
  for (const entry of staged) {
    // Existing-file rename consumes the staging name; new-file linking does
    // not. Remove only our staging names, never a conflicting destination.
    if (!entry.replaced || !entry.existed) await fs.unlink(entry.temporary).catch(() => {});

    if (entry.existed && !entry.keepBackup) await fs.unlink(entry.backup).catch(() => {});
  }

  if (failed) for (const dir of createdDirs.toReversed()) await fs.rmdir(dir).catch(() => {});
}

async function assertExpectedSignature(vfs, logicalPath, target, stat) {
  if (!vfs.expected.has(logicalPath)) return;
  const current = stat ? await fileSignature(target, vfs.signal) : null;

  if (!sameSignature(current, vfs.expected.get(logicalPath))) {
    throw new Error("write conflict: file changed since it was read: " + logicalPath + "; read it again before retrying");
  }
}

async function installStaged(vfs, staged) {
  for (const entry of staged) {
    if (entry.existed) await assertStageReady(vfs, entry);

    // Staging, version checks and earlier publications await I/O. Recheck
    // ownership immediately before each disk effect; failCommit handles recovery.
    vfs.assertCurrent?.();
    vfs.signal?.throwIfAborted();

    if (entry.existed) await renameWithSharingRetry(entry.temporary, entry.target, () => assertStageReady(vfs, entry));
    else {
      // Let the filesystem enforce absence, including case/Unicode aliases.
      // A preflight stat followed by rename would still clobber a racing file.
      try { await fs.link(entry.temporary, entry.target); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error("write conflict: destination appeared before publication: " + entry.logicalPath + "; read it again before retrying", {cause:error});
        throw error;
      }
    }

    entry.replaced = true;
    // Record publication first so invalidation during awaited I/O triggers recovery.
    vfs.assertCurrent?.();
    vfs.signal?.throwIfAborted();
  }

  for (const entry of staged) {
    vfs.expected.set(entry.logicalPath, textSignature(entry.content));
  }

  // Canonical commit destinations must not rewrite established event paths
  // for newly created files, whose callers supplied a logical cwd spelling.
  if (staged.length) vfs.onNewFile?.(staged.map(entry => entry.existed ? entry.target : entry.logicalPath));
}

async function failCommit(vfs, staged, error) {
  const recoveryErrors = await recoverReplaced(staged);
  // Keep CAS baselines: a failed commit must not forgive conflicts on files it
  // never touched. If recovery left disk diverging from a baseline, the next
  // write to that path fails loudly and forces a re-read instead of silently
  // re-capturing unknown bytes as the new truth.

  if (recoveryErrors.length) vfs.mutations.recoveryFailed = true;

  if (recoveryErrors.length) vfs.onNewFile?.(null);

  if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors.map(message => new Error(message))], "commit failed: " + error.message + "; recovery failed: " + recoveryErrors.join("; "));
  throw error;
}

export {canonicalNewPath,assertExpectedSignature,collectMissingAncestors,makeStageEntry,stageReplacement,installStaged,failCommit,cleanupStaged};
