import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deferredCommandCompletions } from "../lib/commands.js";

const controller = { configuredBlockedNames: () => ["blocked_edit", "weather_lookup"] };

test("deferred completions offer subcommands, blocked names and --persist", () => {
  assert.deepEqual(deferredCommandCompletions("", controller), [
    { value: "status", label: "status" },
    { value: "audit", label: "audit" },
    { value: "apply", label: "apply" },
    { value: "reload", label: "reload" },
    { value: "config", label: "config" },
    { value: "blocked", label: "blocked" },
    { value: "unblock", label: "unblock" },
  ]);
  assert.deepEqual(deferredCommandCompletions("st", controller).map(row => row.value), ["status"]);
  assert.equal(deferredCommandCompletions("nope", controller), null);
  assert.deepEqual(deferredCommandCompletions("unblock ", controller).map(row => row.value), ["blocked_edit", "weather_lookup"]);
  assert.deepEqual(deferredCommandCompletions("unblock wea", controller).map(row => row.value), ["weather_lookup"]);
  assert.deepEqual(deferredCommandCompletions("unblock weather_lookup ", controller).map(row => row.value), ["blocked_edit", "--persist"]);
  assert.deepEqual(deferredCommandCompletions("unblock weather_lookup --p", controller).map(row => row.value), ["--persist"]);
  assert.equal(deferredCommandCompletions("status ", controller), null);
  assert.equal(deferredCommandCompletions("unblock zzz", controller), null);
  assert.deepEqual(deferredCommandCompletions("unblock --p", controller).map(row => row.value), ["--persist"]);
  assert.equal(deferredCommandCompletions("unblock --x", controller), null);
});

test("registered /deferred command exposes argument completions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-completions-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, blockedTools: ["blocked_edit"] }), "utf8");
  const previous = process.env.PI_DEFERRED_TOOLS_CONFIG;
  process.env.PI_DEFERRED_TOOLS_CONFIG = configPath;

  try {
    const { default: extension } = await import(`../index.js?completions=${Date.now()}`);
    const commands = new Map();
    const tools = [{ name: "blocked_edit", description: "Blocked editor", parameters: {} }];
    extension({
      getAllTools: () => tools,
      getActiveTools: () => [],
      setActiveTools: () => {},
      registerTool: tool => tools.push(tool),
      registerCommand: (name, command) => commands.set(name, command),
      on: () => {},
    });

    const command = commands.get("deferred");
    assert.equal(typeof command.getArgumentCompletions, "function");
    assert.deepEqual(command.getArgumentCompletions("unblock ").map(row => row.value), ["blocked_edit"]);
  } finally {
    if (previous === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
