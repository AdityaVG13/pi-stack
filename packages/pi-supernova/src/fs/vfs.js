import {textSignature,sameFileVersion,fileSignature,tooLargeRead,overlayOrThrow,assertReadableFile,readLimitedBytes,remapReadError} from './file-io.js';
import {resolveCommitTarget,assertExpectedSignature,collectMissingAncestors,makeStageEntry,stageReplacement,installStaged,failCommit,cleanupStaged} from './commit.js';

export {resolveCommitTarget} from './commit.js';

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isString } from "../shared/decode.js";
import { decodeUtf8Strict } from "../shared/utf8.js";

// Serialize validation + replacement across Supernova transactions in this host.
let commitTail = Promise.resolve();

export class CausalVfs {
  constructor(onNewFile, validateWrite, assertCurrent) {
    this.validateWrite = validateWrite;
    this.assertCurrent = assertCurrent;
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

  async read(target, { preserveRead = false, maxBytes, label = "read input", strict = true } = {}) {
    const overlay = this.getOverlay(target);

    if (overlay !== undefined) return overlayOrThrow(overlay, maxBytes, label, target);

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
          : await readLimitedBytes(file, stat, maxBytes, label, this.signal, () => tooLargeRead(label,maxBytes,target));

        if (!sameFileVersion(stat, await file.stat())) throw new Error("file changed while reading: " + target);
      } finally { await file.close(); }

      // Hash the actual bytes, not a lossy UTF-8 decode/re-encode.
      if (!preserveRead || !this.expected.has(target)) this.expected.set(target, textSignature(bytes));

      return strict ? decodeUtf8Strict(bytes, target) : bytes.toString("utf8");
    } catch (err) {
      await remapReadError(err, target);
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
      // Admission may have preceded another transaction's asynchronous commit.
      this.assertCurrent?.();

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
