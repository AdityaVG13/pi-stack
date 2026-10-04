import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addAlwaysActive,
  blockedToolsCautionWarnings,
  emptyPinReplaceWarnings,
  hasBlockedConfig,
  isBlocked,
  loadConfig,
  mergeConfig,
  packageDefaults,
  removeBlockedTools,
  shouldDefer,
  stripBlockedConflicts,
  stripDeferredProtectedConflicts,
} from "../lib/config.js";

test("merges user lists without losing protected defaults", () => {
  // DCE-D9: mergeConfig requires package defaults for numeric/bool keys (JSON sole source)
  const base = packageDefaults();

  const merged = mergeConfig(
    { ...base, alwaysActive: ["read"], neverDefer: [], deferredNames: [], deferredPrefixes: [] },
    { alwaysActive: ["custom_spine"], deferredPrefixes: ["mcp_"], deferByDefault: false },
  );

  assert.deepEqual(merged.alwaysActive, ["read", "custom_spine"]);
  assert.equal(merged.deferByDefault, false);
  assert.equal(shouldDefer("mcp_github_issue", merged), true);
  assert.equal(shouldDefer("custom_spine", merged), false);
});

test("falls back safely on malformed startup config and reports strict reloads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-config-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, "{not json", "utf8");
  assert.equal(loadConfig(configPath).enabled, true);
  assert.throws(() => loadConfig(configPath, { strict: true }), /Invalid deferred-tools config/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("ships portable defaults (empty pins) and supports complete spine replacement", () => {
  const defaults = loadConfig(path.join(os.tmpdir(), `pi-deferred-missing-${process.pid}-${Date.now()}.json`));
  // Package defaults must not bake dogfood tools -- only empty pin lists + code spine.
  assert.deepEqual(defaults.alwaysActive, []);
  assert.deepEqual(defaults.neverDefer, []);
  assert.deepEqual(defaults.blockedTools, []);
  assert.equal(shouldDefer("read", defaults), true);
  assert.equal(shouldDefer("search_tools", defaults), false);

  const replaced = mergeConfig(defaults, {
    replaceAlwaysActive: true,
    replaceNeverDefer: true,
    alwaysActive: ["critical_tool"],
    neverDefer: ["critical_tool"],
    promotionLifetime: "session",
  });

  assert.deepEqual(replaced.alwaysActive, ["critical_tool"]);
  assert.deepEqual(replaced.neverDefer, ["critical_tool"]);
  assert.equal(replaced.promotionLifetime, "session");
  assert.equal(shouldDefer("read", replaced), true);
});

test("shouldDefer uses neverDefer only (alwaysActive is pin, not auto-defer dual)", () => {
  const alwaysOnly = {
    enabled: true,
    deferByDefault: true,
    alwaysActive: ["pinned"],
    neverDefer: [],
    deferredNames: [],
    deferredPrefixes: [],
  };

  // alwaysActive alone does not block shouldDefer -- synchronize pin handles force-active
  assert.equal(shouldDefer("pinned", alwaysOnly), true);
  assert.equal(shouldDefer("other", alwaysOnly), true);

  const neverOnly = {
    enabled: true,
    deferByDefault: true,
    alwaysActive: [],
    neverDefer: ["guarded"],
    deferredNames: [],
    deferredPrefixes: [],
  };

  assert.equal(shouldDefer("guarded", neverOnly), false);
  assert.equal(shouldDefer("other", neverOnly), true);
});

test("emptyPinReplaceWarnings soft-warns empty replace lists", () => {
  assert.deepEqual(emptyPinReplaceWarnings({ replaceAlwaysActive: false, alwaysActive: [], replaceNeverDefer: false, neverDefer: [] }), []);

  const both = emptyPinReplaceWarnings({
    replaceAlwaysActive: true,
    alwaysActive: [],
    replaceNeverDefer: true,
    neverDefer: [],
  });

  assert.equal(both.length, 2);
  assert.match(both[0], /replaceAlwaysActive/);
  assert.match(both[1], /replaceNeverDefer/);
  assert.deepEqual(
    emptyPinReplaceWarnings({ replaceAlwaysActive: true, alwaysActive: ["read"], replaceNeverDefer: true, neverDefer: ["read"] }),
    [],
  );
});

test("DCE-O6: deferredNames ∩ pin/guard stripped at merge (protected wins)", () => {
  const base = packageDefaults();

  // Defaults no longer pin read/bash -- supply pins in the overlay to exercise the strip.
  const merged = mergeConfig(base, {
    alwaysActive: ["read", "bash"],
    neverDefer: ["read", "bash"],
    deferredNames: ["read", "weather_lookup", "bash"],
  });

  assert.ok(!merged.deferredNames.includes("read"));
  assert.ok(!merged.deferredNames.includes("bash"));
  assert.ok(merged.deferredNames.includes("weather_lookup"));
  // Closed Config keys only -- warnings stay on stripDeferredProtectedConflicts
  assert.equal(Object.prototype.hasOwnProperty.call(merged, "configWarnings"), false);

  const unit = stripDeferredProtectedConflicts(["pin_a"], ["guard_b"], ["pin_a", "guard_b", "free"]);
  assert.deepEqual(unit.deferredNames, ["free"]);
  assert.equal(unit.warnings.length, 2);
  assert.match(unit.warnings[0], /deferredNames contains protected/);
});

test("DCE-D9: packageDefaults is sole source for maxSearchResults/maxSkillBytes", () => {
  const d = packageDefaults();
  assert.equal(d.maxSearchResults, 3);
  assert.equal(d.maxSkillBytes, 65536);
  assert.equal(d.promotionLifetime, "run");
  // no dual JS fallback: incomplete defaults throw (promotionLifetime or required ints)
  assert.throws(
    () => mergeConfig({ alwaysActive: [], neverDefer: [], deferredNames: [] }, {}),
    /promotionLifetime|maxSearchResults|positive integer|config\.default\.json/,
  );
});

test("joint: deferredNames stripped when only in pin OR only in guard", () => {
  // pin-only
  const pinOnly = stripDeferredProtectedConflicts(["pinned"], [], ["pinned", "free"]);
  assert.deepEqual(pinOnly.deferredNames, ["free"]);
  assert.equal(pinOnly.warnings.length, 1);
  // guard-only
  const guardOnly = stripDeferredProtectedConflicts([], ["guarded"], ["guarded", "free"]);
  assert.deepEqual(guardOnly.deferredNames, ["free"]);
  assert.equal(guardOnly.warnings.length, 1);
  // neither → kept
  const free = stripDeferredProtectedConflicts(["a"], ["b"], ["c"]);
  assert.deepEqual(free.deferredNames, ["c"]);
  assert.equal(free.warnings.length, 0);
});

test("joint: empty replace soft-warn only when that side is empty", () => {
  const pinEmpty = emptyPinReplaceWarnings({
    replaceAlwaysActive: true,
    alwaysActive: [],
    replaceNeverDefer: true,
    neverDefer: ["read"],
  });

  assert.equal(pinEmpty.length, 1);
  assert.match(pinEmpty[0], /replaceAlwaysActive/);

  const guardEmpty = emptyPinReplaceWarnings({
    replaceAlwaysActive: true,
    alwaysActive: ["read"],
    replaceNeverDefer: true,
    neverDefer: [],
  });

  assert.equal(guardEmpty.length, 1);
  assert.match(guardEmpty[0], /replaceNeverDefer/);
  // replace flags false → no warn even if lists empty
  assert.deepEqual(
    emptyPinReplaceWarnings({ replaceAlwaysActive: false, alwaysActive: [], replaceNeverDefer: false, neverDefer: [] }),
    [],
  );
});

test("addAlwaysActive appends new pins, mirrors neverDefer, and skips existing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-keep-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    alwaysActive: ["existing_tool"],
    neverDefer: ["existing_tool"],
  }), "utf8");

  const added = addAlwaysActive(["subagent_wait", "existing_tool", "subagent_wait"], configPath);
  assert.deepEqual(added, ["subagent_wait"]);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(raw.alwaysActive, ["existing_tool", "subagent_wait"]);
  assert.deepEqual(raw.neverDefer, ["existing_tool", "subagent_wait"]);

  // No-op when everything is already pinned.
  assert.deepEqual(addAlwaysActive(["subagent_wait"], configPath), []);
});

