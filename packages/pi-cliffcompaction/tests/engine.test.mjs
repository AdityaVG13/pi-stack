import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeConfig } from "../lib/config.ts";
import { DIALECT as ANTHROPIC } from "../lib/dialects/anthropic.ts";
import { fitSummary, SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { DIALECT as OPENAI } from "../lib/dialects/openai-chat.ts";
import { DIALECT as RESPONSES } from "../lib/dialects/openai-responses.ts";
import { DIALECT as PI } from "../lib/dialects/pi.ts";
import { Engine, ctxOutgoingBody, estimateTokens } from "../lib/engine.ts";
import { PrefixStore } from "../lib/store.ts";
import { aAssistant, aBody, aResult, aSession, aUser, grow, oBody, oSession } from "./util.mjs";

function nSummaries(msgs) {
  let n = 0;

  for (const m of msgs) {
    if (m.role === "user" && String(m.content).startsWith(SUMMARY_HEADER)) {
      n += 1;
    }
  }

  return n;
}

describe("escalation isolation and accounting", () => {
  it("rung three fits escaped summary text when the protected floor fits", () => {
    const piece = ("x" + "\u0001").repeat(240);

    const msgs = [aUser("task"), aAssistant("s0", ["t0", "bash", { command: "c0" }]),
      aResult("t0", piece), aAssistant("done?", ["tz", "bash", { command: "true" }]), aResult("tz", "ok")];

    const engine = new Engine(makeConfig({ thresholdTokens: 260, strict: true, keepRecent: 1 }));
    const ctx = engine.prepare(aBody(msgs), ANTHROPIC);

    assert.equal(ctx.rung, 3);
    assert.ok(ctx.estTokensOut <= 260);
    assert.equal(ctx.overBudget, false);
    assert.equal(ctx.estTokensOut, estimateTokens(ctxOutgoingBody(ctx)));
    assert.deepEqual(ctxOutgoingBody(ctx).messages.slice(-2), msgs.slice(-2));
    assert.equal(ctxOutgoingBody(ctx).messages[0], msgs[0]);
    const retry = engine.prepare(aBody(msgs), ANTHROPIC);

    assert.deepEqual(ctxOutgoingBody(retry), ctxOutgoingBody(ctx));
  });

  it("keeps escalation request-local for smaller sibling requests", () => {
    const prefix = [aUser("task")];

    for (let i = 0; i < 8; i++) {
      prefix.push(aAssistant("step " + i + " " + "x".repeat(300), ["t" + i, "bash", { command: "cmd " + i }]));
      prefix.push(aResult("t" + i, "ok " + i));
    }

    const cfg = makeConfig({ thresholdTokens: 400, strict: true });
    const engine = new Engine(cfg);
    const large = aBody([...prefix, aAssistant("big", ["tb", "bash", { command: "cat big" }]), aResult("tb", "Z".repeat(4000))]);
    const small = aBody([...prefix, aAssistant("small", ["ts", "bash", { command: "ls" }]), aResult("ts", "a.txt")]);
    const first = engine.prepare(large, ANTHROPIC);

    assert.equal(first.rung, 3);
    const warm = engine.prepare(small, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(small), ANTHROPIC);

    assert.ok(cold.estTokensOut <= cfg.thresholdTokens);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
  });
});

describe("cache policy and exact trigger boundaries", () => {
  it("leaves sub-budget canonical-equivalent requests intact after a cached cliff", () => {
    const followUp = "Keep the entire follow-up instruction: " + "use staging, never production. ".repeat(20);

    for (const headroom of [0, 1]) {
      const body = aBody([
        aUser("task"), aAssistant("older answer"), aUser(followUp), aAssistant("recent answer"),
      ]);

      const smaller = structuredClone(body);

      smaller.messages[1].content = "older answer";
      const cfg = makeConfig({ thresholdTokens: estimateTokens(smaller) + headroom, keepRecent: 1, humanMaxChars: 16 });
      const engine = new Engine(cfg);
      const initial = engine.prepare(body, ANTHROPIC);

      assert.equal(initial.compacted, true);
      assert.ok(initial.estTokensIn > cfg.thresholdTokens);
      assert.ok(initial.estTokensOut <= cfg.thresholdTokens);
      assert.ok(engine.store.size > 0);
      assert.equal(ctxOutgoingBody(initial).messages[initial.baseHead].content.includes(followUp), false);

      // Anthropic accepts both encodings of the same assistant text.
      body.messages[1].content = "older answer";
      const warm = engine.prepare(body, ANTHROPIC);
      const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);

      assert.deepEqual(warm.chain, initial.chain);
      assert.ok(warm.estTokensIn <= cfg.thresholdTokens);
      assert.equal(cold.modified, false);
      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.equal(warm.modified, false);
      assert.equal(ctxOutgoingBody(warm), body);
      assert.equal(warm.estTokensOut, estimateTokens(body));
      assert.equal(ctxOutgoingBody(warm).messages[2].content, followUp);
    }
  });

  it("matches cold cliffs after above-budget canonical-equivalent cost redistribution", () => {
    const cfg = makeConfig({ thresholdTokens: 882, keepRecent: 1 });

    for (const [from, to] of [[3, 0], [0, 3]]) {
      const body = aBody([aUser("task")]);

      for (let i = 0; i < 4; i++) {
        body.messages.push(
          aAssistant("step " + i + " " + "x".repeat(80), ["t" + i, "bash", { command: "inspect " + i }]),
          aResult("t" + i, i % 2 === 0 ? "r".repeat(1200) : "ok"),
        );
      }

      body.messages[1 + from * 2].content[0].cache_control = { type: "ephemeral" };
      const engine = new Engine(cfg);
      const initial = engine.prepare(body, ANTHROPIC);
      const initialOutput = ctxOutgoingBody(initial);

      assert.equal(initial.compacted, true);
      assert.ok(initial.estTokensIn > cfg.thresholdTokens);
      const cached = engine.prepare(body, ANTHROPIC);
      assert.equal(cached.compacted, false);
      assert.deepEqual(ctxOutgoingBody(cached), initialOutput);

      delete body.messages[1 + from * 2].content[0].cache_control;
      body.messages[1 + to * 2].content[0].cache_control = { type: "ephemeral" };
      const cold = new Engine(cfg).prepare(body, ANTHROPIC);
      const expected = ctxOutgoingBody(cold);

      assert.equal(cold.estTokensIn, initial.estTokensIn);
      assert.ok(cold.estTokensIn > cfg.thresholdTokens);
      assert.deepEqual(cold.chain, initial.chain);
      assert.equal(cold.overBudget, false);
      assert.notDeepEqual(expected, initialOutput);
      assert.equal(expected.messages.includes(body.messages[6]), to === 0,
        "an early trigger leaves the previous long tool result verbatim");

      const warm = engine.prepare(body, ANTHROPIC);
      const output = ctxOutgoingBody(warm);

      assert.deepEqual(output, expected);
      assert.equal(output.messages[0], body.messages[0]);
      assert.equal(output.messages.at(-1), body.messages.at(-1));
      assert.equal(warm.estTokensOut, estimateTokens(output));
      const repeated = engine.prepare(body, ANTHROPIC);
      assert.equal(repeated.compacted, false);
      assert.deepEqual(ctxOutgoingBody(repeated), expected);
    }
  });

  it("matches a cold replay across the integer token boundary", () => {
    const rows = [[365, 97, 4419], [40, 263, 472], [194, 107, 544], [384, 64, 459], [50, 241, 0]];
    const msgs = [aUser("task 3")];

    for (const [i, [textLen, cmdLen, resultLen]] of rows.entries()) {
      msgs.push(aAssistant("step " + i + " " + "t".repeat(textLen - 7), ["id" + i, "bash", { command: "c".repeat(cmdLen) }]));

      if (resultLen > 0) {
        msgs.push(aResult("id" + i, "r".repeat(resultLen)));
      }
    }

    for (let thresholdTokens = 1105; thresholdTokens <= 1107; thresholdTokens++) {
      const cfg = makeConfig({ thresholdTokens, keepRecent: 1 });
      const warm = new Engine(cfg);

      for (let length = 2; length <= msgs.length; length++) {
        const body = aBody(msgs.slice(0, length));
        const actual = warm.prepare(body, ANTHROPIC);
        const fresh = new Engine(cfg).prepare(body, ANTHROPIC);

        assert.deepEqual(ctxOutgoingBody(actual), ctxOutgoingBody(fresh));
        assert.equal(actual.estTokensOut, estimateTokens(ctxOutgoingBody(actual)));
      }
    }
  });

  it("shared stores isolate configuration and fixed request budgets", () => {
    const store = new PrefixStore();
    const body = aBody(aSession(12));
    new Engine(makeConfig({ thresholdTokens: 400, keepRecent: 1 }), store).prepare(body, ANTHROPIC);

    for (const cfg of [makeConfig({ thresholdTokens: 100_000 }), makeConfig({ thresholdTokens: 2000 })]) {
      const shared = new Engine(cfg, store);
      shared.prepare(aBody(body.messages, "large system ".repeat(1000)), ANTHROPIC);
      const actual = shared.prepare(body, ANTHROPIC);
      const fresh = new Engine(cfg).prepare(body, ANTHROPIC);

      assert.deepEqual(ctxOutgoingBody(actual), ctxOutgoingBody(fresh));
    }
  });

  it("validates cache content after cloning, splicing, reordering and changing dialect", () => {
    const cfg = makeConfig({ thresholdTokens: 100_000 });
    const engine = new Engine(cfg);
    let body = aBody(aSession(8));

    for (const step of ["original", "clone", "splice", "reorder", "dialect"]) {
      if (step === "clone") {
        body = structuredClone(body);
        body.messages[4].content[0].content = "[redacted]";
        body.system = "new system";
      } else if (step === "splice") {
        body.messages.splice(3, 2);
      } else if (step === "reorder") {
        body.messages.reverse();
      }

      const dialect = step === "dialect" ? OPENAI : ANTHROPIC;
      const actual = engine.prepare(body, dialect);
      const fresh = new Engine(cfg).prepare(structuredClone(body), dialect);

      assert.deepEqual(actual.chain, fresh.chain);
      assert.deepEqual(ctxOutgoingBody(actual), ctxOutgoingBody(fresh));
      assert.equal(actual.estTokensIn, estimateTokens(body));
    }
  });
});

