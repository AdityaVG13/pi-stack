import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {readResult} from '../shared/result.js';

export const MAX_DIRECTORY_ENTRIES = 10000;

export function formatDirectoryEntry(name, type, size = 0) {
  const sizeSuffix = size ? `, ${size} bytes` : "";

  return `${name}${type === "dir" ? "/" : ""} (${type}${sizeSuffix})`;
}

export async function formatLsEntry(dirPath, entry) {
  const isDir = entry.isDirectory();
  const isSym = entry.isSymbolicLink();
  const typeLabel = isDir ? "dir" : isSym ? "sym" : "file";
  let size = 0;

  try {
    if (!isDir && !isSym) {
      const st = await fs.stat(path.join(dirPath, entry.name));
      size = st.size;
    }
  } catch {}

  return formatDirectoryEntry(entry.name, typeLabel, size);
}
function admitEntry(rows, name, dirPath) {
  if (!rows.has(name) && rows.size >= MAX_DIRECTORY_ENTRIES) {
    throw new Error("directory exceeds " + MAX_DIRECTORY_ENTRIES + " entries: " + dirPath + "; read a subdirectory or use bash with a bounded directory parser");
  }
}

async function formatDirBatch(dirPath, batch, rows, signal) {
  const results = await Promise.all(batch.map(entry=>formatLsEntry(dirPath,entry)));
  signal?.throwIfAborted();
  for (let i=0;i<batch.length;i++) rows.set(batch[i].name,results[i]);
}

export function createDirectoryReader(vfs) {
  function overlayDirRows(dirPath, rows) {
    for (const file of vfs.getOverlayPaths()) {
      const relative = path.relative(dirPath,file);
      if (!relative || relative === ".." || relative.startsWith(".."+path.sep) || path.isAbsolute(relative)) continue;
      const [name,child] = relative.split(path.sep);
      admitEntry(rows,name,dirPath);
      rows.set(name,child === undefined
        ? formatDirectoryEntry(name,"file",Buffer.byteLength(vfs.getOverlay(file),"utf8"))
        : formatDirectoryEntry(name,"dir"));
    }
  }

  async function diskDirRows(dirPath, rows, signal) {
    let directory;
    try { directory = await fs.opendir(dirPath,{bufferSize:128}); }
    catch (error) { if (error.code === "ENOENT" && rows.size) return; throw error; }
    let batch = [];
    // Do not allocate the entire directory first or serialize every stat. Eight
    // metadata operations overlap; directory handles close on success/error/abort.
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (rows.has(entry.name)) continue;
      admitEntry(rows,entry.name,dirPath);
      rows.set(entry.name,undefined);
      batch.push(entry);
      if (batch.length === 8) { await formatDirBatch(dirPath,batch,rows,signal); batch = []; }
    }
    await formatDirBatch(dirPath,batch,rows,signal);
  }

  return async function readDirectory(dirPath, signal) {
    signal?.throwIfAborted();
    const rows = new Map();
    overlayDirRows(dirPath,rows);
    await diskDirRows(dirPath,rows,signal);
    const values = [...rows.values()];
    return readResult(values,{path:dirPath,directory:true,count:rows.size},values.slice(0,20).join("\n"),undefined,()=>values.join("\n"));
  };
}