test("addAlwaysActive creates a missing config file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-keep-"));
  const configPath = path.join(directory, "nested", "config.json");
  const added = addAlwaysActive(["zero"], configPath);
  assert.deepEqual(added, ["zero"]);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(raw.alwaysActive, ["zero"]);
  assert.equal(raw.neverDefer, undefined);
});

test("blockedTools: spine stripped; block wins over pin/defer", () => {
  const base = packageDefaults();

  const merged = mergeConfig(base, {
    blockedTools: ["search_tools", "grep", "weather"],
    alwaysActive: ["grep", "asgrep"],
    deferredNames: ["weather", "free_tool"],
  });

  assert.ok(!merged.blockedTools.includes("search_tools"));
  assert.ok(merged.blockedTools.includes("grep"));
  assert.ok(merged.blockedTools.includes("weather"));
  assert.ok(!merged.alwaysActive.includes("grep"));
  assert.ok(merged.alwaysActive.includes("asgrep"));
  assert.ok(!merged.deferredNames.includes("weather"));
  assert.ok(merged.deferredNames.includes("free_tool"));

  const unit = stripBlockedConflicts(
    ["search_tools", "grep"],
    ["grep", "read"],
    ["grep"],
    ["grep", "other"],
  );

  assert.deepEqual(unit.blockedTools, ["grep"]);
  assert.deepEqual(unit.alwaysActive, ["read"]);
  assert.deepEqual(unit.neverDefer, []);
  assert.deepEqual(unit.deferredNames, ["other"]);
  assert.ok(unit.warnings.some((w) => /spine/.test(w)));
});

