// Generic alias registration: clone a pi-ai builtin provider under a slot id.
//
// No family table: pi-ai's builtinProviders() yields every builtin family
// (openai-codex, anthropic, xai, kimi-coding, ...), and Pi's
// registerProvider(id, def) takes the alias id plus the cloned def. The
// alias shares the base transport/auth implementation while Pi resolves
// credentials per provider id, so each alias authenticates as its own
// auth.json entry. Families with no builtin factory (extension transports
// like cursor/devin, custom providers like ollama) report unsupported —
// honestly, in status — instead of guessing.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PI_AI_SPEC = "@earendil-works/pi-ai/providers/all";

export function findPiAiRoot(startDir) {
  let dir = startDir;

  for (let depth = 0; depth < 6; depth += 1) {
    const root = join(dir, "node_modules", "@earendil-works", "pi-ai");

    if (existsSync(root)) return root;
    const parent = dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }

  return null;
}

function tryBareSpecifier(entryUrl) {
  try {
    return createRequire(entryUrl)(PI_AI_SPEC);
  } catch {
    return null;
  }
}

function tryFilePath(entryUrl, startDir) {
  const root = findPiAiRoot(startDir);

  if (!root) return null;
  const file = join(root, "dist", "providers", "all.js");

  if (!existsSync(file)) return null;

  try {
    return createRequire(entryUrl)(file);
  } catch {
    return null;
  }
}

// Path-installed checkouts (~/Developer/...) are not under the agent npm
// tree, so neither the bare specifier nor the upward walk can see pi-ai.
// The agent dir itself is the last resort.
function tryAgentDirNpm(entryUrl) {
  // Explicit override wins outright; otherwise the default agent dir. One
  // directory, no silent chain — and testable via PI_AGENT_DIR.
  const base = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  const file = join(base, "npm", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");

  if (!existsSync(file)) return null;

  try {
    return createRequire(entryUrl)(file);
  } catch {
    return null;
  }
}

// The pi-ai builtin registry module, via bare specifier first (pi-ai's
// exports map covers ./providers/*), then the filesystem walk, then the
// agent npm tree.
export function loadBuiltinModule(entryUrl, startDir) {
  const mod = tryBareSpecifier(entryUrl) || tryFilePath(entryUrl, startDir) || tryAgentDirNpm(entryUrl);

  if (!mod || !(mod.builtinProviders instanceof Function)) {
    return { module: null, error: "pi-ai builtin registry unavailable" };
  }

  return { module: mod, error: null };
}

// A FRESH base instance per call: each alias gets its own top-level and
// nested objects (function refs stay module singletons either way), so Pi
// can never cross-contaminate alias state through a shared def object.
export function builtinBase(mod, baseId) {
  if (!mod || !(mod.builtinProviders instanceof Function)) return null;

  try {
    const found = mod.builtinProviders().find((p) => p && p.id === baseId);

    return found || null;
  } catch {
    return null;
  }
}

export function aliasDef(base, aliasId, n) {
  const def = { ...base, id: aliasId, name: `${base.name} (account ${n})` };
  // pi 0.87.x: createProvider() attaches a streamSimple method to every
  // builtin, and validateExtensionProvider rejects any registration carrying
  // streamSimple without an api map. The host derives stream behavior from
  // the api map anyway, so drop the copied method from the alias.
  delete def.streamSimple;
  return def;
}

export function registerAlias(pi, base, aliasId, n) {
  pi.registerProvider(aliasId, aliasDef(base, aliasId, n));

  return "alias";
}