it("invalidates cached Anthropic cliffs when tool-result documents become sub-budget", () => {
  const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1, humanMaxChars: 16 });
  const original = "PRIVATE-DOCUMENT-CONTENT ".repeat(300);
  const document = { type: "document", source: { type: "text", media_type: "text/plain", data: original } };
  const text = { type: "text", text: "Document loaded." };
  const result = { type: "tool_result", tool_use_id: "t0", content: [text, document] };
  const followUp = "Keep the complete follow-up instruction, not just its capped excerpt.";

  const messages = [
    aUser("Read the document."),
    aAssistant("Loading the document.", ["t0", "read", { path: "guide.txt" }]),
    { role: "user", content: [result] },
    aUser(followUp),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const engine = new Engine(cfg);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);

  assert.ok(estimateTokens(body) > cfg.thresholdTokens);
  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: Document loaded."));
  assert.ok(output.messages[1].content.includes("user: " + followUp.slice(0, cfg.humanMaxChars) + "..."));
  assert.equal(JSON.stringify(output).includes("PRIVATE-DOCUMENT-CONTENT"), false);
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  document.source.data = "[redacted]";

  for (const content of [[text, document], [text]]) {
    result.content = content;
    assert.ok(estimateTokens(body) < cfg.thresholdTokens);
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);

    assert.equal(cold.modified, false);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.equal(warm.modified, false);
    assert.equal(ctxOutgoingBody(warm), body);
    assert.equal(ctxOutgoingBody(warm).messages[3].content, followUp);
    assert.equal(warm.estTokensIn, estimateTokens(body));
  }

  document.source.data = original;
  result.content = [text, document];
  const restored = engine.prepare(body, ANTHROPIC);
  assert.equal(restored.compacted, false);
  assert.deepEqual(ctxOutgoingBody(restored), output);
});

it("invalidates cached Anthropic cliffs when content-source documents shrink", () => {
  const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1, humanMaxChars: 16 });
  const original = "PRIVATE-CONTENT-DOCUMENT ".repeat(300);
  const followUp = "Preserve this complete follow-up instruction when the document is redacted.";

  for (const nested of [false, true]) {
    for (const blocks of [false, true]) {
      const document = {
        type: "document",
        source: { type: "content", content: blocks ? [{ type: "text", text: original }] : original },
      };

      const text = { type: "text", text: "Document loaded." };

      const content = nested
        ? [{ type: "tool_result", tool_use_id: "t0", content: [text, document] }]
        : [text, document];

      const messages = [
        aUser("Read the document."),
        aAssistant("Loading the document.", nested ? ["t0", "read", { path: "guide.txt" }] : null),
        { role: "user", content },
        aUser(followUp),
        aAssistant("recent response"),
      ];

      const body = aBody(messages);
      const engine = new Engine(cfg);
      const first = engine.prepare(body, ANTHROPIC);
      const output = ctxOutgoingBody(first);

      assert.ok(estimateTokens(body) > cfg.thresholdTokens);
      assert.equal(first.compacted, true);
      assert.ok(output.messages[1].content.includes("user: " + followUp.slice(0, cfg.humanMaxChars) + "..."));
      assert.equal(JSON.stringify(output).includes("PRIVATE-CONTENT-DOCUMENT"), false);
      assert.equal(output.messages[0], messages[0]);
      assert.equal(output.messages.at(-1), messages.at(-1));
      const cached = engine.prepare(body, ANTHROPIC);
      assert.equal(cached.compacted, false);
      assert.deepEqual(ctxOutgoingBody(cached), output);

      if (blocks) {
        document.source.content[0].text = "[redacted]";
      } else {
        document.source.content = "[redacted]";
      }

      assert.ok(estimateTokens(body) < cfg.thresholdTokens);
      const warm = engine.prepare(body, ANTHROPIC);
      const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);

      assert.equal(cold.modified, false);
      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.equal(warm.modified, false);
      assert.equal(ctxOutgoingBody(warm), body);
      assert.equal(ctxOutgoingBody(warm).messages[3].content, followUp);
      assert.equal(warm.estTokensIn, estimateTokens(body));

      document.source.content = blocks ? [{ type: "text", text: original }] : original;
      const restored = engine.prepare(body, ANTHROPIC);
      assert.equal(restored.compacted, false);
      assert.deepEqual(ctxOutgoingBody(restored), output);
    }
  }
});

it("recaps short Anthropic search-result content without stale excerpts", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 60 });

  const search = (texts) => ({
    type: "search_result", source: "https://example.com/deploy", title: "Deployment status",
    content: texts.map(text => ({ type: "text", text })), citations: { enabled: true },
  });

  const result = {
    type: "tool_result", tool_use_id: "t0",
    content: [search(["SENSITIVE-SEARCH-RESULT", "status: READY"])],
  };

  const messages = [
    aUser("Read the deployment status."),
    aAssistant("Inspecting deployment. ".repeat(300), ["t0", "search", { query: "deployment status" }]),
    { role: "user", content: [result] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const engine = new Engine(cfg);
  const first = engine.prepare(body, ANTHROPIC);
  const firstOutput = ctxOutgoingBody(first);

  assert.equal(first.compacted, true);
  assert.ok(firstOutput.messages[1].content.includes("result: SENSITIVE-SEARCH-RESULT\nstatus: READY"));
  assert.equal(firstOutput.messages[0], messages[0]);
  assert.equal(firstOutput.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), firstOutput);

  for (const [content, expected] of [
    [[search(["[redacted]", "status: READY"])], "[redacted]\nstatus: READY"],
    [[{ type: "text", text: "Found:" }, search(["first fact"]), search(["second fact"])], "Found:\nfirst fact\nsecond fact"],
    [[search(["AT-CAP-".padEnd(cfg.resultMaxChars, "x")])], "AT-CAP-".padEnd(cfg.resultMaxChars, "x")],
    [[search(["OVER-CAP-".padEnd(cfg.resultMaxChars + 1, "x")])], null],
    [[search([])], null],
  ]) {
    result.content = content;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const output = ctxOutgoingBody(warm);
    const summary = output.messages[1].content;

    assert.deepEqual(output, ctxOutgoingBody(cold));
    assert.equal(JSON.stringify(output).includes("SENSITIVE-SEARCH-RESULT"), false);
    assert.equal(output.messages[0], messages[0]);
    assert.equal(output.messages.at(-1), messages.at(-1));
    assert.equal(warm.estTokensIn, estimateTokens(body));
    assert.equal(warm.estTokensOut, estimateTokens(output));

    if (expected === null) {
      assert.equal(summary.includes("result:"), false);
    } else {
      assert.ok(summary.includes("result: " + expected));
    }
  }
});