test("isBlocked: names, prefixes, spine immune, sessionUnblocked, enabled gate", () => {
  const cfg = {
    enabled: true,
    blockedTools: ["grep"],
    blockedPrefixes: ["mcp_bad_"],
  };

  assert.equal(isBlocked("grep", cfg), true);
  assert.equal(isBlocked("mcp_bad_x", cfg), true);
  assert.equal(isBlocked("search_tools", { ...cfg, blockedTools: ["search_tools", "grep"] }), false);
  assert.equal(isBlocked("grep", cfg, { sessionUnblocked: ["grep"] }), false);
  assert.equal(isBlocked("grep", { ...cfg, enabled: false }), false);
  assert.equal(hasBlockedConfig(cfg), true);
  assert.equal(hasBlockedConfig({ blockedTools: [], blockedPrefixes: [] }), false);
  const caution = blockedToolsCautionWarnings(cfg);
  assert.equal(caution.length, 1);
  assert.match(caution[0], /CAUTION/);
  assert.match(caution[0], /\/deferred blocked/);
});

test("removeBlockedTools persists removals atomically", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deferred-block-"));
  const configPath = path.join(directory, "deferred-tools.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ blockedTools: ["grep", "glob", "ast_grep"] }, null, 2),
    "utf8",
  );
  const result = removeBlockedTools(["grep", "missing"], configPath);
  assert.deepEqual(result.removed, ["grep"]);
  assert.deepEqual(result.missing, ["missing"]);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(raw.blockedTools, ["glob", "ast_grep"]);
  fs.rmSync(directory, { recursive: true, force: true });
});


test("pin and unblock edits preserve a symlinked config and update its target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-link-"));
  const target = path.join(directory, "dotfiles.json");
  const alias = path.join(directory, "deferred-tools.json");
  fs.writeFileSync(target, JSON.stringify({ alwaysActive: ["old_pin"], blockedTools: ["blocked", "keep_blocked"] }));
  fs.symlinkSync("dotfiles.json", alias);
  assert.deepEqual(addAlwaysActive(["new_pin"], alias), ["new_pin"]);
  assert.ok(fs.lstatSync(alias).isSymbolicLink(), "pinning must not replace a user-managed symlink");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).alwaysActive, ["old_pin", "new_pin"]);
  assert.deepEqual(removeBlockedTools(["blocked"], alias), { removed: ["blocked"], missing: [] });
  assert.ok(fs.lstatSync(alias).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).blockedTools, ["keep_blocked"]);
  const dangling = path.join(directory, "dangling.json");
  fs.symlinkSync("absent.json", dangling);
  assert.throws(() => addAlwaysActive(["pin"], dangling), { code: "ENOENT" });
  assert.ok(fs.lstatSync(dangling).isSymbolicLink(), "an invalid target must not detach the link");
});

