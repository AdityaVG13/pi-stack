import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, searchCatalog, describeTool, mergeNativeToolDefinitions } from "../catalog.js";

describe("catalog progressive discovery", () => {
  const tools = [
    {
      name: "read",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
        },
        required: ["path"],
      },
      sourceInfo: { path: "<builtin:read>", source: "builtin" },
    },
    {
      name: "grep",
      description: "Search file contents with ripgrep",
      parameters: { type: "object", properties: { pattern: { type: "string" } } },
      extensionPath: "/ext/grep.js",
    },
    {
      name: "supernova",
      description: "should be excluded",
      parameters: {},
    },
  ];

  it("builds catalog without assuming sourceInfo on every tool", () => {
    const catalog = buildCatalog(tools, ["supernova"]);
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].name, "grep");
    assert.equal(catalog[0].sourcePath, "/ext/grep.js");
    assert.equal(catalog[1].name, "read");
    assert.equal(catalog[1].sourcePath, "<builtin:read>");
  });

  it("search returns thin hits ranked by intent", () => {
    const catalog = buildCatalog(tools, ["supernova"]);
    const hits = searchCatalog(catalog, "read file", 5);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].name, "read");
    assert.ok(!("parameters" in hits[0]));
    assert.ok(hits[0].description.length <= 160);
  });

  it("describe returns schema summary only on demand", () => {
    const catalog = buildCatalog(tools, ["supernova"]);
    const desc = describeTool(catalog, "read");
    assert.equal(desc.ok, true);
    assert.equal(desc.parameters.fields.path.type, "string");
    assert.equal(desc.parameters.fields.path.required, true);
    const missing = describeTool(catalog, "nope");
    assert.equal(missing.ok, false);
  });

  it("makes uncaptured native adapters discoverable with their actual schemas", () => {
    const catalog = buildCatalog(mergeNativeToolDefinitions(tools), ["supernova"]);
    const read = describeTool(catalog, "read");
    const ls = describeTool(catalog, "ls");

    assert.equal(read.parameters.fields.path.type, "string");
    assert.match(read.description, /UTF-8 workspace files/);
    assert.equal(ls.ok, true);
    assert.equal(ls.parameters.fields.path.type, "string");

    const captured = buildCatalog(mergeNativeToolDefinitions(tools, ["read"]), ["supernova"]);
    assert.equal(describeTool(captured, "read").description, "Read a file from disk");
  });
});
