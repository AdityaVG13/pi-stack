/**
 * pi-model-sync models.json merge.
 *
 * Ownership is by tag: entries stamped _managedBy are ours to update and
 * prune; everything else is the user's and is never touched. Pruning only
 * happens for providers whose live discovery succeeded, so a dead token or
 * a failed request can never wipe a catalog. A corrupt models.json aborts
 * the run instead of being clobbered.
 */

import { isObject } from "./decode.js";

export const MANAGED_BY = "pi-model-sync";

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

function isModelEntry(value) {
  return isObject(value) && "id" in value;
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
    doc = JSON.parse(text);
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
  const current = existing.find((item) => isModelEntry(item) && item.id === entry.id);

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
    if (!isModelEntry(item)) {
      // Unrecognized shapes are preserved untouched, like user entries.
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
export function planProviderUpdate(doc, providerId, entries, succeeded) {
  const section = doc.providers?.[providerId];
  const existing = Array.isArray(section?.models) ? section.models : [];
  const nextModels = [];
  const seen = new Set();
  // Existing objects already carried over. Identity, not id: duplicate
  // untagged entries share an id but each is user data to preserve.
  const consumed = new Set();
  const counts = { added: 0, updated: 0, removed: 0, kept: 0 };

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }

    seen.add(entry.id);

    const carried = carryEntry(existing, entry, consumed);
    nextModels.push(carried.model);
    counts[carried.tally] += 1;
  }

  const swept = sweepStale(existing, consumed, succeeded, nextModels);
  counts.removed += swept.removed;
  counts.kept += swept.kept;

  // Preserve provider-section keys the sync does not own (modelOverrides...).
  const nextProviders = { ...doc.providers };

  if (nextModels.length > 0 || section !== undefined) {
    nextProviders[providerId] = { ...section, models: nextModels };
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

    const kept = section.models.filter((item) => !isModelEntry(item) || item._managedBy !== MANAGED_BY);
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

// Returns {backupPath} (null when there was no file to back up). Backups
// never clobber: a same-second rerun gets a numeric suffix.
export function writeModelsFile(modelsPath, doc, fs) {
  let backupPath = null;

  try {
    fs.accessSync(modelsPath);
    backupPath = uniqueBackupPath(modelsPath, fs);
    fs.copyFileSync(modelsPath, backupPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  fs.writeFileSync(modelsPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  return { backupPath };
}

function existsSync(path, fs) {
  try {
    fs.accessSync(path);

    return true;
  } catch {
    return false;
  }
}

function uniqueBackupPath(modelsPath, fs) {
  const first = backupPathFor(modelsPath);

  if (!existsSync(first, fs)) {
    return first;
  }

  let counter = 2;

  while (existsSync(`${first}-${counter}`, fs)) {
    counter += 1;
  }

  return `${first}-${counter}`;
}
