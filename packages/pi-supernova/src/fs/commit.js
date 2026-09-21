import fs from 'node:fs/promises';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileSignature,sameSignature,textSignature} from './file-io.js';

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

  return { logicalPath, target, content, temporary: path.join(parent, token + ".new"), backup: path.join(parent, token + ".bak"), existed: !!stat, replaced: false };
}

async function recoverReplaced(staged) {
  const recoveryErrors = [];

  for (const entry of staged.toReversed()) {
    if (!entry.replaced) continue;

    try {
      if (entry.existed) await fs.rename(entry.backup, entry.target);
      else await fs.unlink(entry.target);
    } catch (err) {
      // Keep the backup if recovery fails; never delete the remaining original.
      entry.keepBackup = true;
      recoveryErrors.push(entry.target + ": " + err.message + " (backup: " + entry.backup + ")");
    }
  }

  return recoveryErrors;
}

async function cleanupStaged(staged, failed, createdDirs) {
  for (const entry of staged) {
    // A successful rename consumed the temporary path. These are known
    // files, so unlink avoids rm's extra type probe; missing files stay benign.
    if (!entry.replaced) await fs.unlink(entry.temporary).catch(() => {});

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
    vfs.signal?.throwIfAborted();
    await fs.rename(entry.temporary, entry.target);
    entry.replaced = true;
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
export {assertExpectedSignature,collectMissingAncestors,makeStageEntry,stageReplacement,installStaged,failCommit,cleanupStaged};
