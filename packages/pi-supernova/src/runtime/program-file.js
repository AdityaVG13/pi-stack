import * as fs from "node:fs/promises";
import { resolveWorkspacePath } from "../fs/workspace.js";

/** Explicit source reuse, never a cached program or a persistent guest heap. */
export async function readProgramFile(file, cwd, maxChars, signal) {
  signal?.throwIfAborted();
  const target = await resolveWorkspacePath(cwd, file, "program file", false, true);
  // A FIFO must fail without waiting for a writer or occupying an I/O worker.
  const handle = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();

    if (!stat.isFile()) throw new Error("program file requires a regular file");
    // Every UTF-16 unit needs at most three UTF-8 bytes. Also check streamed size:
    // another editor can grow the file after stat. No prefix-only execution.
    const maxBytes = maxChars * 3;
    const tooLarge = () => new Error("code exceeds " + maxChars + " characters; split the program");

    if (stat.size > maxBytes) throw tooLarge();
    const chunks = [];
    let bytes = 0;

    for await (const chunk of handle.createReadStream({ end: maxBytes, autoClose: false, signal })) {
      bytes += chunk.length;

      if (bytes > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }

    signal?.throwIfAborted();
    // Do not silently replace invalid bytes in executable source. Preserve BOMs.
    const code = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));

    if (code.length > maxChars) throw tooLarge();

    return code;
  } finally { await handle.close(); }
}
