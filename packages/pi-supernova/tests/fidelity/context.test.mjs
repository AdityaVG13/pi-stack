import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture, modelText } from "../helpers/engine.mjs";

it("returning an image read preserves an image attachment, not UTF-8 decoded binary or a text placeholder", async t => {
  const fixture = await engineFixture(t);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await fixture.write("pixel.png", image);
  const result = await fixture.execute('return await read("pixel.png");');
  assert.equal(result.details.ok, true, result.details.error);
  const attachment = result.content.find(block => block.type === "image");
  assert.ok(attachment, "The model must receive an actual image content block through CodeMode");
  assert.equal(attachment.mimeType, "image/png");
  assert.deepEqual(Buffer.from(attachment.data, "base64"), image);
});

it("a repeated plain read remains self-contained when no retained-context acknowledgement exists", async t => {
  const fixture = await engineFixture(t);
  const body = Array.from({ length: 60 }, (_, i) => `important source line ${i}`).join("\n");
  await fixture.write("context.txt", body);
  const first = await fixture.execute('return await read("context.txt");');
  const second = await fixture.execute('return await read("context.txt");');
  assert.equal(first.details.ok, true, first.details.error);
  assert.equal(second.details.ok, true, second.details.error);
  assert.ok(modelText(first).includes(body), "First read must contain the requested source");
  assert.ok(modelText(second).includes(body), "A cache hit is not proof the model still has the earlier source in context");
});

it("a budget-limited file read gives an actionable line continuation rather than silently losing the middle", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("large.txt", Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: ${"payload ".repeat(20)}`).join("\n"));
  const result = await fixture.execute('return await read("large.txt");');
  assert.equal(result.details.ok, true, result.details.error);
  const text = modelText(result);
  assert.ok(/truncat|omitt|continu/i.test(text), "The response must explicitly disclose incomplete content");
  assert.ok(/offset\s*[:=]\s*\d+/i.test(text), "The agent needs an exact next line, not a vague 'read again' instruction");
});
