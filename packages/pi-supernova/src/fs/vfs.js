import {textSignature,sameFileVersion,fileSignature,tooLargeRead,overlayOrThrow,assertReadableFile,readLimitedBytes,remapReadError} from './file-io.js';
import {canonicalNewPath,resolveCommitTarget,assertExpectedSignature,collectMissingAncestors,makeStageEntry,stageReplacement,installStaged,failCommit,cleanupStaged} from './commit.js';

export {resolveCommitTarget} from './commit.js';

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { decodeUtf8Strict } from "../shared/utf8.js";

// Serialize validation + replacement across Supernova transactions in this host.
let commitTail = Promise.resolve();

const readScopes = new Set();

let installingPaths = null;

function scopeContains(scope, target) {
  const relative = path.relative(scope, target);

  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function noteCommitPath(target) {
  installingPaths.add(target);

  for (const read of readScopes) {
    if (scopeContains(read.scope, target)) read.changed = true;
  }
}

// Readers validate after every in-process commit they could have observed.
// An aborted reader must not retain its buffers until another writer finishes.
async function waitForCommits(signal) {
  signal?.throwIfAborted();

  if (!signal) return commitTail;
  let abort;

  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });

  try { await Promise.race([commitTail, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}


export class CausalVfs {
  constructor(onNewFile, validateWrite, assertCurrent) {
    this.validateWrite = validateWrite;
    this.assertCurrent = assertCurrent;
    // No body cache: every read hits disk (or its overlay) so observed bytes
    // are never stale. CAS baselines in `expected` are the only retained
    // per-file state, cleared only at external-mutation boundaries.
    this.overlays = [];
    this.expected = new Map();
    this.pendingSignatures = new Map();
    this.onNewFile = onNewFile;
    this.closed = false;
    this.signal = undefined;
    this.mutations = { committed: 0, rolledBack: 0, external: 0, pendingCommits: 0, recoveryFailed: false };
  }

  assertWritable() {
    this.assertCurrent?.();

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

  async readRevision(scope) {
    let canonical;

    try { canonical = await fs.realpath(scope); }
    catch (error) {
      if (error.code !== "ENOENT") await remapReadError(error, scope);
      canonical = await canonicalNewPath(scope).catch(failure => remapReadError(failure, scope));
    }

    const read = { scope: canonical, changed: [...(installingPaths ?? [])].some(target => scopeContains(canonical, target)) };
    readScopes.add(read);

    return read;
  }

  releaseRead(read) { readScopes.delete(read); }

  async assertReadCommitted(read) {
    try {
      if (read.changed) await waitForCommits(this.signal);
      this.signal?.throwIfAborted();

      if (read.changed) throw new Error("workspace may have changed while reading; retry the read");
    } finally { this.releaseRead(read); }
  }

  async read(target, { preserveRead = false, maxBytes, label = "read input", strict = true } = {}) {
    const overlay = this.getOverlay(target);

    if (overlay !== undefined) return overlayOrThrow(overlay, maxBytes, label, target);

    let revision;

    // External editors and captured tools can change a file between any two reads.
    // Open once with O_NONBLOCK so a FIFO or device cannot park a host I/O worker.
    try {
      revision = await this.readRevision(target);
      const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
      let bytes;

      try {
        const stat = await file.stat();
        assertReadableFile(stat, target);
        bytes = maxBytes === undefined
          ? await file.readFile({ signal: this.signal })
          : await readLimitedBytes(file, stat, maxBytes, label, this.signal, () => tooLargeRead(label,maxBytes,target));

        if (!sameFileVersion(stat, await file.stat())) throw new Error("file changed while reading: " + target);
      } finally { await file.close(); }

      await this.assertReadCommitted(revision);

      // Hash the actual bytes, not a lossy UTF-8 decode/re-encode.
      if (!preserveRead || !this.expected.has(target)) this.expected.set(target, textSignature(bytes));

      return strict ? decodeUtf8Strict(bytes, target) : bytes.toString("utf8");
    } catch (err) {
      await remapReadError(err, target);
    } finally { this.releaseRead(revision); }
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

  async recordExpected(target, observed, bytes) {

    if (this.getOverlay(target) !== undefined) return;

    if (!observed) {
      this.expected.set(target, await this.#diskSignature(target));

      return;
    }

    // Loaded bytes may replace the second disk pass only for a whole file.
    if (bytes !== undefined && (!Buffer.isBuffer(bytes) || bytes.length !== observed.size)) throw new Error("file changed while reading: " + target + "; expected complete bytes");
    this.signal?.throwIfAborted();

    const revision = await this.readRevision(target);

    // Share only an in-flight hash of this exact observed file version. Never
    // retain a completed digest as a read cache or mix different snapshots.
    let job = this.pendingSignatures.get(target);

    if (!job || !sameFileVersion(job.observed, observed)) {
      job = { observed, promise: bytes === undefined
        ? fileSignature(target, this.signal, observed)
        : Promise.resolve(textSignature(bytes)) };
      this.pendingSignatures.set(target, job);
    }

    try {
      const signature = await job.promise;
      await this.assertReadCommitted(revision);

      // Each window may finish at a different time. Its own post-read version
      // check must survive sharing the hash with an earlier reader.
      if (!sameFileVersion(observed, await fs.stat(target))) throw new Error("file changed while reading: " + target);
      this.expected.set(target, signature);
    } finally {
      this.releaseRead(revision);

      if (this.pendingSignatures.get(target) === job) this.pendingSignatures.delete(target);
    }
  }

  async write(target, content) {
    this.assertWritable();

    if (!isString(content)) throw new Error("write requires string content");

    if (!content.isWellFormed()) throw new Error("write requires well-formed Unicode text: unpaired UTF-16 surrogate in " + target + "; avoid splitting a Unicode character");

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
    this.assertCurrent?.();
    this.signal?.throwIfAborted();

    if (!writes.size) return;
    this.mutations.pendingCommits++;
    const signal = this.signal;
    let started = false, cancelled = false, pendingWrites = writes;

    return new Promise((resolve, reject) => {
      const abort = () => {
        if (started || cancelled) return;
        cancelled = true;
        pendingWrites = null;
        this.mutations.pendingCommits--;
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };

      // Withdrawal does not release the predecessor's lock. A later live
      // transaction still waits for it; only this caller can settle early.
      const work = commitTail.then(async () => {
        if (cancelled) return;
        started = true;
        signal?.removeEventListener("abort", abort);

        installingPaths = new Set();

        for (const target of pendingWrites.keys()) noteCommitPath(target);

        try { resolve(await this.flushWrites(pendingWrites)); }
        catch (error) { reject(error); }
        finally { installingPaths = null; pendingWrites = null; this.mutations.pendingCommits--; }
      });

      commitTail = work.catch(() => {});
      signal?.addEventListener("abort", abort, {once:true});

      if (signal?.aborted) abort();
    });
  }

  async flushWrites(writes) {
    const staged = [];
    const targets = new Set();
    const createdDirs = [];
    let failed = false;

    try {
      // Admission may have preceded another transaction's asynchronous commit.
      this.assertCurrent?.();

      for (const [logicalPath, content] of writes) {
        this.signal?.throwIfAborted();
        const { target, stat } = await resolveCommitTarget(logicalPath);
        noteCommitPath(target);
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

  assertExternalAllowed(name) {
    this.assertWritable();

    if (this.overlays.length > 1) throw new Error(name + " cannot run inside an edit checkpoint because external mutations cannot be rolled back; run bash after the checkpoint, or use explicit restoration outside checkpoints for mutation tests");
  }

  async prepareExternalMutation(name) {
    this.assertExternalAllowed(name);

    if (!this.overlays.length) { this.mutations.external++;

 return false; }

    const pending = this.overlays[0];
    await this.flush(pending);
    // Committed writes no longer belong to the speculative rollback set.
    this.overlays[0] = new Map();
    this.assertWritable();
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