it("retains direct Anthropic search-result excerpts within resultMaxChars", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 60 });

  const result = {
    type: "search_result", source: "https://example.com/deploy", title: "Deployment status",
    content: [{ type: "text", text: "SENSITIVE-DIRECT-RESULT" }, { type: "text", text: "status: READY" }],
    citations: { enabled: true },
  };

  const messages = [
    aUser("Check deployment."),
    aAssistant("Inspecting deployment. ".repeat(300)),
    { role: "user", content: [{ type: "text", text: "Use this evidence." }, result] },
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const engine = new Engine(cfg);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: SENSITIVE-DIRECT-RESULT\nstatus: READY"));
  assert.ok(output.messages[1].content.includes("user: Use this evidence."));
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  assert.equal(output.messages[1].content.includes(result.source), false);
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  for (const text of ["[redacted]", "AT-CAP-".padEnd(60, "x"), "OVER-CAP-".padEnd(61, "x"), ""]) {
    result.content = [{ type: "text", text }];
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);
    const summary = next.messages[1].content;

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.equal(summary.includes("SENSITIVE-DIRECT-RESULT"), false);
    assert.equal(summary, SUMMARY_HEADER + "\n\n" + [
      "assistant: " + messages[1].content[0].text.slice(0, cfg.thoughtMaxChars) + "...",
      "user: Use this evidence.",
      ...(text && text.length <= cfg.resultMaxChars ? ["result: " + text] : []),
    ].join("\n\n---\n\n"));
    assert.equal(next.messages[0], messages[0]);
    assert.equal(next.messages.at(-1), messages.at(-1));
    assert.equal(warm.estTokensOut, estimateTokens(next));
    assert.ok(warm.estTokensOut <= cfg.thresholdTokens);
  }
});

it("recaps Anthropic server tool inputs and invalidates excerpts after edits", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, cmdMaxChars: 40 });
  const engine = new Engine(cfg);

  const call = {
    type: "server_tool_use", id: "srvtoolu_0", name: "web_search",
    input: { query: "SENSITIVE-SEARCH-" + "x".repeat(100) },
  };

  const messages = [
    aUser("Find the relevant documentation."),
    { role: "assistant", content: [call, {
      type: "web_search_tool_result", tool_use_id: call.id,
      content: [{ type: "web_search_result", url: "https://example.com/docs", title: "Documentation",
        encrypted_content: "x".repeat(5000) }],
    }] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);

  assert.equal(first.compacted, true);
  assert.ok(ctxOutgoingBody(first).messages[1].content.includes(
    "[web_search] " + JSON.stringify(call.input).slice(0, cfg.cmdMaxChars) + "...",
  ));
  assert.equal(ctxOutgoingBody(first).messages[0], messages[0]);
  assert.equal(ctxOutgoingBody(first).messages.at(-1), messages.at(-1));

  call.input.query = "[redacted]";
  const warm = engine.prepare(body, ANTHROPIC);
  const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);

  assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
  assert.ok(ctxOutgoingBody(warm).messages[1].content.includes('[web_search] {"query":"[redacted]"}'));
  assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-SEARCH"), false);
});

it("recaps short Anthropic tool-search errors without stale diagnostics", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 500 });
  const engine = new Engine(cfg);

  const original = {
    error_code: "invalid_tool_input", error_message: "SENSITIVE-TOOL-SEARCH-DIAGNOSTIC",
    type: "tool_search_tool_result_error",
  };

  const result = { type: "tool_search_tool_result", tool_use_id: "srvtoolu_search_0", content: original };

  const messages = [
    aUser("Find the deployment tools."),
    { role: "assistant", content: [
      { type: "text", text: "Discovering tools. ".repeat(300) },
      { type: "server_tool_use", id: result.tool_use_id, name: "tool_search_tool_regex", input: { query: "deployment" } },
      result,
    ] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);
  const errorText = JSON.stringify(original);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: " + errorText),
    "short native tool-search errors must survive compaction");
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  for (const limit of [errorText.length, errorText.length - 1]) {
    const ctx = new Engine(makeConfig({ ...cfg, resultMaxChars: limit })).prepare(body, ANTHROPIC);
    assert.equal(ctxOutgoingBody(ctx).messages[1].content.includes("result: " + errorText), limit === errorText.length);
  }

  for (const [content, retained] of [
    [{ ...original, error_message: "[redacted]" }, true],
    [{ error_code: "unavailable", error_message: null, type: "tool_search_tool_result_error" }, true],
    [{ error_code: "too_many_requests", type: "tool_search_tool_result_error" }, true],
    [{ error_code: "execution_time_exceeded", error_message: null, type: "tool_search_tool_result_error" }, true],
    [{ tool_references: [], type: "tool_search_tool_search_result" }, false],
    [{ tool_references: [{ tool_name: "read_deploy", type: "tool_reference" }], type: "tool_search_tool_search_result" }, false],
  ]) {
    result.content = content;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);
    const summary = next.messages[1].content;

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.equal(summary.includes("SENSITIVE-TOOL-SEARCH-DIAGNOSTIC"), false);
    assert.equal(summary.includes("result:"), retained);

    if (retained) assert.ok(summary.includes("result: " + JSON.stringify(content)));

    assert.equal(next.messages[0], messages[0]);
    assert.equal(next.messages.at(-1), messages.at(-1));
    assert.equal(warm.estTokensIn, estimateTokens(body));
    assert.equal(warm.estTokensOut, estimateTokens(next));
  }

  result.content = original;
  const restored = engine.prepare(body, ANTHROPIC);
  assert.equal(restored.compacted, false);
  assert.deepEqual(ctxOutgoingBody(restored), output);
});

it("recaps short Anthropic web-search errors without stale diagnostics", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 500 });
  const engine = new Engine(cfg);

  const result = {
    type: "web_search_tool_result", tool_use_id: "srvtoolu_search_0",
    content: { error_code: "too_many_requests", type: "web_search_tool_result_error" },
  };

  const messages = [
    aUser("Find the relevant documentation."),
    { role: "assistant", content: [
      { type: "text", text: "Searching documentation. ".repeat(300) },
      { type: "server_tool_use", id: result.tool_use_id, name: "web_search", input: { query: "deployment guide" } },
      result,
    ] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);
  const errorText = JSON.stringify(result.content);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: " + errorText),
    "short native web-search errors must survive compaction");
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  for (const limit of [errorText.length, errorText.length - 1]) {
    const ctx = new Engine(makeConfig({ ...cfg, resultMaxChars: limit })).prepare(body, ANTHROPIC);
    assert.equal(ctxOutgoingBody(ctx).messages[1].content.includes("result: " + errorText), limit === errorText.length);
  }

  for (const [content, retained] of [
    [{ error_code: "max_uses_exceeded", type: "web_search_tool_result_error" }, true],
    [{ error_code: "unavailable", type: "web_search_tool_result_error" }, true],
    [[], false],
    [[{ type: "web_search_result", url: "https://example.com/docs", title: "Guide",
      encrypted_content: "OPAQUE-SEARCH-CONTENT" }], false],
  ]) {
    result.content = content;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);
    const summary = next.messages[1].content;

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.equal(summary.includes("too_many_requests"), false);
    assert.equal(summary.includes("result:"), retained);
    assert.equal(summary.includes("OPAQUE-SEARCH-CONTENT"), false);

    if (retained) assert.ok(summary.includes("result: " + JSON.stringify(content)));
    assert.equal(next.messages[0], messages[0]);
    assert.equal(next.messages.at(-1), messages.at(-1));
  }
});

