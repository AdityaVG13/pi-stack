import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digestMessage as aDigest } from "../lib/dialects/anthropic.ts";
import { digestMessage as oDigest } from "../lib/dialects/openai-chat.ts";
import { chainHashes } from "../lib/hashing.ts";
import { aAssistant, aResult, aUser, oAssistant, oTool, oUser } from "./util.mjs";

describe("canonicalization", () => {
  it("ignores cache_control on anthropic text blocks", () => {
    const plain = { role: "user", content: [{ type: "text", text: "hello" }] };

    const marked = {
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    };

    assert.equal(aDigest(plain), aDigest(marked));
  });

  it("treats string content and a single text block as equal", () => {
    const s = { role: "user", content: "hello" };
    const b = { role: "user", content: [{ type: "text", text: "hello" }] };

    assert.equal(aDigest(s), aDigest(b));
    assert.equal(oDigest(s), oDigest(b));
  });

  it("changes digest when content changes", () => {
    assert.notEqual(aDigest(aUser("one")), aDigest(aUser("two")));
  });

  it("treats tool result string vs text blocks as equal", () => {
    const s = aResult("tu_1", "output text");

    const b = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [{ type: "text", text: "output text" }],
        },
      ],
    };

    assert.equal(aDigest(s), aDigest(b));
  });

  it("chain prefix of n is the full chain of the prefix", () => {
    const msgs = [aUser("task"), aAssistant("step", ["t1", "bash", { command: "ls" }])];
    const d = msgs.map(aDigest);
    const chain2 = chainHashes(d);
    const chain1 = chainHashes(d.slice(0, 1));

    assert.equal(chain2[0], chain1[0]);
    assert.notEqual(chain2[1], chain2[0]);
  });

  it("openai tool call identity tracks arguments not just name", () => {
    const m1 = oAssistant("thinking", ["c1", "bash", { command: "ls" }]);
    const m2 = oAssistant("thinking", ["c1", "bash", { command: "ls" }]);
    const m3 = oAssistant("thinking", ["c1", "bash", { command: "rm" }]);

    assert.equal(oDigest(m1), oDigest(m2));
    assert.notEqual(oDigest(m1), oDigest(m3));
    assert.notEqual(oDigest(oTool("c1", "ok")), oDigest(oUser("ok")));
  });
});
