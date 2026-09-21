import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {isString} from '../shared/decode.js';

function sessionUriParts(uri) {
  const match = /^(agent|artifact):\/\/([^/?#]+)$/i.exec(uri);

  if (!match) throw new Error("session resource reads support bare agent://<id> and artifact://<number>; use offset/limit for pagination");
  const kind = match[1].toLowerCase();
  const id = decodeURIComponent(match[2]);

  if (!id || id === "." || id === ".." || (/[/\\]/u.test(id) || Array.from(id).some(char => char.charCodeAt(0) < 32)) || (kind === "artifact" && !/^\d+$/.test(id))) throw new Error("invalid session resource ID");

  return { kind, id };
}

async function findArtifactFile(root, id, uri, signal) {
  const matches = [];
  let count = 0;

  for await (const entry of await fs.opendir(root)) {
    signal?.throwIfAborted();

    if (++count > 4096) throw new Error("session artifact lookup exceeded its directory budget");

    if (entry.name.startsWith(id + ".") && !entry.isDirectory()) matches.push(entry.name);
  }

  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous session artifact: " + uri : "session artifact not found: " + uri);

  return matches[0];
}

export async function resolveSessionResource(uri, signal, hooks) {
  const { kind, id } = sessionUriParts(uri);
  const dir = hooks.artifactsDir?.();

  if (!isString(dir) || !dir) throw new Error("this host session does not expose an artifacts directory for " + uri);
  signal?.throwIfAborted();
  const root = await fs.realpath(dir);
  const file = kind === "artifact" ? await findArtifactFile(root, id, uri, signal) : id + ".md";
  const target = await fs.realpath(path.join(root, file));

  if (!target.startsWith(root + path.sep)) throw new Error("session resource escapes its artifacts directory");

  if (!(await fs.stat(target)).isFile()) throw new Error("session resource is not a file: " + uri);
  signal?.throwIfAborted();

  return target;
}