test("config permissions survive pin and unblock replacement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-mode-"));
  const file = path.join(directory, "deferred-tools.json");
  fs.writeFileSync(file, JSON.stringify({ blockedTools: ["blocked"] }), { mode: 0o600 });
  const previousMask = process.umask(0o022);

  try {
    addAlwaysActive(["private_pin"], file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "pinning must not make a private config world-readable");
    removeBlockedTools(["blocked"], file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { blockedTools: [], alwaysActive: ["private_pin"] });
    fs.chmodSync(file, 0o640);
    process.umask(0o077);
    addAlwaysActive(["shared_pin"], file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, "a tighter umask must not silently remove existing group access");
    process.umask(0o022);
    const fresh = path.join(directory, "fresh.json");
    addAlwaysActive(["first_pin"], fresh);
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600, "new config files are private");
  } finally { process.umask(previousMask); }
});


test("config special-file reads reject FIFOs without blocking", { skip: process.platform === "win32" }, async t => {
  const { spawnSync } = await import("node:child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-special-"));
  const fifo = path.join(directory, "config.fifo");
  const home = path.join(directory, "home"), piRoot = path.join(home, ".pi", "agent"), ompRoot = path.join(home, ".omp", "agent");
  fs.mkdirSync(piRoot, { recursive: true });
  fs.mkdirSync(ompRoot, { recursive: true });
  assert.equal(spawnSync("mkfifo", [fifo, path.join(piRoot, "settings.json")]).status, 0);
  fs.writeFileSync(path.join(ompRoot, "settings.json"), JSON.stringify({ packages: ["pi-deferred-context-engine"] }));
  const source = new URL("../lib/config.js", import.meta.url).href;
  const env = { ...process.env, HOME: home };

  for (const name of ["PI_DEFERRED_TOOLS_CONFIG", "OMP_DEFERRED_TOOLS_CONFIG", "PI_CONFIG_DIR", "OMP_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) delete env[name];

  const checks = [
    ["load", `assert.throws(() => loadConfig(file, { strict: true }), /regular file/); assert.deepEqual(loadConfig(file), packageDefaults());`],
    ["pin", `assert.throws(() => addAlwaysActive(["keep"], file), /regular file/);`],
    ["unblock", `assert.throws(() => removeBlockedTools(["blocked"], file), /regular file/);`],
    ["discovery", `assert.equal(userConfigPath(), ${JSON.stringify(path.join(ompRoot, "deferred-tools.json"))});`],
  ];

  for (const [name, check] of checks) {
    await t.test(name, () => {
      const script = `import assert from "node:assert/strict"; import { loadConfig, packageDefaults, addAlwaysActive, removeBlockedTools, userConfigPath } from ${JSON.stringify(source)}; const file = ${JSON.stringify(fifo)}; process.argv = [process.execPath, "probe"]; ${check}`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 3000, killSignal: "SIGKILL", encoding: "utf8" });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      assert.equal(fs.lstatSync(fifo).isFIFO(), true);
    });
  }
});


test("persistent config writers reject overlapping pin/unblock saves and permit retry", async t => {
  const { spawnSync } = await import("node:child_process");
  const source = new URL("../lib/config-store.js", import.meta.url).href;

  for (const first of ["pin", "unblock"]) {
    await t.test(first, child => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-writers-"));
      const file = path.join(directory, "target.json"), alias = path.join(directory, "alias.json");
      fs.writeFileSync(file, JSON.stringify({ alwaysActive: ["old_pin"], blockedTools: ["blocked", "keep_blocked"] }));
      fs.symlinkSync("target.json", alias);
      const contender = first === "pin" ? "removeBlockedTools(['blocked'], file)" : "addAlwaysActive(['new_pin'], file)";
      const script = `import { addAlwaysActive, removeBlockedTools } from ${JSON.stringify(source)}; const file = ${JSON.stringify(file)}; try { console.log(JSON.stringify({ result: ${contender} })); } catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }`;
      const originalRead = fs.readFileSync;
      let competing;

      // A separate process writes after this writer reads, before it can replace.
      const read = child.mock.method(fs, "readFileSync", (target, ...args) => {
        const text = originalRead(target, ...args);

        if (!competing) {
          competing = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
        }

        return text;
      });

      if (first === "pin") assert.deepEqual(addAlwaysActive(["new_pin"], alias), ["new_pin"]);
      else assert.deepEqual(removeBlockedTools(["blocked"], alias), { removed: ["blocked"], missing: [] });

      read.mock.restore();
      assert.equal(competing.status, 0, competing.error?.message ?? competing.stderr);
      assert.equal(JSON.parse(competing.stdout).code, "busy", "must not acknowledge a write that the first writer can overwrite");

      if (first === "pin") assert.deepEqual(removeBlockedTools(["blocked"], file), { removed: ["blocked"], missing: [] });
      else assert.deepEqual(addAlwaysActive(["new_pin"], file), ["new_pin"]);

      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { alwaysActive: ["old_pin", "new_pin"], blockedTools: ["keep_blocked"] });
      assert.ok(fs.lstatSync(alias).isSymbolicLink());
    });
  }
});

