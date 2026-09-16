import * as fs from "node:fs/promises";
import * as path from "node:path";
import { relativeSlash } from "./workspace.js";

export const SOURCE_REF = /((?:\/|[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:m?[jt]sx?|c[jt]s|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|json|ya?ml|toml))(?::|\()(\d+)/g;

function prefix(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

async function readBoundedFile(real, rootPrefix, signal) {
  const handle = await fs.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));

  try {
    const stat = await handle.stat();

    if (!real.startsWith(rootPrefix) || !stat.isFile() || stat.size > 1024 * 1024) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);

      if (bytesRead <= 0) break;
      offset += bytesRead;
      signal?.throwIfAborted();
    }

    return buffer.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

function windowRows(text, lineNo, ledger, rel) {
  const raw = text.split("\n");

  if (lineNo < 1 || lineNo > raw.length) return null;
  const start = Math.max(1, lineNo - 2);
  const rows = [];

  for (let l = start; l <= Math.min(raw.length, lineNo + 2); l++) rows.push((l === lineNo ? "►" : " ") + String(l).padStart(4) + " " + raw[l - 1]);
  ledger.recordOrigin(rel, start, rows);

  return rel + ":" + lineNo + "\n" + rows.join("\n");
}

/** Fresh bounded source window for a diagnostic; no index warmup or stale cached bodies. */
export async function sourceWindow(cwd, commandCwd, file, lineNo, signal, ledger) {
  const candidate = path.resolve(commandCwd, file);

  try {
    const root = await fs.realpath(cwd);
    const cwdPrefix = prefix(path.resolve(cwd));
    const rootPrefix = prefix(root);

    if (!candidate.startsWith(cwdPrefix) && !candidate.startsWith(rootPrefix)) return null;
    const real = await fs.realpath(candidate);
    const text = await readBoundedFile(real, rootPrefix, signal);

    if (text === null) return null;

    return windowRows(text, lineNo, ledger, relativeSlash(root, real));
  } catch { return null; }
}

/** A failing command names path:line; the model wants those lines next. Attach them (≤4 sites). */
export async function sourceForReferences(cwd, commandCwd, output, signal, ledger) {
  const seen = new Set();
  const blocks = [];

  for (const m of output.matchAll(SOURCE_REF)) {
    const key = m[1] + ":" + m[2];

    if (seen.has(key)) continue;
    if (seen.size >= 4) break;
    seen.add(key);
    const block = await sourceWindow(cwd, commandCwd, m[1], Number(m[2]), signal, ledger);

    if (block) blocks.push(block);
  }

  return blocks.length ? "\n--- source\n" + blocks.join("\n") : "";
}
