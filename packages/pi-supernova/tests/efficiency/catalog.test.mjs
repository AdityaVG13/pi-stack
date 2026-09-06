import { it } from "node:test";
import assert from "node:assert/strict";
import extension from "../../index.js";
import { registrationHost } from "../helpers/engine.mjs";

it("a four-command program does not serialize an unrelated tool's schema", async () => {
  const { pi, tools } = registrationHost();
  extension(pi);
  let schemaReads = 0;
  pi.registerTool({
    name: "unused_external",
    description: "Not part of the four-command surface",
    parameters: {
      type: "object",
      get properties() { schemaReads++; return { unused: { type: "string" } }; },
      toJsonSchema() { schemaReads++; return { type: "object", properties: { unused: { type: "string" } } }; },
    },
    execute() { throw new Error("Unrelated executor must never run"); },
  });
  const result = await tools.get("supernova").execute("catalog", { code: "return 7;" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.result, 7);
  assert.equal(schemaReads, 0, "Refreshing permissions must not build a catalogue of unrelated schemas");
});
