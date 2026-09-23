import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compact, groupTurns } from "../lib/cliff.ts";
import { makeConfig } from "../lib/config.ts";
import { SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { DIALECT, digestMessage } from "../lib/dialects/openai-responses.ts";
import { Engine, ctxOutgoingBody } from "../lib/engine.ts";

function dev(text) {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function user(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function assistant(text) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function reasoning(i, summaryText = null) {
  const item = { type: "reasoning", id: "rs_" + i, encrypted_content: ("enc-" + i).repeat(10) };

  if (summaryText) {
    item.summary = [{ type: "summary_text", text: summaryText }];
  }

  return item;
}

function fcall(i, cmd = "echo hi") {
  return {
    type: "function_call",
    id: "fc_" + i,
    call_id: "call_" + i,
    name: "exec_command",
    arguments: JSON.stringify({ cmd }),
    status: "completed",
  };
}

function fout(i, output = "ok (exit 0)") {
  return { type: "function_call_output", call_id: "call_" + i, output };
}

function codexSession(nSteps, fatEvery = 2) {
  const items = [
    dev("<skills_instructions>be a good agent</skills_instructions>"),
    user("<environment_context><cwd>/tmp</cwd></environment_context>"),
    user("Task: run the build. Codeword: PELICAN."),
  ];

  for (let i = 0; i < nSteps; i++) {
    items.push(reasoning(i, "planning step " + i));
    items.push(fcall(i, "make step" + i));
    const fat = fatEvery && i % fatEvery === 0;
    items.push(fout(i, fat ? "LOG " + "x".repeat(2000) : "step" + i + " ok"));
  }

  return items;
}

function rBody(items) {
  return {
    model: "gpt-5",
    instructions: "You are a coding agent." + "x".repeat(200),
    input: items,
    store: false,
    stream: true,
  };
}

describe("openai responses dialect", () => {
  it("keeps a model step as one turn", () => {
    const items = codexSession(3);
    const turns = groupTurns(items, DIALECT);

    assert.equal(turns.length, 4);
    assert.deepEqual(turns[1].map((i) => i.type), ["reasoning", "function_call", "function_call_output"]);
    assert.deepEqual(turns.flat(), items);
  });

  it("groups an assistant message inside the step run", () => {
    const items = [user("task"), reasoning(0), assistant("thinking done"), fcall(0), fout(0)];
    const turns = groupTurns(items, DIALECT);

    assert.equal(turns.length, 2);
    assert.equal(turns[1].length, 4);
  });

  it("ignores id and status in digests", () => {
    const a = fcall(1);
    const b = { ...fcall(1), id: "totally-different", status: "in_progress" };

    assert.equal(digestMessage(a), digestMessage(b));
    assert.notEqual(digestMessage(fcall(1)), digestMessage(fcall(2)));
  });

  it("tracks encrypted_content in reasoning digests", () => {
    assert.notEqual(digestMessage(reasoning(1)), digestMessage(reasoning(2)));
    assert.equal(digestMessage(reasoning(1)), digestMessage(reasoning(1)));
  });

  it("compacts a Codex-shaped history", () => {
    const items = codexSession(6);
    const res = compact(items, DIALECT, makeConfig({ keepRecent: 2 }));

    assert.ok(res);
    assert.equal(res.headLen, 3);
    assert.deepEqual(res.messages.slice(0, 3), items.slice(0, 3));
    const summary = res.messages[3];
    assert.equal(summary.role, "user");
    const text = summary.content[0].text;
    assert.ok(text.startsWith(SUMMARY_HEADER));
    assert.ok(text.includes("[exec_command]"));
    assert.ok(text.includes("step1 ok"));
    assert.equal(text.includes("LOG "), false);
    assert.ok(text.includes("thinking: planning step 0"));
    assert.equal(text.includes("enc-"), false);
    const kept = res.messages.slice(4);
    assert.deepEqual(kept.slice(0, 3).map((i) => i.type), ["reasoning", "function_call", "function_call_output"]);
    assert.ok(kept[0].encrypted_content.startsWith("enc-4"));
  });

  it("drops the prior summary on recompaction", () => {
    const items = codexSession(6);
    const res = compact(items, DIALECT, makeConfig({ keepRecent: 2 }));
    const grown = res.messages.concat([reasoning(9), fcall(9), fout(9)]);
    const res2 = compact(grown, DIALECT, makeConfig({ keepRecent: 2 }));

    assert.ok(res2);
    const text = res2.summary.content[0].text;
    assert.equal(text.split(SUMMARY_HEADER).length - 1, 1);
    assert.equal(res2.messages[3], res2.summary);
    assert.equal(res2.headLen, 3);
  });

  it("substitutes on the input key", () => {
    const cfg = makeConfig({ thresholdTokens: 1, keepRecent: 1 });
    const eng = new Engine(cfg);
    const items = codexSession(5);
    const ctx = eng.prepare(rBody(items), DIALECT);

    assert.equal(ctx.compacted, true);
    const out = ctxOutgoingBody(ctx);
    assert.ok(out.input.length < items.length);
    assert.equal(out.instructions, rBody(items).instructions);

    const items2 = items.concat([reasoning(7), fcall(7), fout(7)]);
    const ctx2 = eng.prepare(rBody(items2), DIALECT);

    assert.equal(ctx2.modified, true);
    const out2 = ctxOutgoingBody(ctx2);
    assert.ok(out2.input[3].content[0].text.startsWith(SUMMARY_HEADER));
    assert.deepEqual(out2.input.slice(-3), items2.slice(-3));
  });
});
