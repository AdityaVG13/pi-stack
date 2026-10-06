import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { familyCarrier } from "../lib/accounts.js";

describe("accounts", () => {
  it("familyCarrier prefers live configured credentials, then auth keys, then slots[0]", () => {
    const slots = ["demo", "demo-account-2", "demo-account-3"];
    const registry = { getProvider: () => ({ id: "fixture" }), getProviderAuthStatus: id => ({ configured: id === "demo-account-3" }) };

    assert.equal(familyCarrier(slots, { demo: {}, "demo-account-2": {}, "demo-account-3": {} }, registry), "demo-account-3");
    assert.equal(familyCarrier(slots, { demo: {}, "demo-account-2": {}, "demo-account-3": {} }, undefined), "demo");

    assert.equal(familyCarrier(["demo-account-2", "demo-account-3"], { "demo-account-3": {} }, undefined), "demo-account-3");
  });

  it("familyCarrier treats a throwing snapshot as unconfigured, never fatal", () => {
    const slots = ["demo", "demo-account-2"];

    const registry = {
      getProvider: () => ({ id: "fixture" }),
      getProviderAuthStatus: id => {
        if (id === "demo") throw new Error("snapshot down");

        return { configured: id === "demo-account-2" };
      },
    };

    assert.equal(familyCarrier(slots, { demo: {}, "demo-account-2": {} }, registry), "demo-account-2");
  });
});