test("persistent config locks retain other owners and release failed transactions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-locks-"));
  const file = path.join(directory, "held.json"), lock = file + ".lock", alias = path.join(directory, "lock-alias.json");
  const original = JSON.stringify({ blockedTools: ["blocked"] });
  const owner = JSON.stringify({ pid: process.pid, created: "2026-01-01T00:00:00.000Z" });
  fs.writeFileSync(file, original);
  fs.writeFileSync(lock, owner);
  fs.symlinkSync("held.json.lock", alias);

  for (const mutate of [addAlwaysActive, removeBlockedTools]) {
    assert.throws(() => mutate(["blocked"], file), { code: "busy" });
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.readFileSync(lock, "utf8"), owner, "never steal or remove someone else's lock");
    assert.throws(() => mutate(["blocked"], alias), { code: "usage" });
    assert.equal(fs.readFileSync(lock, "utf8"), owner, "lock aliases are not editable configs");
  }

  const broken = path.join(directory, "broken.json");
  fs.writeFileSync(broken, "not JSON");
  assert.throws(() => addAlwaysActive(["pin"], broken), SyntaxError);
  assert.equal(fs.readFileSync(broken, "utf8"), "not JSON");
  fs.writeFileSync(broken, original);
  assert.deepEqual(addAlwaysActive(["pin"], broken), ["pin"]);
  assert.deepEqual(removeBlockedTools(["blocked"], broken), { removed: ["blocked"], missing: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(broken, "utf8")), { blockedTools: [], alwaysActive: ["pin"] });
});


test("strict reload distinguishes a missing config from a dangling symlink", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-dangling-"));
  const target = path.join(directory, "target.json"), alias = path.join(directory, "config.json");
  fs.writeFileSync(target, JSON.stringify({ blockedTools: ["dangerous"] }));
  fs.symlinkSync("target.json", alias);
  assert.deepEqual(loadConfig(alias, { strict: true }).blockedTools, ["dangerous"]);
  fs.renameSync(target, target + ".held");
  assert.throws(() => loadConfig(alias, { strict: true }), /Invalid deferred-tools config/);
  assert.deepEqual(loadConfig(alias), packageDefaults(), "startup remains permissive");
  assert.deepEqual(loadConfig(path.join(directory, "absent.json"), { strict: true }), packageDefaults());
  assert.ok(fs.lstatSync(alias).isSymbolicLink());
});

test("persistent config rejects invalid fields before changing pins or blocks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dce-config-validation-"));
  const file = path.join(directory, "config.json");

  for (const mutate of [addAlwaysActive, removeBlockedTools]) {
    for (const invalid of [{ maxSearchResults: "many" }, { blockedTools: 42 }, { compactSchemas: { keepFul: ["dangerous"] } }]) {
      const raw = JSON.stringify({ alwaysActive: [], blockedTools: ["dangerous"], ...invalid });
      fs.writeFileSync(file, raw);
      assert.throws(() => mutate(["dangerous"], file), /config|compactSchemas|maxSearchResults|blockedTools/i);
      assert.equal(fs.readFileSync(file, "utf8"), raw, "a rejected save must leave the user's bytes untouched");
    }
  }

  fs.writeFileSync(file, JSON.stringify({ blockedTools: ["dangerous"] }));
  assert.deepEqual(addAlwaysActive(["weather"], file), ["weather"]);
  assert.deepEqual(removeBlockedTools(["dangerous"], file), { removed: ["dangerous"], missing: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { blockedTools: [], alwaysActive: ["weather"] });
});
