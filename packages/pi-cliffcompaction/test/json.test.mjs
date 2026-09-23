import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, dumpsCount, dumpsDefault, dumpsLen } from "../lib/json.ts";
import { aBody, aSession } from "./util.mjs";

describe("dumpsCount matches dumpsDefault length", () => {
  const cases = [
    null,
    true,
    false,
    0,
    1,
    1.5,
    "",
    "hello",
    "quote \" and \\ slash",
    [],
    [1],
    [1, 2, 3],
    {},
    { a: 1 },
    { b: 2, a: 1 },
    { nested: { x: [1, "two", null] } },
  ];

  for (const value of cases) {
    it("length of " + JSON.stringify(value), () => {
      assert.equal(dumpsCount(value), dumpsDefault(value).length);
      assert.equal(dumpsLen(value), dumpsDefault(value).length);
    });
  }

  it("matches on a realistic agent body", () => {
    const body = aBody(aSession(10, 3000));

    assert.equal(dumpsCount(body), dumpsDefault(body).length);
    assert.equal(dumpsLen(body),  dumpsDefault(body).length);
  });
});

describe("canonicalJson is compact sorted JSON", () => {
  it("sorts keys and omits spaces", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("matches dumpsDefault on primitives", () => {
    assert.equal(canonicalJson("x"), dumpsDefault("x"));
    assert.equal(canonicalJson(null), "null");
  });
});
