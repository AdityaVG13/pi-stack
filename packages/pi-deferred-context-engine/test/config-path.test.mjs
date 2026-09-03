import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  detectAgentConfigKind,
  inferKindFromInstallPath,
  standardConfigPaths,
} from "../config.js";

describe("inferKindFromInstallPath", () => {
  it("detects npm install under ~/.pi/agent/npm", () => {
    assert.equal(
      inferKindFromInstallPath("/home/user/.pi/agent/npm/node_modules/pi-deferred-context-engine"),
      "pi",
    );
  });

  it("detects install under ~/.omp", () => {
    assert.equal(
      inferKindFromInstallPath("/home/user/.omp/plugins/node_modules/pi-deferred-context-engine"),
      "omp",
    );
  });

  it("returns unknown for path installs outside agent homes", () => {
    assert.equal(
      inferKindFromInstallPath("/home/user/Developer/pi-stack/packages/pi-deferred-context-engine"),
      "unknown",
    );
  });

  it("does not treat 'pi' inside a package name as an agent home", () => {
    assert.equal(
      inferKindFromInstallPath("/home/user/code/my-pi-tools/packages/pi-deferred-context-engine"),
      "unknown",
    );
  });
});

describe("detectAgentConfigKind", () => {
  it("classifies exact binary basenames only", () => {
    assert.equal(detectAgentConfigKind(["node", "/usr/local/bin/pi"], "/usr/local/bin/pi"), "pi");
    assert.equal(detectAgentConfigKind(["omp"], "/usr/bin/omp"), "omp");
    assert.equal(detectAgentConfigKind(["zmp"], "/usr/bin/zmp"), "omp");
  });

  it("returns unknown for unrelated argv (no repo-name heuristics)", () => {
    assert.equal(
      detectAgentConfigKind(["node", "/Users/x/Developer/zero-my-pi/dist/cli.js"], "/bin/node"),
      "unknown",
    );
  });
});

describe("standardConfigPaths", () => {
  it("is user-agnostic under an arbitrary home", () => {
    const paths = standardConfigPaths("/tmp/someone");
    assert.equal(paths.pi, "/tmp/someone/.pi/agent/deferred-tools.json");
    assert.equal(paths.omp, "/tmp/someone/.omp/agent/deferred-tools.json");
  });
});

describe("userConfigPath env override", () => {
  const prevPi = process.env.PI_DEFERRED_TOOLS_CONFIG;
  const prevOmp = process.env.OMP_DEFERRED_TOOLS_CONFIG;
  const prevDir = process.env.PI_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    delete process.env.OMP_DEFERRED_TOOLS_CONFIG;
    delete process.env.PI_CONFIG_DIR;
  });

  afterEach(() => {
    if (prevPi === undefined) delete process.env.PI_DEFERRED_TOOLS_CONFIG;
    else process.env.PI_DEFERRED_TOOLS_CONFIG = prevPi;
    if (prevOmp === undefined) delete process.env.OMP_DEFERRED_TOOLS_CONFIG;
    else process.env.OMP_DEFERRED_TOOLS_CONFIG = prevOmp;
    if (prevDir === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = prevDir;
  });

  it("honors PI_DEFERRED_TOOLS_CONFIG over heuristics", async () => {
    process.env.PI_DEFERRED_TOOLS_CONFIG = "/tmp/pi-deferred-test.json";
    const { userConfigPath } = await import("../config.js?" + Date.now());
    assert.equal(userConfigPath(), "/tmp/pi-deferred-test.json");
  });
});
