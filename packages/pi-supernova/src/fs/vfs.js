import {textSignature,sameSignature,sameFileVersion,fileSignature,tooLargeRead,overlayOrThrow,assertReadableFile,readLimitedBytes,remapReadError} from './file-io.js';
import {resolveFileIdentity,resolveCommitTarget,assertExpectedSignature,collectMissingAncestors,makeStageEntry,stageReplacement,installStaged,failCommit,cleanupStaged} from './commit.js';

export {resolveCommitTarget} from './commit.js';

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
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
    // are never stale. CAS signatures and observed logical-to-physical bindings
    // survive between operations, but clear at external-mutation boundaries.
    this.overlays = [];
    this.expected = new Map();
    this.observedPaths = new Map();
    this.pathScope = new AsyncLocalStorage();
    this.bestEffort = false;
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

  // Reuse identity only within one native operation. Commit resolution is
  // always fresh, and no path/body cache survives into the next operation.
  withPathScope(fn) { return this.pathScope.run({paths:new Map()}, fn); }

  bindMutationRecord(record) {
    const scope = this.pathScope.getStore();

    if (scope) scope.record = record;
  }

  async resolvePath(target, allowMissing = true) {
    const scope = this.pathScope.getStore()?.paths;
    let pending = scope?.get(target);

    if (!pending) {
      pending = resolveFileIdentity(target);
      scope?.set(target, pending);
    }

    const identity = await pending;

    if (!allowMissing && identity.missing) throw identity.missing;

    return identity.path;
  }

  #assertWriteAlias(logicalPath, entry) {
    if (entry && entry.logicalPath !== logicalPath) throw new Error("conflicting write aliases: " + logicalPath);
  }

  #overlay(target) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const entry = this.overlays[i].get(target);

      if (entry) return entry;
    }
  }

  async getOverlay(target) {
    this.signal?.throwIfAborted();

    if (!this.overlays.some(layer => layer.size)) return undefined;

    return this.#overlay(await this.resolvePath(target))?.content;
  }

  async getOverlayPaths(scope) {
    const entries = new Map(this.overlays.flatMap(overlay => [...overlay]));

    if (!scope || !entries.size) return [...entries.values()].map(entry => entry.logicalPath);
    const canonical = await this.resolvePath(scope);

    // Expose the caller's scope spelling, including directories not yet on disk.
    const paths = [];

    for (const target of entries.keys()) {
      if (scopeContains(canonical, target)) paths.push(path.resolve(scope, path.relative(canonical, target)));
    }

    return paths;
  }

  #assertIdentity(logicalPath, target) {
    const observed = this.observedPaths.get(logicalPath);

    if (observed !== undefined && observed !== target) throw new Error("write conflict: path target changed since it was read: " + logicalPath + "; read it again before retrying");
  }

  #observe(logicalPath, target, signature, preserveRead = false) {
    if (preserveRead) this.#assertIdentity(logicalPath, target);

    if (!preserveRead || !this.expected.has(target)) this.expected.set(target, signature);
    this.observedPaths.set(logicalPath, target);
  }

  async readRevision(scope) {
    let canonical;

    try { canonical = await this.resolvePath(scope); }
    catch (error) { await remapReadError(error, scope); }

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

  async read(target, { preserveRead = false, forWrite = false, maxBytes, label = "read input", strict = true } = {}) {
    this.signal?.throwIfAborted();
    let revision;

    // External editors and captured tools can change a file between any two reads.
    // Open once with O_NONBLOCK so a FIFO or device cannot park a host I/O worker.
    try {
      revision = await this.readRevision(target);
      const overlay = this.#overlay(revision.scope);

      if (forWrite) this.#assertWriteAlias(target, overlay);

      if (overlay) return overlayOrThrow(overlay.content, maxBytes, label, target);
      const file = await fs.open(revision.scope, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
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
      this.#observe(target, revision.scope, textSignature(bytes), preserveRead || forWrite);

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
    const canonical = await this.resolvePath(target);
    await this.#captureExpected(target, canonical);
  }

  async #captureExpected(logicalPath, target) {
    this.#assertIdentity(logicalPath, target);

    if (!this.#overlay(target) && !this.expected.has(target)) this.expected.set(target, await this.#diskSignature(target));
    this.observedPaths.set(logicalPath, target);
  }

  async recordExpected(target, observed, bytes) {
    this.signal?.throwIfAborted();
    const revision = await this.readRevision(target), canonical = revision.scope;
    let job;

    try {
      if (this.#overlay(canonical)) return;

      if (!observed) {
        this.#observe(target, canonical, await this.#diskSignature(canonical));

        return;
      }

      // Windows timestamps can alias same-size rewrites; loaded bytes must
      // still agree with disk. Other hosts can reuse a complete byte snapshot.
      if (bytes !== undefined && (!Buffer.isBuffer(bytes) || bytes.length !== observed.size)) throw new Error("file changed while reading: " + target + "; expected complete bytes");
      job = this.pendingSignatures.get(canonical);

      if (!job || !sameFileVersion(job.observed, observed)) {
        job = { observed, promise: bytes === undefined || process.platform === "win32"
          ? fileSignature(canonical, this.signal, observed)
          : Promise.resolve(textSignature(bytes)) };
        this.pendingSignatures.set(canonical, job);
      }

      const signature = await job.promise;

      if (bytes !== undefined && process.platform === "win32" && !sameSignature(signature, textSignature(bytes))) throw new Error("file changed while reading: " + target);
      await this.assertReadCommitted(revision);

      // Each window retains its own post-read check even when hashing overlaps.
      if (!sameFileVersion(observed, await fs.stat(canonical))) throw new Error("file changed while reading: " + target);
      this.#observe(target, canonical, signature);
    } finally {
      this.releaseRead(revision);

      if (job && this.pendingSignatures.get(canonical) === job) this.pendingSignatures.delete(canonical);
    }
  }

  async write(target, content) {
    this.assertWritable();

    if (!isString(content)) throw new Error("write requires string content");

    if (!content.isWellFormed()) throw new Error("write requires well-formed Unicode text: unpaired UTF-16 surrogate in " + target + "; avoid splitting a Unicode character");

    const canonical = await this.resolvePath(target);
    const previous = this.#overlay(canonical);

    this.#assertWriteAlias(target, previous);

    if (!previous) {
      try {
        if ((await fs.stat(canonical)).isDirectory()) throw new Error("cannot write to a directory: " + target);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }

    this.assertWritable();

    await this.#captureExpected(target, canonical);

    this.assertWritable();
    const latest = this.#overlay(canonical);

    // Concurrent aliases may have staged while signature capture awaited I/O.
    this.#assertWriteAlias(target, latest);

    const record = this.pathScope.getStore()?.record;

    // The host retains an empty outer layer for program lifecycle bookkeeping.
    // Best-effort mode stages only inside an explicit inner checkpoint.
    if (this.overlays.length && (!this.bestEffort || this.overlays.length > 1)) {
      this.overlays.at(-1).set(canonical, { logicalPath: target, content });

      if (record) { record.mutationState = "pending"; record.mutationDepth = this.overlays.length; }

      return { speculative: true };
    }

    try {
      await this.flush(new Map([[target, content]]), new Map([[target, canonical]]));

      if (record) record.mutationState = "saved";
    } catch (error) {
      if (record && this.mutations.recoveryFailed) record.mutationState = "uncertain";
      throw error;
    }

    return { speculative: false };
  }

  begin() {
    this.assertWritable();
    this.overlays.push(new Map());

    return this.overlays.length;
  }

  /** Stage every file and its backup before replacing any destination. */
  async #flushOverlay(overlay) {
    const writes = new Map(), targets = new Map();

    for (const [target, entry] of overlay) {
      writes.set(entry.logicalPath, entry.content);
      targets.set(entry.logicalPath, target);
    }

    return this.flush(writes, targets);
  }

  async flush(writes, pinnedTargets = new Map()) {
    this.assertCurrent?.();
    this.signal?.throwIfAborted();

    if (!writes.size) return;
    this.mutations.pendingCommits++;
    const signal = this.signal;
    let started = false, cancelled = false, pendingWrites = writes, pendingTargets = pinnedTargets;

    return new Promise((resolve, reject) => {
      const abort = () => {
        if (started || cancelled) return;
        cancelled = true;
        pendingWrites = null;
        pendingTargets = null;
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

        try { resolve(await this.flushWrites(pendingWrites, pendingTargets)); }
        catch (error) { reject(error); }
        finally { installingPaths = null; pendingWrites = null; pendingTargets = null; this.mutations.pendingCommits--; }
      });

      commitTail = work.catch(() => {});
      signal?.addEventListener("abort", abort, {once:true});

      if (signal?.aborted) abort();
    });
  }

  async flushWrites(writes, pinnedTargets = new Map()) {
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
        // Validation may wait or cancel; publish the physical read hazard first.
        noteCommitPath(target);
        await this.validateWrite?.(logicalPath);
        this.#assertIdentity(logicalPath, target);

        if (pinnedTargets.has(logicalPath) && pinnedTargets.get(logicalPath) !== target) throw new Error("write conflict: path target changed while staged: " + logicalPath);

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

    if (this.overlays.length > 1 && !(this.bestEffort && this.overlays.length === 2)) {
      const parent = this.overlays[this.overlays.length - 2];

      for (const [key, value] of top) parent.set(key, value);
    } else {
      await this.#flushOverlay(top);
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
    await this.#flushOverlay(pending);
    // Committed writes no longer belong to the speculative rollback set.
    this.overlays[0] = new Map();
    this.assertWritable();
    this.mutations.external++;

    return pending.size > 0;
  }

  /** External-mutation boundary: drop CAS baselines so the next access re-observes disk. */
  invalidateObserved() { this.expected.clear(); this.observedPaths.clear(); this.pathScope.getStore()?.paths.clear(); }
  getOverlayDepth() { return this.overlays.length; }
  describeOverlays() {
    let files = 0, bytes = 0;

    for (const layer of this.overlays) {
      for (const entry of layer.values()) {
        files++;
        bytes += Buffer.byteLength(entry.content, "utf8");
      }
    }

    return { files, bytes };
  }
}
