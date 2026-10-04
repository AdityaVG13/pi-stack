import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {assertModelImageMime} from '../shared/decode.js';
import {validateImageBytes} from '../shared/image.js';
import {readLimitedBytes} from '../fs/file-io.js';
import {IMAGE_MIME,IMAGE_MAX_BYTES,imageTooLarge,missingFile} from './errors.js';

export function createImageReader(vfs) {
  async function readImage(rel, targetPath, signal) {
    const staged = await vfs.getOverlay(targetPath);

    if (staged !== undefined) {
      const size = Buffer.byteLength(staged, "utf8");

      if (size > IMAGE_MAX_BYTES) throw imageTooLarge(rel, size);

      return Buffer.from(staged);
    }

    let file;

    try { file = await fs.open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if (error.code === "ENOENT") throw missingFile(targetPath);
      throw error;
    }

    let stat, bytes;

    try {
      stat = await file.stat();

      if (!stat.isFile()) throw new Error("image read requires a regular file: " + targetPath);

      if (stat.size > IMAGE_MAX_BYTES) throw imageTooLarge(rel, stat.size);
      bytes = await readLimitedBytes(file, stat, IMAGE_MAX_BYTES, "image", signal,
        () => new Error("image read limit exceeded: " + rel + "; maximum " + IMAGE_MAX_BYTES + " bytes (20 MiB); resize or select fewer/smaller images"));
    } finally { await file.close(); }

    // Recovery must be able to replace the destination before we await it.
    await vfs.recordExpected(targetPath, stat, bytes);

    return bytes;
  }

  async function maybeImage(rel, targetPath, signal) {
    const mime = IMAGE_MIME[path.extname(targetPath).toLowerCase()];

    if (!mime) return null;
    assertModelImageMime(mime);
    const bytes = await readImage(rel, targetPath, signal);

    await validateImageBytes(bytes,mime,rel,signal);

    return { content: [{ type: "image", mimeType: mime, data: bytes.toString("base64") }], details: { path: targetPath } };
  }

  return maybeImage;
}