it("recaps short Anthropic web-fetch errors without stale diagnostics", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 500 });
  const engine = new Engine(cfg);

  const result = {
    type: "web_fetch_tool_result", tool_use_id: "srvtoolu_fetch_0",
    content: { error_code: "url_not_accessible", type: "web_fetch_tool_result_error" },
  };

  const messages = [
    aUser("Read the deployment documentation."),
    { role: "assistant", content: [
      { type: "text", text: "Fetching documentation. ".repeat(300) },
      { type: "server_tool_use", id: result.tool_use_id, name: "web_fetch", input: { url: "https://example.com/docs" } },
      result,
    ] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);
  const errorText = JSON.stringify(result.content);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: " + errorText),
    "short native web-fetch errors must survive compaction");
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  for (const limit of [errorText.length, errorText.length - 1]) {
    const ctx = new Engine(makeConfig({ ...cfg, resultMaxChars: limit })).prepare(body, ANTHROPIC);
    assert.equal(ctxOutgoingBody(ctx).messages[1].content.includes("result: " + errorText), limit === errorText.length);
  }

  for (const code of ["url_not_allowed", "unavailable"]) {
    result.content.error_code = code;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.ok(next.messages[1].content.includes("result: " + JSON.stringify(result.content)));
    assert.equal(next.messages[1].content.includes("url_not_accessible"), false);
  }

  result.content = {
    content: { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PRIVATE-PDF-BYTES" } },
    retrieved_at: null, type: "web_fetch_result", url: "https://example.com/docs",
  };
  const warm = engine.prepare(body, ANTHROPIC);
  const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
  const next = ctxOutgoingBody(warm);

  assert.deepEqual(next, ctxOutgoingBody(cold));
  assert.equal(next.messages[1].content.includes("result:"), false);
  assert.equal(next.messages[1].content.includes("PRIVATE-PDF-BYTES"), false);
  assert.equal(next.messages[0], messages[0]);
  assert.equal(next.messages.at(-1), messages.at(-1));
});

it("recaps Anthropic MCP tool inputs without stale excerpts", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, cmdMaxChars: 40 });
  const engine = new Engine(cfg);

  const call = {
    type: "mcp_tool_use", id: "mcptoolu_0", name: "read_guide", server_name: "docs",
    input: { path: "SENSITIVE-MCP-PATH-" + "x".repeat(100) },
  };

  const messages = [
    aUser("Read the deployment guide."),
    { role: "assistant", content: [call, {
      type: "mcp_tool_result", tool_use_id: call.id, is_error: false,
      content: "PRIVATE-MCP-RESULT-".repeat(300),
    }] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);

  assert.equal(first.compacted, true);
  assert.ok(ctxOutgoingBody(first).messages[1].content.includes(
    "[read_guide] " + JSON.stringify(call.input).slice(0, cfg.cmdMaxChars) + "...",
  ));
  assert.equal(JSON.stringify(ctxOutgoingBody(first)).includes("PRIVATE-MCP-RESULT"), false);
  assert.equal(ctxOutgoingBody(first).messages[0], messages[0]);
  assert.equal(ctxOutgoingBody(first).messages.at(-1), messages.at(-1));
  assert.deepEqual(ctxOutgoingBody(engine.prepare(body, ANTHROPIC)), ctxOutgoingBody(first));

  call.input.path = "[redacted]";
  const warm = engine.prepare(body, ANTHROPIC);
  const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);

  assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
  assert.ok(ctxOutgoingBody(warm).messages[1].content.includes('[read_guide] {"path":"[redacted]"}'));
  assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-MCP-PATH"), false);
});

it("recaps short Anthropic bash-code-execution results without stale diagnostics", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 220 });
  const engine = new Engine(cfg);

  const executionResult = (stdout, stderr = "", return_code = 0) => ({
    content: [], return_code, stderr, stdout, type: "bash_code_execution_result",
  });

  const result = {
    type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_bash_0",
    content: executionResult("SENSITIVE-BASH-RESULT", "SENSITIVE-BASH-ERROR", 1),
  };

  const messages = [
    aUser("Run the validation command."),
    { role: "assistant", content: [
      { type: "text", text: "Inspecting validation. ".repeat(300) },
      { type: "server_tool_use", id: result.tool_use_id, name: "bash_code_execution", input: { command: "python validate.py" } },
      result,
    ] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: " + JSON.stringify(result.content)),
    "short stdout, stderr and exit status must survive compaction");
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  const atCap = executionResult("AT-CAP-");
  atCap.stdout = atCap.stdout.padEnd(atCap.stdout.length + cfg.resultMaxChars - JSON.stringify(atCap).length, "x");
  assert.equal(JSON.stringify(atCap).length, cfg.resultMaxChars);

  for (const content of [
    executionResult("[redacted]", "[redacted]"),
    atCap,
    { ...atCap, stdout: atCap.stdout + "x" },
    { error_code: "execution_time_exceeded", type: "bash_code_execution_tool_result_error" },
  ]) {
    result.content = content;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);
    const summary = next.messages[1].content;
    const text = JSON.stringify(content);

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.equal(JSON.stringify(next).includes("SENSITIVE-BASH-"), false);
    assert.equal(next.messages[0], messages[0]);
    assert.equal(next.messages.at(-1), messages.at(-1));

    if (text.length <= cfg.resultMaxChars) {
      assert.ok(summary.includes("result: " + text));
    } else {
      assert.equal(summary.includes("result:"), false);
      assert.equal(summary.includes("AT-CAP-"), false);
    }
  }
});

it("recaps short Anthropic code-execution results without stale diagnostics", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 200 });
  const engine = new Engine(cfg);

  const executionResult = (stdout, stderr = "", return_code = 0) => ({
    content: [], return_code, stderr, stdout, type: "code_execution_result",
  });

  const result = {
    type: "code_execution_tool_result", tool_use_id: "srvtoolu_python_0",
    content: executionResult("SENSITIVE-PYTHON-RESULT", "SENSITIVE-PYTHON-ERROR", 1),
  };

  const messages = [
    aUser("Run the Python validation."),
    { role: "assistant", content: [
      { type: "text", text: "Inspecting validation. ".repeat(300) },
      { type: "server_tool_use", id: result.tool_use_id, name: "code_execution", input: { code: "print(validate())" } },
      result,
    ] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: " + JSON.stringify(result.content)),
    "short native Python stdout, stderr and exit status must survive compaction");
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  const atCap = executionResult("AT-CAP-");
  atCap.stdout = atCap.stdout.padEnd(atCap.stdout.length + cfg.resultMaxChars - JSON.stringify(atCap).length, "x");
  assert.equal(JSON.stringify(atCap).length, cfg.resultMaxChars);

  for (const content of [
    executionResult("[redacted]", "[redacted]"),
    atCap,
    { ...atCap, stdout: atCap.stdout + "x" },
    { error_code: "execution_time_exceeded", type: "code_execution_tool_result_error" },
  ]) {
    result.content = content;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);
    const summary = next.messages[1].content;
    const text = JSON.stringify(content);

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.equal(JSON.stringify(next).includes("SENSITIVE-PYTHON-"), false);
    assert.equal(next.messages[0], messages[0]);
    assert.equal(next.messages.at(-1), messages.at(-1));
    assert.equal(summary.includes("result: " + text), text.length <= cfg.resultMaxChars);

    if (text.length > cfg.resultMaxChars) assert.equal(summary.includes("result:"), false);
  }
});

