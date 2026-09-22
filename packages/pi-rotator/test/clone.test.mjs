import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  aliasDef,
  builtinBase,
  findPiAiRoot,
  loadBuiltinModule,
  registerAlias,
} from "../lib/clone.js";

function fakeBase() {
  return {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { oauth: { login: () => {}, refresh: () => {} } },
    getModels: () => [{ id: "gpt-5.5" }],
    stream: () => {},
  };
}

function fakeModule() {
  // Like the real registry: fresh instances on every call.
  return {
    builtinProviders: () => [
      fakeBase(),
      { ...fakeBase(), id: "anthropic", name: "Anthropic" },
    ],
  };
}

describe("clone", () => {
  it("aliasDef re-identifies without touching behavior", () => {
    const base = fakeBase();
    const alias = aliasDef(base, "openai-codex-account-2", 2);

    assert.equal(alias.id, "openai-codex-account-2");
    assert.equal(alias.name, "ChatGPT Plus/Pro (account 2)");
    assert.equal(alias.baseUrl, base.baseUrl);
    assert.equal(alias.auth, base.auth);
    assert.equal(alias.getModels, base.getModels);
    assert.equal(alias.stream, base.stream);
    // Copy, not mutation: the base def must survive aliasing intact.
    assert.notEqual(alias, base);
    assert.equal(base.id, "openai-codex");
    assert.equal(base.name, "ChatGPT Plus/Pro");
  });

  it("builtinBase picks the family and misses unknown ids", () => {
    const mod = fakeModule();

    assert.equal(builtinBase(mod, "anthropic").id, "anthropic");
    assert.equal(builtinBase(mod, "cursor"), null);
    assert.equal(builtinBase(null, "anthropic"), null);
    assert.equal(builtinBase({}, "anthropic"), null);
  });

  it("builtinBase returns fresh instances per call", () => {
    const mod = fakeModule();

    assert.notEqual(builtinBase(mod, "anthropic"), builtinBase(mod, "anthropic"));
  });

  it("registerAlias passes a full Provider object to the host", () => {
    const calls = [];

    const pi = {
      registerProvider: function (...args) {
        calls.push(args);
      },
    };

    assert.equal(registerAlias(pi, fakeBase(), "openai-codex-account-3", 3), "alias");
    assert.equal(calls.length, 1);
    // Single-argument call selects the registerProvider(provider) overload —
    // two arguments would take the (name, config) path and drop the clone.
    assert.equal(calls[0].length, 2);
    assert.equal(calls[0][0], "openai-codex-account-3");
    assert.equal(calls[0][1].id, "openai-codex-account-3");
    assert.deepEqual(calls[0][1].getModels(), [{ id: "gpt-5.5" }]);
    assert.doesNotThrow(() => calls[0][1].stream());
  });

  it("loadBuiltinModule falls back to the filesystem walk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-clone-"));
    const providersDir = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers");

    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, "all.js"),
      "module.exports.builtinProviders = () => [{ id: 'fake-walk-family', name: 'x' }];\n",
    );
    // A bare specifier cannot resolve from the temp dir, so the walk runs.
    // Fake-only id: the real pi-ai registry must NOT satisfy this test.
    const entry = join(dir, "entry.mjs");

    writeFileSync(entry, "export {};\n");

    const { module: mod, error } = loadBuiltinModule(pathToFileURL(entry).href, dir);

    assert.equal(error, null);
    assert.equal(builtinBase(mod, "fake-walk-family").id, "fake-walk-family");
  });

  it("loadBuiltinModule reports a clean error when pi-ai is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-nopia-"));
    const savedAgentDir = process.env.PI_AGENT_DIR;

    // Point the agent-dir fallback at the same empty tree so the real
    // ~/.pi install cannot rescue the lookup on a dev machine.
    process.env.PI_AGENT_DIR = dir;

    try {
      assert.equal(findPiAiRoot(dir), null);
      const { module: mod, error } = loadBuiltinModule(pathToFileURL(join(dir, "entry.mjs")).href, dir);

      assert.equal(mod, null);
      assert.match(error, /pi-ai/);
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = savedAgentDir;
    }
  });

  it("the real pi-ai registry returns fresh defs per call", () => {
    // The fake above assumes freshness; this pins the assumption against
    // the installed pi-ai — or pins the clean-error contract where absent.
    // No skip: both branches assert real behavior.
    const { module: mod, error } = loadBuiltinModule(
      import.meta.url,
      dirname(fileURLToPath(import.meta.url)),
    );

    if (!mod) {
      assert.match(error, /pi-ai/);

      return;
    }

    const a = builtinBase(mod, "openai-codex");
    const b = builtinBase(mod, "openai-codex");

    assert.notEqual(a, b);
    assert.notEqual(a.auth, b.auth);
  });

  it("loadBuiltinModule falls back to the agent npm tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-agentdir-"));
    const providersDir = join(dir, "npm", "node_modules", "@earendil-works", "pi-ai", "dist", "providers");

    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, "all.js"),
      "module.exports.builtinProviders = () => [{ id: 'fake-agent-family', name: 'x' }];\n",
    );
    const savedAgentDir = process.env.PI_AGENT_DIR;

    process.env.PI_AGENT_DIR = dir;

    try {
      const entryDir = mkdtempSync(join(tmpdir(), "pi-rotator-checkout-"));

      const { module: mod, error } = loadBuiltinModule(
        pathToFileURL(join(entryDir, "entry.mjs")).href,
        entryDir,
      );

      assert.equal(error, null);
      assert.equal(builtinBase(mod, "fake-agent-family").id, "fake-agent-family");
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = savedAgentDir;
    }
  });
});
