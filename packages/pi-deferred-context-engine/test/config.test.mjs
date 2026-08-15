import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addAlwaysActive, emptyPinReplaceWarnings, loadConfig, mergeConfig, packageDefaults, shouldDefer, stripDeferredProtectedConflicts } from "../config.js";

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

test("ships portable defaults and supports complete spine replacement", () => {
  const defaults = loadConfig(path.join(os.tmpdir(), `pi-deferred-missing-${process.pid}-${Date.now()}.json`));
  for (const name of ["read", "bash", "edit", "write"]) {
    assert.ok(defaults.alwaysActive.includes(name));
    assert.equal(shouldDefer(name, defaults), false);
  }
  assert.ok(!defaults.alwaysActive.includes("br_claim"));

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
  // alwaysActive alone does not block shouldDefer — synchronize pin handles force-active
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
  const merged = mergeConfig(base, {
    deferredNames: ["read", "weather_lookup", "bash"],
  });
  // read+bash are in package alwaysActive/neverDefer defaults
  assert.ok(!merged.deferredNames.includes("read"));
  assert.ok(!merged.deferredNames.includes("bash"));
  assert.ok(merged.deferredNames.includes("weather_lookup"));
  // Closed Config keys only — warnings stay on stripDeferredProtectedConflicts
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