it("recaps short Anthropic text-editor results without stale diagnostics or binary views", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 220 });
  const engine = new Engine(cfg);

  const errorResult = (message) => ({
    error_code: "file_not_found", error_message: message, type: "text_editor_code_execution_tool_result_error",
  });

  const viewResult = (content, file_type = "text") => ({
    content, file_type, num_lines: 1, start_line: 1, total_lines: 1, type: "text_editor_code_execution_view_result",
  });

  const result = {
    type: "text_editor_code_execution_tool_result", tool_use_id: "srvtoolu_editor_0",
    content: errorResult("SENSITIVE-EDITOR-DIAGNOSTIC"),
  };

  const messages = [
    aUser("Inspect the validation script."),
    { role: "assistant", content: [
      { type: "text", text: "Inspecting validation. ".repeat(300) },
      { type: "server_tool_use", id: result.tool_use_id, name: "text_editor_code_execution",
        input: { command: "view", path: "/workspace/validate.py" } },
      result,
    ] },
    aUser("Continue."),
    aAssistant("recent response"),
  ];

  const body = aBody(messages);
  const first = engine.prepare(body, ANTHROPIC);
  const output = ctxOutgoingBody(first);

  assert.equal(first.compacted, true);
  assert.ok(output.messages[1].content.includes("result: " + JSON.stringify(result.content)),
    "short native text-editor errors must survive compaction");
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, ANTHROPIC);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), output);

  const atCap = viewResult("AT-CAP-");
  atCap.content = atCap.content.padEnd(atCap.content.length + cfg.resultMaxChars - JSON.stringify(atCap).length, "x");
  assert.equal(JSON.stringify(atCap).length, cfg.resultMaxChars);

  for (const [content, retained] of [
    [errorResult("[redacted]"), true],
    [{ is_file_update: false, type: "text_editor_code_execution_create_result" }, true],
    [{ lines: ["validated"], new_lines: 1, new_start: 1, old_lines: 1, old_start: 1,
      type: "text_editor_code_execution_str_replace_result" }, true],
    [viewResult("print('ok')"), true],
    [atCap, true],
    [{ ...atCap, content: atCap.content + "x" }, false],
    [viewResult("PRIVATE-IMAGE-BYTES", "image"), false],
    [viewResult("PRIVATE-PDF-BYTES", "pdf"), false],
  ]) {
    result.content = content;
    const warm = engine.prepare(body, ANTHROPIC);
    const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
    const next = ctxOutgoingBody(warm);
    const summary = next.messages[1].content;

    assert.deepEqual(next, ctxOutgoingBody(cold));
    assert.equal(JSON.stringify(next).includes("SENSITIVE-EDITOR-DIAGNOSTIC"), false);
    assert.equal(next.messages[0], messages[0]);
    assert.equal(next.messages.at(-1), messages.at(-1));
    assert.equal(summary.includes("result: " + JSON.stringify(content)), retained);

    if (!retained) assert.equal(summary.includes("result:"), false);
  }
});

it("recaps short Anthropic MCP tool results and invalidates excerpts after edits", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, thoughtMaxChars: 40, resultMaxChars: 40 });
  const image = { type: "image", source: { type: "url", url: "https://example.com/private-mcp-image.png" } };

  for (const encode of [(text) => text, (text) => [{ type: "text", text }, image]]) {
    const engine = new Engine(cfg);

    const result = {
      type: "mcp_tool_result", tool_use_id: "mcptoolu_0", is_error: false,
      content: encode("SENSITIVE-MCP-RESULT"),
    };

    const messages = [
      aUser("Read the deployment status."),
      { role: "assistant", content: [
        { type: "text", text: "Inspecting deployment. ".repeat(300) },
        { type: "mcp_tool_use", id: result.tool_use_id, name: "status", server_name: "deploy", input: {} },
        result,
      ] },
      aUser("Continue."),
      aAssistant("recent response"),
    ];

    const body = aBody(messages);
    const first = engine.prepare(body, ANTHROPIC);
    const firstOutput = ctxOutgoingBody(first);

    assert.equal(first.compacted, true);
    assert.ok(firstOutput.messages[1].content.includes("result: SENSITIVE-MCP-RESULT"));
    assert.equal(firstOutput.messages[0], messages[0]);
    assert.equal(firstOutput.messages.at(-1), messages.at(-1));

    for (const [content, expected] of [
      [encode("[redacted]"), "[redacted]"],
      [encode("AT-CAP-".padEnd(cfg.resultMaxChars, "x")), "AT-CAP-".padEnd(cfg.resultMaxChars, "x")],
      [encode("OVER-CAP-".padEnd(cfg.resultMaxChars + 1, "x")), null],
      [[], null],
      [[image], null],
    ]) {
      const oldDigest = ANTHROPIC.digestMessage(messages[1]);
      result.content = content;
      assert.notEqual(ANTHROPIC.digestMessage(messages[1]), oldDigest);
      const warm = engine.prepare(body, ANTHROPIC);
      const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
      const output = ctxOutgoingBody(warm);
      const summary = output.messages[1].content;

      assert.deepEqual(output, ctxOutgoingBody(cold));
      assert.equal(JSON.stringify(output).includes("SENSITIVE-MCP-RESULT"), false);
      assert.equal(summary.includes("private-mcp-image"), false);

      if (expected === null) {
        assert.equal(summary.includes("result:"), false);
      } else {
        assert.ok(summary.includes("result: " + expected));
      }
    }
  }
});

it("recaps legacy Chat Completions function calls without stale arguments", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, cmdMaxChars: 40 });
  const engine = new Engine(cfg);
  const call = { name: "exec_command", arguments: JSON.stringify({ command: "SENSITIVE-LEGACY-COMMAND-" + "x".repeat(100) }) };

  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: null, function_call: call },
    { role: "function", name: call.name, content: "x".repeat(5000) },
    { role: "assistant", content: "recent response" },
  ];

  const body = { model: "gpt-4", messages };
  const first = engine.prepare(body, OPENAI);
  const firstOutput = ctxOutgoingBody(first);

  assert.equal(first.compacted, true);
  assert.ok(firstOutput.messages[1].content.includes("[exec_command] " + call.arguments.slice(0, cfg.cmdMaxChars) + "..."));
  assert.equal(firstOutput.messages[1].content.includes(call.arguments), false);
  assert.equal(firstOutput.messages[0], messages[0]);
  assert.equal(firstOutput.messages.at(-1), messages.at(-1));
  const cached = engine.prepare(body, OPENAI);
  assert.equal(cached.compacted, false);
  assert.deepEqual(ctxOutgoingBody(cached), firstOutput);

  const oldDigest = OPENAI.digestMessage(messages[1]);
  call.arguments = JSON.stringify({ command: "[redacted]" });
  assert.notEqual(OPENAI.digestMessage(messages[1]), oldDigest);
  const warm = engine.prepare(body, OPENAI);
  const cold = new Engine(cfg).prepare(structuredClone(body), OPENAI);
  const output = ctxOutgoingBody(warm);

  assert.deepEqual(output, ctxOutgoingBody(cold));
  assert.ok(output.messages[1].content.includes("[exec_command] " + call.arguments));
  assert.equal(JSON.stringify(output).includes("SENSITIVE-LEGACY-COMMAND"), false);
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages.at(-1), messages.at(-1));
});

it("recaps Chat Completions custom tool inputs and invalidates excerpts after edits", () => {
  const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, cmdMaxChars: 40 });
  const engine = new Engine(cfg);
  const custom = { id: "custom_0", type: "custom", custom: { name: "apply_patch", input: "SENSITIVE-PATCH" } };

  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: null, tool_calls: [custom] },
    { role: "tool", tool_call_id: "custom_0", content: "x".repeat(5000) },
    { role: "assistant", content: "recent response" },
  ];

  const body = { model: "gpt-5", messages };
  const first = engine.prepare(body, OPENAI);

  assert.equal(first.compacted, true);
  assert.ok(ctxOutgoingBody(first).messages[1].content.includes("[apply_patch] SENSITIVE-PATCH"));
  assert.equal(ctxOutgoingBody(first).messages.at(-1), messages.at(-1));

  for (const change of ["input", "name"]) {
    const oldDigest = OPENAI.digestMessage(messages[1]);
    custom.custom[change] = change === "input" ? "[redacted]" : "safe_patch";
    assert.notEqual(OPENAI.digestMessage(messages[1]), oldDigest);
    const warm = engine.prepare(body, OPENAI);
    const cold = new Engine(cfg).prepare(structuredClone(body), OPENAI);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(ctxOutgoingBody(warm).messages[1].content.includes("[" + custom.custom.name + "] [redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-PATCH"), false);
  }

  custom.custom.input = "LONG-PATCH-" + "x".repeat(100);
  const capped = new Engine(cfg).prepare(body, OPENAI);
  assert.ok(ctxOutgoingBody(capped).messages[1].content.includes("[safe_patch] " + custom.custom.input.slice(0, 40) + "..."));
  assert.equal(ctxOutgoingBody(capped).messages[1].content.includes(custom.custom.input), false);
});

