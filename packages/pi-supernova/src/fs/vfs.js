import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { createHash, randomUUID } from "node:crypto";

// Serialize validation + replacement across Supernova transactions in this host.
let commitTail = Promise.resolve();

function textSignature(text) {
  return { size: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function sameFileVersion(a, b) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
}

async function fileSignature(target, signal, observed) {
  const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    const actual = await file.stat();

    if (!actual.isFile()) throw new Error("read requires a regular file: " + target);
    if (observed && !sameFileVersion(observed, actual)) throw new Error("file changed while reading: " + target);
    const hash = createHash("sha256");

    for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    const after = await file.stat();

    if (!after.isFile() || !sameFileVersion(actual, after)) throw new Error("file changed while signing: " + target);

    return { size: actual.size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

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

function sameSignature(a, b) {
  return a === b || (a !== null && b !== null && a.size === b.size && a.sha256 === b.sha256);
}

function tooLargeRead(label, maxBytes) {
  return new Error(label + " exceeds " + maxBytes + " bytes; use a streaming parser through bash");
}

function overlayOrThrow(overlay, maxBytes, label) {
  if (maxBytes !== undefined && Buffer.byteLength(overlay, "utf8") > maxBytes) throw tooLargeRead(label, maxBytes);

  return overlay;
}

function assertReadableFile(stat, target) {
  if (stat.isDirectory()) throw new Error("read path is a directory, not a file: " + target);

  if (!stat.isFile()) throw new Error("read requires a regular file: " + target);
}

async function readLimitedBytes(file, stat, maxBytes, label, signal) {
  if (stat.size > maxBytes) throw tooLargeRead(label, maxBytes);
  const chunks = [];
  let size = 0;

  for await (const chunk of file.createReadStream({ end: maxBytes, autoClose: false, signal })) {
    size += chunk.length;

    if (size > maxBytes) throw tooLargeRead(label, maxBytes);
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function remapReadError(err, target) {
  if (err.code === "EISDIR") throw new Error("read path is a directory, not a file: " + target);

  if (err.code === "ENOENT") {
    const missing = new Error("no such file: " + target + ' (locate it with read using a directory path or source question)');
    missing.code = "ENOENT";
    throw missing;
  }

  throw err;
}

async function resolveExistingFile(logicalPath) {
  const target = await fs.realpath(logicalPath);
  const stat = await fs.stat(target);

  if (!stat.isFile()) throw new Error("cannot write to a non-file: " + logicalPath);

  return { target, stat };
}

async function resolveCommitTarget(logicalPath) {
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
  await fs.writeFile(entry.temporary, content, { encoding: "utf8", flag: "wx", mode: stat ? stat.mode & 0o7777 : 0o666 });

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

export class CausalVfs {
  constructor(onNewFile, validateWrite) {
    this.validateWrite = validateWrite;
    // No body cache: every read hits disk (or its overlay) so observed bytes
    // are never stale. CAS baselines in `expected` are the only retained
    // per-file state, cleared only at external-mutation boundaries.
    this.overlays = [];
    this.expected = new Map();
    this.onNewFile = onNewFile;
    this.closed = false;
    this.signal = undefined;
    this.mutations = { committed: 0, rolledBack: 0, external: 0, pendingCommits: 0, recoveryFailed: false };
  }

  assertWritable() {
    if (this.closed) throw new Error("program is already complete");
    this.signal?.throwIfAborted();
  }

  getOverlay(target) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      if (this.overlays[i].has(target)) return this.overlays[i].get(target);
    }
  }

  getOverlayPaths() {
    return [...new Set(this.overlays.flatMap(overlay => [...overlay.keys()]))];
  }

  async read(target, { preserveRead = false, maxBytes, label = "read input" } = {}) {
    const overlay = this.getOverlay(target);

    if (overlay !== undefined) return overlayOrThrow(overlay, maxBytes, label);

    // External editors and captured tools can change a file between any two reads.
    // Open once with O_NONBLOCK so a FIFO or device cannot park a host I/O worker.
    try {
      const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      let bytes;

      try {
        const stat = await file.stat();
        assertReadableFile(stat, target);
        bytes = maxBytes === undefined
          ? await file.readFile({ signal: this.signal })
          : await readLimitedBytes(file, stat, maxBytes, label, this.signal);
        if (!sameFileVersion(stat, await file.stat())) throw new Error("file changed while reading: " + target);
      } finally { await file.close(); }

      // Hash the actual bytes, not a lossy UTF-8 decode/re-encode.
      if (!preserveRead || !this.expected.has(target)) this.expected.set(target, textSignature(bytes));

      return bytes.toString("utf8");
    } catch (err) {
      remapReadError(err, target);
    }
  }

  async #diskSignature(target) {
    let stat;

    try { stat = await fs.stat(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    return stat?.isFile() ? await fileSignature(target, this.signal, stat) : null;
  }

  async captureExpected(target) {
    if (this.getOverlay(target) !== undefined || this.expected.has(target)) return;

    this.expected.set(target, await this.#diskSignature(target));
  }

  async recordExpected(target, observed) {
    if (this.getOverlay(target) !== undefined) return;
    const signature = observed ? await fileSignature(target, this.signal, observed) : await this.#diskSignature(target);
    this.expected.set(target, signature);
  }

  async write(target, content) {
    this.assertWritable();

    if (!isString(content)) throw new Error("write requires string content");

    try {
      if ((await fs.stat(target)).isDirectory()) throw new Error("cannot write to a directory: " + target);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    this.assertWritable();

    await this.captureExpected(target);

    this.assertWritable();

    if (this.overlays.length) {
      this.overlays.at(-1).set(target, content);

      return { speculative: true };
    }

    await this.flush(new Map([[target, content]]));

    return { speculative: false };
  }

  begin() {
    this.assertWritable();
    this.overlays.push(new Map());

    return this.overlays.length;
  }

  /** Stage every file and its backup before replacing any destination. */
  async flush(writes) {
    this.mutations.pendingCommits++;
    const work = commitTail.then(() => this.flushWrites(writes)).finally(() => { this.mutations.pendingCommits--; });
    commitTail = work.catch(() => {});

    return work;
  }

  async flushWrites(writes) {
    const staged = [];
    const targets = new Set();
    const createdDirs = [];
    let failed = false;

    try {
      for (const [logicalPath, content] of writes) {
        this.signal?.throwIfAborted();
        const { target, stat } = await resolveCommitTarget(logicalPath);
        await this.validateWrite?.(logicalPath);

        if (targets.has(target)) throw new Error("conflicting write aliases: " + logicalPath);
        targets.add(target);
        await assertExpectedSignature(this, logicalPath, target, stat);
        const parent = path.dirname(target);
        const missing = await collectMissingAncestors(parent);
        await fs.mkdir(parent, { recursive: true });
        createdDirs.push(...missing.reverse());
        const entry = makeStageEntry(logicalPath, target, content, parent, stat);
        staged.push(entry);
        await stageReplacement(entry, content, stat, target);
      }

      await installStaged(this, staged);
      this.mutations.committed += staged.length;
    } catch (error) {
      failed = true;
      await failCommit(this, staged, error);
    } finally {
      await cleanupStaged(staged, failed, createdDirs);
    }
  }

  async commit() {
    if (!this.overlays.length) return { committed: 0, depth: 0 };
    const top = this.overlays.at(-1);

    if (this.overlays.length > 1) {
      const parent = this.overlays[this.overlays.length - 2];

      for (const [key, value] of top) parent.set(key, value);
    } else {
      await this.flush(top);
    }

    this.overlays.pop();

    return { committed: top.size, depth: this.overlays.length };
  }

  rollback() {
    const top = this.overlays.pop();
    this.mutations.rolledBack += top?.size ?? 0;

    // Rolling back staged writes does not undo observations of disk. Keep the
    // read snapshot, including for files without a surviving parent overlay.

    return { rolledBack: top?.size ?? 0, depth: this.overlays.length };
  }

  async prepareExternalMutation(name) {
    this.assertWritable();

    if (this.overlays.length > 1) throw new Error(name + " cannot run inside an edit checkpoint because external mutations cannot be rolled back");

    if (!this.overlays.length) { this.mutations.external++;

 return false; }

    const pending = this.overlays[0];
    await this.flush(pending);
    this.assertWritable();
    this.overlays[0] = new Map();
    this.mutations.external++;

    return pending.size > 0;
  }

  /** External-mutation boundary: drop CAS baselines so the next access re-observes disk. */
  invalidateObserved() { this.expected.clear(); }
  getOverlayDepth() { return this.overlays.length; }
  describeOverlays() {
    let files = 0, bytes = 0;

    for (const layer of this.overlays) {
      for (const content of layer.values()) {
        files++;
        bytes += Buffer.byteLength(content, "utf8");
      }
    }

    return { files, bytes };
  }
}
