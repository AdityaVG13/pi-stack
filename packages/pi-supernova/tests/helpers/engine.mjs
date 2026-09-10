import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerCodeMode } from "../../index.js";
import { packageDefaults } from "../../src/config/config.js";

// node --test isolates each test file in its own process. Never consult the
// developer's live agent configuration when exercising the shipping defaults.
process.env.PI_SUPERNOVA_CONFIG = fileURLToPath(new URL("../../src/config/config.default.json", import.meta.url));

export const limits = { ...packageDefaults(), timeoutMs: 2000 };

export function registrationHost() {
  const tools = new Map();
  const handlers = new Map();

  const pi = {
    registerTool: tool => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    registerCommand() {},
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };

  // Reproduce the host's own handoffs. `context` carries the exact messages about to
  // be sent, so anything that reasons about model-context residency needs it: a
  // harness that never emits it measures a host that does not exist in production.
  const emit = (name, event) => Promise.all((handlers.get(name) ?? []).map(handler => handler(event, {})));

  // Minimal registration metadata, not simulated Pi/OMP execution.
  // Actual-host parity is verified separately by tests/hosts.
  const host = Object.fromEntries(["read", "edit", "write", "bash"].map(name => [
    `create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`,
    () => ({ name, description: name, parameters: { type: "object", properties: {} } }),
  ]));

  return { pi, host, tools, handlers, emit };
}

export async function engineFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-red-"));
  t.diagnostic(`Fixture retained at ${root}`);
  const { pi, tools } = registrationHost();
  // Exercise the registered tool, real worker, and filesystem, not a fake executor.
  registerCodeMode(pi);
  const tool = tools.get("supernova");

  if (!tool) throw new Error("CodeMode test seam disappeared; do not replace it with a fake executor");
  const execute = code => tool.execute("red-contract", { code, timeoutMs: 2000 }, undefined, undefined, { cwd: root });

  return { root, pi, tool, execute, write: (file, text) => fs.writeFile(path.join(root, file), text) };
}

export function modelText(result) {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

// Explicit research configuration, never an implicit shipping default. Registration
// reads synchronously, so the environment override cannot leak across async calls.
export function registerExperimentalLedger(pi) {
  const previous = process.env.PI_SUPERNOVA_CONFIG;
  process.env.PI_SUPERNOVA_CONFIG = fileURLToPath(new URL("./ledger-opt-in.json", import.meta.url));

  try { registerCodeMode(pi); } finally {
    if (previous === undefined) delete process.env.PI_SUPERNOVA_CONFIG;
    else process.env.PI_SUPERNOVA_CONFIG = previous;
  }
}