it("keepRecent zero compacts complete tool turns, including results appended to a cached call", () => {
  const cases = [
    [OPENAI, { role: "assistant", content: "x".repeat(5000), tool_calls: [
      { id: "call_0", type: "function", function: { name: "bash", arguments: "{}" } },
    ] }, { role: "tool", tool_call_id: "call_0", content: "Important result" }],
    [ANTHROPIC, aAssistant("x".repeat(5000), ["call_0", "bash", {}]), aResult("call_0", "Important result")],
    [PI, { role: "assistant", content: [
      { type: "text", text: "x".repeat(5000) },
      { type: "toolCall", id: "call_0", name: "bash", arguments: {} },
    ] }, { role: "toolResult", toolCallId: "call_0", toolName: "bash", content: "Important result" }],
    [RESPONSES, { type: "function_call", call_id: "call_0", name: "bash", arguments: "x".repeat(5000) },
      { type: "function_call_output", call_id: "call_0", output: "Important result" }],
  ];

  for (const [dialect, call, result] of cases) {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 0, thoughtMaxChars: 20, cmdMaxChars: 20 });
    const head = dialect.userMessage("task");
    const body = { [dialect.messagesKey]: [head, call, result] };

    for (const warm of [false, true]) {
      const engine = new Engine(cfg);

      if (warm) engine.prepare({ [dialect.messagesKey]: [head, call] }, dialect);
      const ctx = engine.prepare(body, dialect);
      const messages = ctxOutgoingBody(ctx)[dialect.messagesKey];

      assert.equal(ctx.compacted, true, dialect.name);
      assert.equal(ctx.baseCut, 3, dialect.name);
      assert.equal(messages.length, 2, dialect.name);
      assert.equal(messages[0], head);
      assert.ok(JSON.stringify(messages[1]).includes("result: Important result"), dialect.name);
      assert.equal(messages.includes(result), false, dialect.name);
    }
  }
});

