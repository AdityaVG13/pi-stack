import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStorage, mutateStoredAuth } from "./credentials.js";
import { parseSlotId } from "./slots.js";

function ownerPath(dir) {
  return join(dir, "config", "pi-rotator", "accounts.json");
}

const ACCOUNT_ENDPOINTS = new Map([["qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"], ["ollama", "https://ollama.com/v1"]]);

function legacyCursorOwner(id, source) {
  return parseSlotId(id)?.base === "cursor" && (source.apiKey === "cursor-proxy" || Object.keys(source).length === 1 && source.modelOverrides);
}

function legacyAccountOwner(id, source) {
  if (legacyCursorOwner(id, source)) return "cursor";
  const endpoint = ACCOUNT_ENDPOINTS.get(id);

  return endpoint && source.baseUrl === endpoint ? id : undefined;
}

export function ownedAccountFamilies(dir, models) {
  const owners = new Set(readStorage(ownerPath(dir)).families || []);

  for (const [id, source] of Object.entries(models)) {
    const owner = legacyAccountOwner(id, source);

    if (owner) owners.add(owner);
  }

  return owners;
}

export function markAccountOwner(dir, family) {
  const path = ownerPath(dir);
  mkdirSync(join(dir, "config", "pi-rotator"), { recursive: true });

  if (!existsSync(path)) {
    try { writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }

  mutateStoredAuth(path, current => ({ ...current, families: [...new Set([...(current.families || []), family])].sort() }));
}
