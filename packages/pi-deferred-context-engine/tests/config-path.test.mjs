import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  addAlwaysActive,
  loadConfig,
  userConfigPath,
  detectAgentConfigKind,
  inferKindFromInstallPath,
  standardConfigPaths,
} from "../lib/config.js";

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

  it("does not mistake user arguments for the running agent", () => {
    assert.equal(detectAgentConfigKind(["node", "/usr/local/bin/pi", "omp"], "/usr/bin/node"), "pi");
    assert.equal(detectAgentConfigKind(["node", "/usr/local/bin/omp", "pi"], "/usr/bin/node"), "omp");
    assert.equal(detectAgentConfigKind(["node", "/project/script.js", "/project/omp.ts"], "/usr/bin/node"), "unknown");
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
  const keys = ["PI_DEFERRED_TOOLS_CONFIG", "OMP_DEFERRED_TOOLS_CONFIG", "PI_CONFIG_DIR", "OMP_CONFIG_DIR", "PI_CODING_AGENT_DIR"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("custom config roots remain authoritative before and after first pin", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-roots-"));

    for (const key of ["PI_CONFIG_DIR", "OMP_CONFIG_DIR"]) {
      const root = path.join(directory, key);
      process.env[key] = root;
      const file = path.join(root, "agent", "deferred-tools.json");
      assert.equal(userConfigPath(), file, "an absent file must not redirect writes to the default profile");
      assert.deepEqual(addAlwaysActive(["weather"]), ["weather"]);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).alwaysActive, ["weather"]);
      assert.equal(userConfigPath(), file);
      assert.deepEqual(loadConfig().alwaysActive, ["weather"]);
      delete process.env[key];
    }

    // Existing flat layouts remain authoritative for their selected root.
    process.env.PI_CONFIG_DIR = directory;
    const flat = path.join(directory, "deferred-tools.json");
    fs.writeFileSync(flat, JSON.stringify({ alwaysActive: ["flat_pin"] }));
    assert.equal(userConfigPath(), flat);
    assert.deepEqual(addAlwaysActive(["new_pin"]), ["new_pin"]);
    assert.deepEqual(loadConfig().alwaysActive, ["flat_pin", "new_pin"]);
  });

  it("custom roots do not bypass dangling config symlinks during reload or pin saves", () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "dce-dangling-root-"));

    for (const key of ["PI_CONFIG_DIR", "OMP_CONFIG_DIR"]) {
      for (const layout of ["nested", "flat"]) {
        const root = path.join(directory, key, layout);
        const nested = path.join(root, "agent", "deferred-tools.json");
        const flat = path.join(root, "deferred-tools.json");
        fs.mkdirSync(path.dirname(nested), { recursive: true });
        const selected = layout === "nested" ? nested : flat;
        fs.symlinkSync(path.join(root, "missing.json"), selected);

        if (layout === "nested") fs.writeFileSync(flat, JSON.stringify({ blockedTools: [] }));
        process.env[key] = root;
        assert.throws(() => loadConfig(undefined, { strict: true }), /Invalid deferred-tools config/,
          "strict reload must not select a fallback that clears the deny-list");
        assert.throws(() => addAlwaysActive(["weather"]), /ENOENT/,
          "a save must not bypass the broken configured location");
        assert.equal(userConfigPath(), selected);
        assert.ok(fs.lstatSync(selected).isSymbolicLink());

        if (layout === "nested") assert.deepEqual(JSON.parse(fs.readFileSync(flat, "utf8")), { blockedTools: [] });
        else assert.equal(fs.existsSync(nested), false, "no competing config is created");
        delete process.env[key];
      }
    }
  });

  it("uses Pi's native agent directory without adding a second agent segment", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-native-root-"));
    const file = path.join(directory, "deferred-tools.json");
    process.env.PI_CODING_AGENT_DIR = directory;
    assert.equal(userConfigPath(), file);
    assert.deepEqual(addAlwaysActive(["native_pin"]), ["native_pin"]);
    assert.deepEqual(loadConfig().alwaysActive, ["native_pin"]);
    process.env.PI_CODING_AGENT_DIR = pathToFileURL(directory).href;
    assert.equal(userConfigPath(), file);
    process.env.PI_CODING_AGENT_DIR = "~";
    assert.equal(userConfigPath(), path.join(os.homedir(), "deferred-tools.json"));
    process.env.PI_CODING_AGENT_DIR = "~/dce-profile";
    assert.equal(userConfigPath(), path.join(os.homedir(), "dce-profile", "deferred-tools.json"));
    process.env.PI_DEFERRED_TOOLS_CONFIG = file;
    assert.equal(userConfigPath(), file, "the package-specific override still wins");
  });

  it("honors PI_DEFERRED_TOOLS_CONFIG over heuristics", async () => {
    process.env.PI_DEFERRED_TOOLS_CONFIG = "/tmp/pi-deferred-test.json";
    const { userConfigPath } = await import("../lib/config.js?" + Date.now());
    assert.equal(userConfigPath(), "/tmp/pi-deferred-test.json");
  });
});
