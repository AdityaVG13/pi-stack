/**
 * pi-model-sync models.json merge.
 *
 * Ownership is by tag and operation: stamped chat entries are ours to update
 * and prune; non-chat entries are always preserved, even if tagged. Pruning only
 * happens for providers whose live discovery succeeded, so a dead token or
 * a failed request can never wipe a catalog. A section that held only pruned
 * chat entries is removed (Pi rejects `{ models: [] }` with no other keys).
 * A corrupt models.json aborts the run instead of being clobbered. Reads
 * accept Pi's JSONC dialect (BOM, // comments, trailing commas); writes are
 * strict JSON.
 */

import { randomUUID } from "node:crypto";
import { isNonEmptyString, isObject } from "./decode.js";

export const MANAGED_BY = "pi-model-sync";

function stripBom(content) {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

// Same dialect Pi uses for models.json: // comments and trailing commas,
// with string literals left intact.
function stripJsonComments(input) {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    const items = [];

    for (const item of value) {
      items.push(canonicalize(item));
    }

    return `[${items.join(",")}]`;
  }

  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];

    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalize(value[key])}`);
    }

    return `{${parts.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function withoutTag(entry) {
  const copy = { ...entry };
  delete copy._managedBy;

  return copy;
}

function isChatEntry(value) {
  return isObject(value) && "id" in value && (value.type === undefined || value.type === "chat");
}

export function readModelsFile(modelsPath, fs) {
  let text;

  try {
    text = fs.readFileSync(modelsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { providers: {} };
    }

    throw error;
  }

  let doc;

  try {
    doc = JSON.parse(stripJsonComments(stripBom(text)));
  } catch {
    throw new Error(`models.json is corrupt (${modelsPath}); refusing to write`);
  }

  if (!isObject(doc) || (doc.providers !== undefined && !isObject(doc.providers))) {
    throw new Error(`models.json is corrupt (${modelsPath}); refusing to write`);
  }

  return { providers: {}, ...doc };
}

// Match one live entry against existing models. Returns the model to
// store plus which counter it bumps: new ids are added tagged, untagged
// residents and identical managed copies are kept as-is, changed managed
// copies refresh in place.
function carryEntry(existing, entry, consumed) {
  const current = existing.find((item) => isChatEntry(item) && item.id === entry.id);

  if (current === undefined) {
    return { model: { ...entry, _managedBy: MANAGED_BY }, tally: "added" };
  }

  consumed.add(current);

  if (current._managedBy !== MANAGED_BY) {
    return { model: current, tally: "kept" };
  }

  if (canonicalize(withoutTag(current)) === canonicalize(entry)) {
    return { model: current, tally: "kept" };
  }

  return { model: { ...entry, _managedBy: MANAGED_BY }, tally: "updated" };
}

// Sweep existing models the live list did not carry: unrecognized shapes
// and user entries stay, managed strays prune only on success.
function sweepStale(existing, consumed, succeeded, nextModels) {
  let removed = 0;
  let kept = 0;

  for (const item of existing) {
    if (!isChatEntry(item)) {
      // Chat discovery establishes nothing about another operation's catalog.
      nextModels.push(item);
      kept += 1;

      continue;
    }

    if (consumed.has(item)) {
      continue;
    }

    if (item._managedBy === MANAGED_BY && succeeded) {
      removed += 1;
    } else {
      nextModels.push(item);
      kept += 1;
    }
  }

  return { removed, kept };
}

// One provider's plan: entries are built model definitions (untagged).
// succeeded gates pruning: unknown state never deletes.
// residentIds are chat ids already composed outside this file (builtin /
// extension seeds). Writing them as models.json overlays replaces Pi's
// curated definition (compat, input, thinking maps). Refresh in place only
// when the id is already a file resident.
export function planProviderUpdate(doc, providerId, entries, succeeded, residentIds) {
  const section = doc.providers?.[providerId];
  const existing = Array.isArray(section?.models) ? section.models : [];
  const nextModels = [];
  const seen = new Set();
  // Existing objects already carried over. Identity, not id: duplicate
  // untagged entries share an id but each is user data to preserve.
  const consumed = new Set();
  const residents = new Set(residentIds ?? []);
  const counts = { added: 0, updated: 0, removed: 0, kept: 0 };

  for (const entry of entries) {
    if (!isChatEntry(entry) || !isNonEmptyString(entry.id) || seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);

    if (residents.has(entry.id) && !existing.some((item) => isChatEntry(item) && item.id === entry.id)) {
      continue;
    }

    const carried = carryEntry(existing, entry, consumed);
    nextModels.push(carried.model);
    counts[carried.tally] += 1;
  }

  const swept = sweepStale(existing, consumed, succeeded, nextModels);
  counts.removed += swept.removed;
  counts.kept += swept.kept;

  // Preserve provider-section keys the sync does not own (modelOverrides...).
  // A section that held only pruned chat entries is removed, matching the
  // orphan sweep: Pi composition-errors on `{ models: [] }` with no other keys.
  const nextProviders = { ...doc.providers };

  if (nextModels.length > 0) {
    nextProviders[providerId] = { ...section, models: nextModels };
  } else if (isObject(section)) {
    const rest = Object.keys(section).filter((key) => key !== "models");

    if (rest.length === 0) {
      delete nextProviders[providerId];
    } else {
      nextProviders[providerId] = { ...section, models: nextModels };
    }
  }

  return { next: { ...doc, providers: nextProviders }, ...counts };
}

function backupStamp(when) {
  return when.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function backupPathFor(modelsPath, when = new Date()) {
  return `${modelsPath}.bak-${backupStamp(when)}`;
}

// Drop managed entries for providers absent from the registry (extension
// uninstalled: Pi composition errors on the orphan section every startup,
// and the entries can never sync again). Untagged entries always stay; a
// section that held only swept entries is removed, while sections with
// user keys (baseUrl, headers...) keep their shape. Returns {next, swept}
// with swept sorted by provider for deterministic reports.
export function planOrphanSweep(doc, knownIds) {
  const known = new Set(knownIds);
  const swept = [];
  const nextProviders = { ...doc.providers };

  for (const providerId of Object.keys(nextProviders).sort()) {
    if (known.has(providerId)) {
      continue;
    }

    const section = nextProviders[providerId];

    if (!isObject(section) || !Array.isArray(section.models)) {
      continue;
    }

    const kept = section.models.filter((item) => !isChatEntry(item) || item._managedBy !== MANAGED_BY);
    const removed = section.models.length - kept.length;

    if (removed === 0) {
      continue;
    }

    swept.push({ providerId, removed });

    const rest = Object.keys(section).filter((key) => key !== "models");

    if (kept.length === 0 && rest.length === 0) {
      delete nextProviders[providerId];
    } else {
      nextProviders[providerId] = { ...section, models: kept };
    }
  }

  return { next: { ...doc, providers: nextProviders }, swept };
}

function publicationTarget(modelsPath, fs) {
  try {
    fs.lstatSync(modelsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: modelsPath, mode: 0o600 };

    throw error;
  }

  // Follow existing symlinks rather than replacing the user's link. A dangling
  // link is not a missing file: realpath must reject it before any publication.
  const path = fs.realpathSync.native(modelsPath);
  const info = fs.statSync(path);

  if (!info.isFile()) throw new Error("models.json must be a regular file");

  fs.accessSync(path, fs.constants.W_OK);

  return { path, mode: info.mode & 0o777 };
}

function backUpModels(modelsPath, fs) {
  const first = backupPathFor(modelsPath);

  for (let suffix = 1; ; suffix += 1) {
    const path = suffix === 1 ? first : `${first}-${suffix}`;

    try {
      fs.copyFileSync(modelsPath, path, fs.constants.COPYFILE_EXCL);

      return path;
    } catch (error) {
      if (error?.code === "EEXIST") continue;

      if (error?.code === "ENOENT") return null;

      throw error;
    }
  }
}

// Synchronous merge callers cannot interleave in this process. Staging keeps
// partial writes away from the live file; this is not external-writer CAS.
export function writeModelsFile(modelsPath, doc, fs) {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const target = publicationTarget(modelsPath, fs);
  const backupPath = backUpModels(modelsPath, fs);
  const stagedPath = `${target.path}.tmp-${randomUUID()}`;
  let owned = false;

  try {
    const fd = fs.openSync(stagedPath, "wx", target.mode);
    owned = true;

    try {
      fs.fchmodSync(fd, target.mode);
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(stagedPath, target.path);
    owned = false;
  } finally {
    if (owned) fs.unlinkSync(stagedPath);
  }

  return { backupPath };
}
