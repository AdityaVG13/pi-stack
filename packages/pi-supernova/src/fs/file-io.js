import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

function textSignature(text) {
  return { size: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function sameFileVersion(a, b) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
}

// FileHandle streams with an already-aborted signal can emit a second, unhandled
// error even after for-await rejects (Node and Bun). Own the bounded reads instead.
async function* fileChunks(file, signal, maxBytes = Infinity) {
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
  let remaining = maxBytes;

  while (remaining > 0) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining), null);
    signal?.throwIfAborted();
    if (!bytesRead) break;
    remaining -= bytesRead;
    // Consumers retaining a chunk must copy it before the next read.
    yield buffer.subarray(0, bytesRead);
  }
}

async function fileSignature(target, signal, observed) {
  const file = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    const actual = await file.stat();

    if (!actual.isFile()) throw new Error("read requires a regular file: " + target);
    if (observed && !sameFileVersion(observed, actual)) throw new Error("file changed while reading: " + target);
    const hash = createHash("sha256");

    for await (const chunk of fileChunks(file, signal)) hash.update(chunk);
    const after = await file.stat();

    if (!after.isFile() || !sameFileVersion(actual, after)) throw new Error("file changed while signing: " + target);

    return { size: actual.size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

function sameSignature(a, b) {
  return a === b || (a !== null && b !== null && a.size === b.size && a.sha256 === b.sha256);
}

function tooLargeRead(label, maxBytes, target) {
  return new Error(label + " exceeds " + maxBytes + " bytes" + (target ? ": " + target : "") + "; use a streaming parser through bash");
}

function overlayOrThrow(overlay, maxBytes, label, target) {
  if (maxBytes !== undefined && Buffer.byteLength(overlay, "utf8") > maxBytes) throw tooLargeRead(label, maxBytes, target);

  return overlay;
}

function assertReadableFile(stat, target) {
  // Callers are reads, writes, edits and patch application: name the path, not the caller.
  if (stat.isDirectory()) throw new Error("path is a directory, not a file: " + target);

  if (!stat.isFile()) throw new Error("path is not a regular file: " + target);
}

async function readLimitedBytes(file, stat, maxBytes, label, signal, overflow = () => tooLargeRead(label, maxBytes)) {
  if (stat.size > maxBytes) throw overflow();
  const chunks = [];
  let size = 0;

  for await (const chunk of fileChunks(file, signal, maxBytes + 1)) {
    size += chunk.length;

    if (size > maxBytes) throw overflow();
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function remapReadError(err, target) {
  if (err.code === "EISDIR") throw new Error("path is a directory, not a file: " + target);

  if (err.code === "ENOTDIR") throw new Error("cannot use path: a parent component of " + target + " is a file, not a directory");
  if (err.code === "EACCES" || err.code === "EPERM") throw new Error("permission denied reading " + target + ": check the file mode (for example bash chmod)");

  if (err.code === "ENOENT") {
    const missing = new Error("no such file: " + target + ' (locate it with read using a directory path or source question; use Promise.allSettled for optional reads to retain successful siblings)');
    missing.code = "ENOENT";
    throw missing;
  }

  throw err;
}
export { textSignature, sameFileVersion, fileChunks, fileSignature, sameSignature, tooLargeRead, overlayOrThrow, assertReadableFile, readLimitedBytes, remapReadError };