describe("engine pipeline", () => {
  it("estTokensIn matches estimateTokens of the request body", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000 }));
    const body = aBody(aSession(8));
    const ctx = engine.prepare(body, ANTHROPIC);

    assert.equal(ctx.estTokensIn, estimateTokens(body));
    assert.equal(ctx.estTokensOut, estimateTokens(body));
  });

  it("passes through under threshold", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000 }));
    const ctx = engine.prepare(aBody(aSession(4)), ANTHROPIC);

    assert.equal(ctx.modified, false);
    assert.deepEqual(ctxOutgoingBody(ctx).messages, aSession(4));
  });

  it("compacts, stores, and substitutes the original tail", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    const ctx1 = engine.prepare(aBody(msgs), ANTHROPIC);

    assert.equal(ctx1.compacted && ctx1.modified, true);
    assert.equal(nSummaries(ctx1.substituted), 1);
    assert.equal(engine.store.size, 1);
    assert.ok(ctx1.estTokensOut < ctx1.estTokensIn);

    const msgs2 = grow(msgs, 10, 1, 10);
    const ctx2 = engine.prepare(aBody(msgs2), ANTHROPIC);

    assert.equal(ctx2.modified, true);
    const out = ctx2.substituted;
    assert.equal(out[0], msgs2[0]);
    assert.ok(String(out[1].content).startsWith(SUMMARY_HEADER));
    assert.equal(out[out.length - 1], msgs2[msgs2.length - 1]);
    assert.deepEqual(out.slice(2), msgs2.slice(ctx2.baseCut));
  });

  it("recompacts flat and matches the deepest prefix", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    engine.prepare(aBody(msgs), ANTHROPIC);

    const msgs2 = grow(msgs, 10, 8);
    const ctx = engine.prepare(aBody(msgs2), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    assert.equal(nSummaries(ctx.substituted), 1);
    assert.equal(ctx.substituted[0], msgs2[0]);
    assert.equal(ctx.substituted[ctx.substituted.length - 1], msgs2[msgs2.length - 1]);
    assert.equal(engine.store.size, 2);

    const msgs3 = grow(msgs2, 18, 1, 10);
    const ctx3 = engine.prepare(aBody(msgs3), ANTHROPIC);

    assert.ok(ctx3.baseCut > msgs.length);
    assert.equal(nSummaries(ctx3.substituted), 1);
  });

  it("lets diverging branches share a stored prefix", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    engine.prepare(aBody(msgs), ANTHROPIC);

    const branchA = grow(msgs, 10, 1, 10);
    const branchB = msgs.concat([aAssistant("different continuation", null)]);
    const ctxA = engine.prepare(aBody(branchA), ANTHROPIC);
    const ctxB = engine.prepare(aBody(branchB), ANTHROPIC);

    assert.equal(ctxA.modified && ctxB.modified, true);
    assert.equal(ctxA.substituted[ctxA.substituted.length - 1], branchA[branchA.length - 1]);
    assert.equal(ctxB.substituted[ctxB.substituted.length - 1], branchB[branchB.length - 1]);
  });

  it("fail-opens when history mutation breaks the prefix match", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const msgs = aSession(10);
    engine.prepare(aBody(msgs), ANTHROPIC);

    const mutated = msgs.map((m) => ({ ...m }));
    mutated[3] = { role: "user", content: "history rewritten by scaffold" };
    const small = new Engine(makeConfig({ thresholdTokens: 1_000_000 }), engine.store);
    const ctx = small.prepare(aBody(mutated), ANTHROPIC);

    assert.equal(ctx.modified, false);
  });

  it("revalidates in-place redactions before reusing a stored summary", () => {
    for (const append of [false, true]) {
      const cfg = makeConfig({ thresholdTokens: 2_000 });
      const engine = new Engine(cfg);
      const msgs = aSession(12, 3000);
      msgs[16].content[0].content = "SENSITIVE-EXAMPLE";
      const first = engine.prepare(aBody(msgs), ANTHROPIC);

      assert.equal(first.compacted, true);
      assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-EXAMPLE"));

      msgs[16].content[0].content = "[redacted]";

      if (append) {
        msgs.push(aAssistant("continuation", null));
      }

      const body = aBody(msgs);
      const next = engine.prepare(body, ANTHROPIC);
      const fresh = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);
      const output = JSON.stringify(ctxOutgoingBody(next));

      assert.equal(output.includes("SENSITIVE-EXAMPLE"), false);
      assert.ok(output.includes("[redacted]"));
      assert.deepEqual(ctxOutgoingBody(next), ctxOutgoingBody(fresh));
      assert.deepEqual(next.chain, fresh.chain);
      assert.equal(next.estTokensIn, estimateTokens(body));
      assert.equal(next.estTokensOut, estimateTokens(ctxOutgoingBody(next)));
    }
  });

  it("isolates cached summaries from outgoing request edits", () => {
    for (const dialect of [ANTHROPIC, OPENAI, RESPONSES, PI]) {
      const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
      const engine = new Engine(cfg);
      const output = "x".repeat(5000);

      const result = dialect === ANTHROPIC ? aResult("c0", output)
        : dialect === OPENAI ? { role: "tool", tool_call_id: "c0", content: output }
        : dialect === RESPONSES ? { type: "function_call_output", call_id: "c0", output }
        : { role: "toolResult", toolCallId: "c0", toolName: "bash", content: output };

      const call = dialect === ANTHROPIC ? aAssistant("Original finding", ["c0", "bash", {}])
        : dialect === OPENAI ? { role: "assistant", content: "Original finding", tool_calls: [
          { id: "c0", type: "function", function: { name: "bash", arguments: "{}" } },
        ] }
        : dialect === RESPONSES ? { type: "function_call", call_id: "c0", name: "bash", arguments: "{}" }
        : { role: "assistant", content: [{ type: "text", text: "Original finding" },
          { type: "toolCall", id: "c0", name: "bash", arguments: {} }] };

      const messages = [dialect.userMessage("task"), call, result,
        { role: "assistant", content: "recent response" }];

      const body = { [dialect.messagesKey]: messages };
      const expected = ctxOutgoingBody(new Engine(cfg).prepare(structuredClone(body), dialect));
      const first = engine.prepare(body, dialect);

      assert.equal(first.compacted, true, dialect.name);

      for (let pass = 0; pass < 2; pass++) {
        const ctx = pass === 0 ? first : engine.prepare(body, dialect);
        const summary = ctxOutgoingBody(ctx)[dialect.messagesKey][ctx.baseHead];

        if (Array.isArray(summary.content)) {
          summary.content[0].text = "REQUEST-LOCAL-REPLACEMENT";
        } else {
          summary.content = "REQUEST-LOCAL-REPLACEMENT";
        }

        const next = engine.prepare(body, dialect);
        assert.deepEqual(ctxOutgoingBody(next), expected, dialect.name);
        assert.equal(ctxOutgoingBody(next)[dialect.messagesKey][0], messages[0]);
        assert.equal(ctxOutgoingBody(next)[dialect.messagesKey].at(-1), messages.at(-1));
      }
    }
  });

  it("refreshes budget estimates for canonical-equivalent message edits", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000 }));
    const body = aBody(aSession(4));
    const initial = engine.prepare(body, ANTHROPIC);
    body.messages[0].content = [{ type: "text", text: body.messages[0].content }];
    body.messages[1].content[0].cache_control = { type: "ephemeral" };
    const next = engine.prepare(body, ANTHROPIC);

    assert.deepEqual(next.chain, initial.chain);
    assert.notEqual(estimateTokens(body), initial.estTokensIn);
    assert.equal(next.estTokensIn, estimateTokens(body));
    assert.equal(next.estTokensOut, estimateTokens(ctxOutgoingBody(next)));
  });

  it("invalidates stored Chat Completions summaries when a refusal changes", () => {
    for (const replacement of ["[redacted]", null]) {
      const engine = new Engine(makeConfig({ thresholdTokens: 2_000 }));
      const body = oBody(oSession(12));
      body.messages[16].refusal = "SENSITIVE-REFUSAL";
      const first = engine.prepare(body, OPENAI);

      assert.ok(first.compacted);
      assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-REFUSAL"));
      body.messages[16].refusal = replacement;
      const next = engine.prepare(body, OPENAI);
      const fresh = new Engine(engine.cfg).prepare(structuredClone(body), OPENAI);

      assert.equal(JSON.stringify(ctxOutgoingBody(next)).includes("SENSITIVE-REFUSAL"), false);
      assert.deepEqual(ctxOutgoingBody(next), ctxOutgoingBody(fresh));

      if (replacement !== null) {
        assert.ok(JSON.stringify(ctxOutgoingBody(next)).includes(replacement));
      }
    }
  });

  it("does not reuse summaries after reasoning is redacted or removed", () => {
    for (const key of ["reasoning_content", "reasoning"]) {
      for (const replacement of ["[redacted]", null]) {
        const engine = new Engine(makeConfig({ thresholdTokens: 2_000 }));
        const body = oBody(oSession(12));
        body.messages[16][key] = "SENSITIVE-REASONING";
        const first = engine.prepare(body, OPENAI);

        assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-REASONING"));
        body.messages[16][key] = replacement;
        const next = engine.prepare(body, OPENAI);
        const fresh = new Engine(engine.cfg).prepare(structuredClone(body), OPENAI);

        assert.equal(JSON.stringify(ctxOutgoingBody(next)).includes("SENSITIVE-REASONING"), false);
        assert.deepEqual(ctxOutgoingBody(next), ctxOutgoingBody(fresh));
      }
    }
  });

  it("revalidates nested text in every built-in dialect", () => {
    for (const dialect of [ANTHROPIC, OPENAI, RESPONSES, PI]) {
      const msgs = [dialect.userMessage("Fix the failing test.")];

      for (let i = 0; i < 12; i++) {
        msgs.push({
          role: "assistant",
          content: [{ type: dialect === RESPONSES ? "output_text" : "text", text: "Step " + i }],
        });
        msgs.push(dialect.userMessage("X".repeat(3000)));
      }

      const engine = new Engine(makeConfig({ thresholdTokens: 2_000, humanMaxChars: 100 }));
      const body = { [dialect.messagesKey]: msgs };
      msgs[19].content[0].text = "SENSITIVE-NESTED-TEXT";
      const first = engine.prepare(body, dialect);

      assert.ok(first.compacted);
      assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-NESTED-TEXT"));
      msgs[19].content[0].text = "[redacted]";
      const next = engine.prepare(body, dialect);
      const fresh = new Engine(engine.cfg).prepare(structuredClone(body), dialect);

      assert.equal(JSON.stringify(ctxOutgoingBody(next)).includes("SENSITIVE-NESTED-TEXT"), false);
      assert.deepEqual(ctxOutgoingBody(next), ctxOutgoingBody(fresh));
    }
  });

  it("reactively compact regardless of threshold", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 1_000_000, keepRecent: 1 }));
    const ctx = engine.prepare(aBody(aSession(10)), ANTHROPIC);

    assert.equal(ctx.modified, false);
    assert.equal(engine.reactive(ctx), true);
    assert.equal(ctx.compacted, true);
    assert.equal(nSummaries(ctx.substituted), 1);
  });

  it("replays a long history to a bounded recent-only summary", () => {
    const cfg = makeConfig({ thresholdTokens: 2_000, keepRecent: 1 });
    const live = new Engine(cfg);
    let msgs = aSession(2);
    let liveCtx = null;

    for (let i = 2; i < 60; i++) {
      liveCtx = live.prepare(aBody(msgs), ANTHROPIC);
      msgs = grow(msgs, i, 1);
    }

    let liveSummary = "";

    for (const m of liveCtx.substituted) {
      if (nSummaries([m])) {
        liveSummary = m.content;
      }
    }

    const fresh = new Engine(cfg);
    const ctx = fresh.prepare(aBody(msgs), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    let freshSummary = "";

    for (const m of ctx.substituted) {
      if (nSummaries([m])) {
        freshSummary = m.content;
      }
    }

    assert.equal(nSummaries(ctx.substituted), 1);
    assert.equal(freshSummary.includes("Step 2"), false);
    assert.equal(freshSummary.includes("Step 10"), false);
    assert.ok(freshSummary.length < 3 * Math.max(liveSummary.length, 1000));
    assert.ok(ctx.estTokensOut <= cfg.thresholdTokens * 2);
  });

  it("terminates the reactive ladder", () => {
    const engine = new Engine(makeConfig({ thresholdTokens: 2_000, keepRecent: 1 }));
    const ctx = engine.prepare(aBody(aSession(10)), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    let attempts = 0;

    while (engine.reactive(ctx) && attempts < 10) {
      attempts += 1;
    }

    assert.ok(attempts <= 4);
    assert.equal(engine.reactive(ctx), false);
    assert.equal(engine.reactive(ctx), false);
  });

  it("keeps an empty store it was handed", () => {
    const mine = new PrefixStore(7, 1234);
    const engine = new Engine(makeConfig({}), mine);

    assert.equal(engine.store, mine);
    assert.equal(engine.store.maxBytesLimit, 1234);
  });

  it("builds its store from config", () => {
    const engine = new Engine(makeConfig({ storeMaxEntries: 9, storeMaxBytes: 4321 }));

    assert.equal(engine.store.max, 9);
    assert.equal(engine.store.maxBytesLimit, 4321);
  });
});

