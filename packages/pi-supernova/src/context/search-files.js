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
export { pendingInScope, overlaySearchEntry };
