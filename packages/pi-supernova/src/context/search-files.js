import * as path from 'node:path';
import {WorkspaceIndex} from './repo-index.js';

function pendingInScope(root, pendingPaths) {
  return pendingPaths.filter(file => {
    const relative = path.relative(root, file);

    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  });
}

function overlaySearchEntry(index, filePath, overlayText) {
  const pending = overlayText(filePath);

  return pending === undefined
    ? index.entry(filePath)
    : Buffer.byteLength(pending, "utf8") <= 512 * 1024 ? WorkspaceIndex.fromText(filePath, pending) : null;
}

// Resolve filesystem aliases once per distinct candidate, not per matching line.
// The snapshot is call-local; synchronous index/scoring code never sees promises.
export async function overlaySnapshot(files, overlayText, signal) {
  const paths = [...new Set(files)], values = new Map();

  for (let i = 0; i < paths.length; i += 8) {
    signal?.throwIfAborted();
    await Promise.all(paths.slice(i, i + 8).map(async file => {
      const value = await overlayText(file);

      if (value !== undefined) values.set(file, value);
    }));
  }

  signal?.throwIfAborted();

  return file => values.get(file);
}

export { pendingInScope, overlaySearchEntry };