describe("proactive escalation", () => {
  function fatSession(nTurns, resultChars = 6000) {
    const msgs = [{ role: "user", content: "the task: fix the bug" }];

    for (let i = 0; i < nTurns; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "text", text: "thought " + i + ": " + "y".repeat(2000) },
          { type: "tool_use", id: "t" + i, name: "bash", input: { command: "make " + i } },
        ],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t" + i, content: "R".repeat(resultChars) }],
      });
    }

    return msgs;
  }

  it("escalates keepRecent when the floor is over threshold", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 4000, keepRecent: 3 }));
    const ctx = eng.prepare(aBody(fatSession(8)), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    assert.ok(ctx.rung >= 1);
    assert.ok(ctx.estTokensOut <= 4000);
    assert.equal(ctx.substituted.filter((m) => m.role === "assistant").length, 1);
  });

  it("compacts few giant turns via rung 1", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 3000, keepRecent: 3 }));
    const ctx = eng.prepare(aBody(fatSession(3)), ANTHROPIC);

    assert.equal(ctx.compacted, true);
    assert.ok(ctx.rung >= 1);
    assert.ok(ctx.substituted.length < ctx.msgs.length);
  });

  it("soft-sends a giant live turn without throwing", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 3 }));
    const ctx = eng.prepare(aBody(fatSession(1, 40000)), ANTHROPIC);

    assert.ok(ctxOutgoingBody(ctx));
  });

  it("does not escalate without assistant turns", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 100, keepRecent: 3 }));
    const ctx = eng.prepare(aBody([{ role: "user", content: "x".repeat(30000) }]), ANTHROPIC);

    assert.equal(ctx.compacted, false);
    assert.equal(ctx.modified, false);
    assert.equal(ctx.rung, 0);
  });

  it("stays under budget under strict after thought-cap escalation", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 1, strict: true }));
    const ctx = eng.prepare(aBody(fatSession(10, 300)), ANTHROPIC);

    assert.ok(ctx.rung >= 2);
    assert.equal(ctx.overBudget, false);
    assert.ok(ctx.estTokensOut <= 1000);
  });

  it("stops the default ladder at rung 2", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 1 }));
    const ctx = eng.prepare(aBody(fatSession(10, 300)), ANTHROPIC);

    assert.ok(ctx.rung <= 2);
  });

  it("rung 2 recaps original thoughts when keepRecent is already 1", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 1 }));
    const ctx = eng.prepare(aBody(fatSession(10, 300)), ANTHROPIC);
    const summary = String(ctx.substituted.find((m) => String(m.content).startsWith(SUMMARY_HEADER))?.content ?? "");

    assert.equal(ctx.compacted, true);
    assert.equal(ctx.rung, 2);
    assert.equal(summary.includes("y".repeat(2000)), false);
    assert.equal(/y+\.\.\./.test(summary), true);
    assert.ok(ctx.estTokensOut <= 1000);
  });

  it("does not raise keepRecent from 0 during escalation", () => {
    const giant = "R".repeat(40_000);
    const eng = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 0 }));
    const ctx = eng.prepare(aBody(fatSession(10, 40_000)), ANTHROPIC);
    const out = JSON.stringify(ctxOutgoingBody(ctx));

    assert.equal(ctx.compacted, true);
    assert.equal(out.includes(giant), false);
    assert.equal(ctx.substituted.filter((m) => m.role === "assistant").length, 0);
  });

  it("clears overBudget when under threshold", () => {
    const eng = new Engine(makeConfig({ thresholdTokens: 4000, keepRecent: 3, strict: true }));
    const ctx = eng.prepare(aBody(fatSession(8)), ANTHROPIC);

    assert.equal(ctx.overBudget, false);
  });
});

it("wire-budget packing keeps the maximal fitting newest suffix", () => {
  const parts = ["older: " + "x".repeat(100), "quoted: \"\\\u0001", "newest: 😀"];
  const expected = SUMMARY_HEADER + "\n\n" + parts.slice(1).join("\n\n---\n\n");
  const bill = (text) => estimateTokens({ messages: [ANTHROPIC.userMessage(text)] });
  const packed = fitSummary(SUMMARY_HEADER, parts, (text) => bill(text) <= bill(expected));

  assert.equal(packed, expected);
  assert.equal(fitSummary(SUMMARY_HEADER, parts, () => false), SUMMARY_HEADER);
});

it("preserves special JSON request keys through compaction and strict packing", () => {
  for (const strict of [false, true]) {
    const piece = ("x" + "\u0001").repeat(40);

    const msgs = strict
      ? [aUser("task"), aAssistant("s0", ["t0", "bash", { command: "c0" }]), aResult("t0", piece),
        aAssistant("done?", ["tz", "bash", { command: "true" }]), aResult("tz", "ok")]
      : aSession(12);

    const body = { ...aBody(msgs), ...JSON.parse('{"__proto__":{"metadata":"' + "x".repeat(200) + '"}}') };
    const engine = new Engine(makeConfig({ thresholdTokens: strict ? 196 : 2000, keepRecent: 1, strict }));
    const ctx = engine.prepare(body, ANTHROPIC);
    const out = ctxOutgoingBody(ctx);

    assert.equal(ctx.compacted, true);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
    assert.deepEqual(out.__proto__, body.__proto__);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(ctx.estTokensOut, estimateTokens(out));

    if (strict) {
      assert.equal(ctx.rung, 3);
      assert.ok(ctx.estTokensOut <= engine.cfg.thresholdTokens);
      assert.equal(ctx.overBudget, false);
    }
  }
});

it("compacts tool arguments with constructor keys as ordinary JSON data", () => {
  for (const dialect of [ANTHROPIC, PI]) {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const engine = new Engine(cfg);
    const input = JSON.parse('{"constructor":"SENSITIVE-CONSTRUCTOR","properties":{"constructor":null}}');

    const call = dialect === ANTHROPIC
      ? aAssistant("Inspect the schema.", ["c0", "build_schema", input])
      : { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "build_schema", arguments: input }] };

    const result = dialect === ANTHROPIC
      ? aResult("c0", "x".repeat(5000))
      : { role: "toolResult", toolCallId: "c0", toolName: "build_schema", content: "x".repeat(5000) };

    const messages = [dialect.userMessage("Build the requested schema."), call, result,
      { role: "assistant", content: "recent response" }];

    const body = { messages };
    const first = engine.prepare(body, dialect);
    const output = ctxOutgoingBody(first);

    assert.equal(first.compacted, true, dialect.name);
    assert.ok(output.messages[1].content.includes('[build_schema] {"constructor":"SENSITIVE-CONSTRUCTOR","properties":{"constructor":null}}'));
    assert.equal(first.estTokensIn, estimateTokens(body));
    assert.equal(output.messages[0], messages[0]);
    assert.equal(output.messages.at(-1), messages.at(-1));
    assert.deepEqual(ctxOutgoingBody(engine.prepare(body, dialect)), output);

    input.constructor = "[redacted]";
    const warm = engine.prepare(body, dialect);
    const cold = new Engine(cfg).prepare(structuredClone(body), dialect);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(ctxOutgoingBody(warm).messages[1].content.includes('[build_schema] {"constructor":"[redacted]","properties":{"constructor":null}}'));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-CONSTRUCTOR"), false);
  }
});

it("counts special JSON keys as request data rather than changing prototypes", () => {
  const body = JSON.parse('{"messages":[{"role":"user","content":"hi"}],"__proto__":{"metadata":"' + "x".repeat(2000) + '"}}');
  const engine = new Engine(makeConfig({ thresholdTokens: 100 }));
  const ctx = engine.prepare(body, ANTHROPIC);

  assert.equal(ctx.estTokensIn, estimateTokens(body));
  assert.equal(ctx.estTokensOut, estimateTokens(ctxOutgoingBody(ctx)));
  assert.equal(ctx.overBudget, true);
  assert.equal(Object.hasOwn(ctxOutgoingBody(ctx), "__proto__"), true);
  assert.equal(Object.getPrototypeOf(body), Object.prototype);
});
