import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import piModelSync, { parseArgs, resolveModelsPath } from "../index.js";
import { tempDir } from "./helpers.mjs";

describe("command wiring", () => {
  test("parses args strictly", () => {
    assert.deepEqual(parseArgs(""), { dryRun: false, filter: undefined, help: false, refresh: false, error: undefined });
    assert.deepEqual(parseArgs("--dry-run anthropic").filter, "anthropic");
    assert.equal(parseArgs("--dry-run").dryRun, true);
    assert.equal(parseArgs("--refresh").refresh, true);
    assert.equal(parseArgs("--help").help, true);
    assert.deepEqual(parseArgs(["--dry-run", "anthropic"]), { dryRun: true, filter: "anthropic", help: false, refresh: false, error: undefined });
    assert.match(parseArgs("--bogus").error, /unknown flag/);
    assert.match(parseArgs("a b").error, /unexpected argument/);
    assert.equal(parseArgs("toString").filter, "toString");
  });

  test("resolves the models path from override, agent dir, or default", async () => {
    const previousModels = process.env.MODELSYNC_MODELS_PATH;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const custom = join(tempDir(), "custom.json");

    try {
      process.env.MODELSYNC_MODELS_PATH = custom;
      assert.equal(await resolveModelsPath(), custom);

      delete process.env.MODELSYNC_MODELS_PATH;
      process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "agent-dir");
      assert.equal(await resolveModelsPath(), join(tmpdir(), "agent-dir", "models.json"));

      process.env.PI_CODING_AGENT_DIR = "~/agent-x";
      assert.equal(await resolveModelsPath(), join(homedir(), "agent-x", "models.json"));
    } finally {
      if (previousModels === undefined) {
        delete process.env.MODELSYNC_MODELS_PATH;
      } else {
        process.env.MODELSYNC_MODELS_PATH = previousModels;
      }

      if (previousAgent === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgent;
      }
    }
  });

  test("registers model-sync and reports through the widget with notify fallback", async () => {
    let registered;
    piModelSync({ registerCommand: (name, options) => {
      registered = { name, options };
    } });

    assert.equal(registered.name, "model-sync");

    const widgets = [];
    const notices = [];

    const ctx = {
      modelRegistry: {
        getAll: () => [],
        getProvider: () => undefined,
        getProviderAuth: async () => undefined,
      },
      ui: {
        setWidget: (key, content) => {
          widgets.push([key, content]);
        },
        notify: (message) => {
          notices.push(message);
        },
      },
    };

    const text = await registered.options.handler("--dry-run", ctx);

    assert.match(text, /model-sync \(dry run\): 0 providers/);
    assert.equal(widgets[0][0], "pi-model-sync");
    assert.deepEqual(notices, []);

    const fallbackNotices = [];
    await registered.options.handler("--help", { ui: { notify: (m) => fallbackNotices.push(m) } });
    assert.match(fallbackNotices[0], /\/model-sync --dry-run/);
  });
});
