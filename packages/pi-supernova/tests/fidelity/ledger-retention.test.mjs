import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerCodeMode } from "../../index.js";
import { SeenLedger } from "../../src/context/ledger.js";
import { registerExperimentalLedger } from "../helpers/engine.mjs";

process.env.PI_SUPERNOVA_CONFIG = fileURLToPath(new URL("../../src/config/config.default.json", import.meta.url));

const CITATION = /⋯ \d+ lines same as #\d+/;

const line = i => "const value_" + i + " = compute(" + i + ");";

async function ledgerFixture(t, { experimental = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-ledger-"));
  t.diagnostic("Fixture retained at " + root);
  const tools = new Map();
  const handlers = new Map();

  const pi = {
    registerTool: tool => tools.set(tool.name, tool),
    getAllTools: () => [...tools.values()],
    registerCommand() {},
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };

  if (experimental) registerExperimentalLedger(pi);
  else registerCodeMode(pi);
  const tool = tools.get("supernova");

  if (!tool) throw new Error("CodeMode test seam disappeared; do not replace it with a fake executor");
  const execute = code => tool.execute("ledger-contract", { code, timeoutMs: 2000 }, undefined, undefined, { cwd: root });
  // The host fires "context" with the messages that will actually be sent. This is
  // the only evidence the ledger may collapse against, so tests supply exactly that.
  const observe = async messages => { for (const handler of handlers.get("context") ?? []) await handler({ messages }, {}); };

  return { root, tool, execute, observe, write: (file, text) => fs.writeFile(path.join(root, file), text) };
}

const modelText = result => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

// A body with many substantive lines, so a repeat is a collapsible run.
const body = Array.from({ length: 30 }, (_, i) => line(i)).join("\n") + "\n";

const shipped = text => [{ role: "toolResult", toolCallId:"ledger-contract", toolName:"supernova", content: [{ type: "text", text }], isError:false, timestamp:0 }];

it("retains nothing until an observation, and never a line too long to be content", () => {
  const ledger = new SeenLedger({ window: 40 });
  assert.equal(ledger.retainedLines, null, "a fresh ledger proves nothing");
  assert.equal(ledger.isRetained("const anything = 1;"), false, "an unobserved line is not retained");
  const blob = "A".repeat(2_000_000);
  ledger.observe([{ role: "tool", content: [{ type: "image", mimeType: "image/png", data: blob }] }, { content: [{ type: "text", text: "const kept = compute(1);\n\n  indented continuation" }] }]);
  assert.equal(ledger.isRetained("const kept = compute(1);"), true, "ordinary lines are retained");
  assert.equal(ledger.isRetained(""), true, "a blank line is retained, so a run can span it");
  assert.equal(ledger.isRetained(blob), false, "an oversized blob is never retained");
  assert.ok(ledger.retainedLines.size < 1000, "the blob contributes no set entries: " + ledger.retainedLines.size);
  assert.equal([...ledger.retainedLines].some(line => line.length > 4096), false, "no oversized line is retained");
});

it("sends every line in full until the host has observed a request", async t => {
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  const first = modelText(await f.execute('return await read("target.js");'));
  const second = modelText(await f.execute('return await read("target.js");'));
  assert.ok(first.includes(line(29)), "the first read is complete");
  assert.ok(second.includes(line(29)), "with no observation nothing is proven retained");
  assert.doesNotMatch(second, CITATION, "an unobserved repeat must be sent in full");
});

it("collapses a repeat only after the outgoing request was observed to carry it", async t => {
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  const first = modelText(await f.execute('return await read("target.js");'));
  assert.doesNotMatch(first, CITATION);
  await f.observe(shipped(first));
  const repeat = modelText(await f.execute('return await read("target.js");'));
  assert.match(repeat, CITATION, "a line proven present in the request may be cited instead of resent");
  assert.ok(!repeat.includes(line(29)), "the proven-retained run is not resent");
});

it("stops collapsing the moment the observed request no longer carries the lines", async t => {
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  const first = modelText(await f.execute('return await read("target.js");'));
  await f.observe(shipped(first));
  assert.match(modelText(await f.execute('return await read("target.js");')), CITATION);
  // Compaction, /tree navigation or fork rewrote the context: the lines are gone.
  await f.observe([{ role: "user", content: [{ type: "text", text: "Summary: the agent inspected target.js and reported thirty computed values." }] }]);
  const after = modelText(await f.execute('return await read("target.js");'));
  assert.doesNotMatch(after, CITATION, "an unobserved line must never be collapsed");
  assert.ok(after.includes(line(29)), "the full body returns once retention is unproven");
});

it("never collapses a changed line, and always shows an explicitly windowed read", async t => {
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  const first = modelText(await f.execute('return await read("target.js");'));
  await f.observe(shipped(first));
  await f.execute('await edit("target.js", "' + line(7) + '", "const value_7 = compute(707);");');
  const after = modelText(await f.execute('return await read("target.js");'));
  assert.ok(after.includes("const value_7 = compute(707);"), "a changed line is never collapsed");
  const window = modelText(await f.execute('return await read({path:"target.js", offset:1, limit:6});'));
  assert.ok(window.includes(line(0)), "explicitly windowed lines are pinned and always shown");
});

it("never collapses against a peer in the same batch, which the model has not received", async t => {
  // Programs in one `programs` call run before any of their results is sent. A
  // later program in the same batch therefore has no evidence that the earlier
  // one's output is in context, and must resend rather than cite it.
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  await f.observe([{ role: "user", content: [{ type: "text", text: "begin" }] }]);
  const batch = await f.tool.execute("ledger-batch", { programs: [{ code: 'return await read("target.js");' }, { code: 'return await read("target.js");' }], timeoutMs: 2000 }, undefined, undefined, { cwd: f.root });
  const text = modelText(batch);
  assert.doesNotMatch(text, /⋯ \d+ lines same as #/, "an unsent peer result is not evidence of residency");
  assert.equal(text.split(line(29)).length - 1, 2, "both programs must deliver the body in full");
});

it("a proven-retention session publishes far less than an unproven one", async t => {
  // The frozen traffic gate cannot see this: its host never fires "context", so the
  // ledger stays inert there by construction. This is the regression guard for the
  // saving itself. Characters, not provider tokens: a proportional, local proxy.
  const measure = async observe => {
    const f = await ledgerFixture(t);
    await f.write("target.js", body);
    await f.write("other.js", body.split("\n").map(text => text.replace("compute", "derive")).join("\n"));
    const conversation = [];
    let published = 0;
    const script = ['return await read("target.js");', 'return await read("other.js");', 'return await read("target.js");', 'return await read("target.js");'];

    for (const code of script) {
      if (observe) await f.observe(conversation);
      const text = modelText(await f.execute(code));
      conversation.push({ role: "tool", content: [{ type: "text", text }] });
      published += text.length;
    }

    return published;
  };

  const inert = await measure(false);
  const proven = await measure(true);
  assert.ok(proven < inert * 0.6, "proven retention must publish well under half the unproven size: " + proven + " vs " + inert);
});

it("never nests a citation inside another citation", async t => {
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  const first = modelText(await f.execute('return await read("target.js");'));
  await f.observe(shipped(first));
  const collapsed = modelText(await f.execute('return await read("target.js");'));
  const cited = Number(/same as #(\d+)/.exec(collapsed)?.[1]);
  assert.ok(Number.isInteger(cited), "the repeat cites the call that carried the lines");
  // A real context holds the original full result and the later collapsed repeat.
  await f.observe([...shipped(first), ...shipped(collapsed)]);
  const again = modelText(await f.execute('return await read("target.js");'));
  const markers = again.match(/⋯ \d+ lines same as #\d+/g) ?? [];
  assert.equal(markers.length, 1, "exactly one citation, never a chain");
  assert.equal(Number(/same as #(\d+)/.exec(again)[1]), cited, "still cites the call that carried the content");
  // The marker is a citation, not content, so it is never itself the target of one.
  const marker = collapsed.split("\n").find(text => text.startsWith("⋯ "));
  assert.equal(again.split(marker).length - 1, 1, "a citation never collapses into another citation");
});

it("proving retention requires the content itself, not a citation of it", async t => {
  const f = await ledgerFixture(t);
  await f.write("target.js", body);
  const first = modelText(await f.execute('return await read("target.js");'));
  await f.observe(shipped(first));
  const collapsed = modelText(await f.execute('return await read("target.js");'));
  assert.match(collapsed, CITATION);
  // Context now carries only the citation, not the lines it points at.
  await f.observe(shipped(collapsed));
  const after = modelText(await f.execute('return await read("target.js");'));
  assert.doesNotMatch(after, CITATION, "a citation is not evidence of its own contents");
  assert.ok(after.includes(line(29)), "the lines come back in full");
});

it("shipping defaults keep complete results across hidden, reordered and removed context", async t => {
  const f = await ledgerFixture(t, { experimental:false });
  await f.write("target.js", body);
  const first = await f.execute('return await read("target.js");');

  const contexts = [
    [{role:"toolResult", content:[{type:"text",text:"Previous content omitted."}], details:first.details}],
    shipped(modelText(first)),
    [{role:"user",content:body.trimEnd().split("\n").reverse().join("\n")}],
    [{role:"user",content:"Summary without source text"}],
  ];

  for (const messages of contexts) {
    await f.observe(messages);
    const repeat = modelText(await f.execute('return await read("target.js");'));
    assert.doesNotMatch(repeat, CITATION, "default output must not depend on context residency");
    assert.ok(repeat.includes(body), "every source line, in order, remains visible");
  }

  assert.equal(new SeenLedger().window, 0, "direct users must also opt in");
});
