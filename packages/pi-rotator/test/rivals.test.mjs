import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findRivals, findTransport, packageNameOf } from "../lib/rivals.js";

describe("rivals", () => {
  it("reads npm, path, and git sources by package name", () => {
    assert.equal(packageNameOf("npm:pi-multi-account"), "pi-multi-account");
    assert.equal(packageNameOf("npm:@hu3rror/pi-failover"), "@hu3rror/pi-failover");
    assert.equal(packageNameOf("packages/pi-supernova"), "pi-supernova");
    assert.equal(
      packageNameOf("../../Developer/pi-stack/packages/pi-rotator"),
      "pi-rotator",
    );
    assert.equal(packageNameOf("git:github.com/u/pi-failover"), "pi-failover");
    assert.equal(packageNameOf(""), "");
    assert.equal(packageNameOf(null), "");
    assert.equal(packageNameOf(undefined), "");
  });

  it("flags known balancers and dedupes", () => {
    assert.deepEqual(
      findRivals([
        "packages/pi-supernova",
        "npm:pi-failover",
        "npm:@henryqw/pi-multi-codex",
        "npm:pi-failover",
      ]),
      ["pi-failover", "@henryqw/pi-multi-codex"],
    );
  });

  it("treats multi-account as transport, not a rival", () => {
    assert.deepEqual(findRivals(["npm:pi-multi-account"]), []);
    assert.equal(findTransport(["npm:pi-multi-account"]), true);
    assert.equal(findTransport(["npm:@jischeng/pi-multi-account"]), true);
    assert.equal(findTransport(["npm:pi-failover"]), false);
    assert.equal(findTransport(null), false);
  });

  it("ignores itself and everything else", () => {
    assert.deepEqual(findRivals(["../../x/packages/pi-rotator", "npm:pi-web-access"]), []);
    assert.deepEqual(findRivals(null), []);
  });

  it("survives junk sources from hand-edited settings", () => {
    assert.equal(packageNameOf(42), "");
    assert.equal(packageNameOf({}), "");
    assert.equal(packageNameOf(true), "");
    assert.deepEqual(
      findRivals([42, null, {}, ["npm:pi-failover"], "npm:pi-failover"]),
      ["pi-failover"],
    );
    assert.equal(findTransport([42, null]), false);
  });
});
