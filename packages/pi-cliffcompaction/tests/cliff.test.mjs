import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compact, groupTurns } from "../lib/cliff.ts";
import { makeConfig } from "../lib/config.ts";
import { DIALECT as ANTHROPIC } from "../lib/dialects/anthropic.ts";
import { SUMMARY_HEADER } from "../lib/dialects/base.ts";
import { DIALECT as OPENAI } from "../lib/dialects/openai-chat.ts";
import { DIALECT as RESPONSES } from "../lib/dialects/openai-responses.ts";
import { DIALECT as PI } from "../lib/dialects/pi.ts";
import { aAssistant, aResult, aSession, aUser, oSession } from "./util.mjs";

function cfg(patch) {
  return makeConfig(patch);
}

describe("structure", () => {
  it("keeps anthropic head, one summary, last 2 turns verbatim", () => {
    const msgs = aSession(10);
    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 2 }));

    assert.ok(res);
    const out = res.messages;
    assert.equal(out[0], msgs[0]);
    assert.equal(out[1].role, "user");
    assert.ok(String(out[1].content).startsWith(SUMMARY_HEADER));
    assert.deepEqual(out.slice(2), msgs.slice(-4));
    assert.equal(out[2], msgs[msgs.length - 4]);
    assert.deepEqual(msgs.slice(res.cut), msgs.slice(-4));
    assert.equal(out[2].role, "assistant");
  });

  it("keeps openai system+task head and last 2 turns", () => {
    const msgs = oSession(10);
    const res = compact(msgs, OPENAI, cfg({ keepRecent: 2 }));

    assert.ok(res);
    const out = res.messages;
    assert.equal(out[0], msgs[0]);
    assert.equal(out[1], msgs[1]);
    assert.ok(String(out[2].content).startsWith(SUMMARY_HEADER));
    assert.deepEqual(out.slice(3), msgs.slice(-4));
    assert.equal(out[3].role, "assistant");
  });

  it("returns null when there are not enough turns", () => {
    assert.equal(compact(aSession(2), ANTHROPIC, cfg({ keepRecent: 3 })), null);
  });

  it("returns null when there is no assistant yet", () => {
    assert.equal(compact([aUser("task")], ANTHROPIC, cfg({ keepRecent: 1 })), null);
  });

  it("keepRecent 0 recaps a single giant assistant turn when caps shrink it", () => {
    const giant = "Y".repeat(4000);
    const msgs = [aUser("task"), { role: "assistant", content: giant }];

    assert.equal(compact(msgs, ANTHROPIC, cfg({ keepRecent: 0 })), null);

    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 0, thoughtMaxChars: 300 }));

    assert.ok(res);
    assert.equal(res.cut, msgs.length);
    assert.equal(res.messages.length, 2);
    assert.equal(String(res.messages[1].content).includes(giant), false);
    assert.ok(String(res.messages[1].content).includes("Y".repeat(300) + "..."));
  });
});

describe("content classes", () => {
  it("retains Chat Completions refusals as capped assistant text", () => {
    const refusal = "I cannot perform that action.";

    for (const [assistant, text] of [
      [{ role: "assistant", content: null, refusal }, refusal],
      [{ role: "assistant", content: [{ type: "refusal", refusal }] }, refusal],
      [{ role: "assistant", content: "Here is a safe alternative.", refusal }, "Here is a safe alternative.\n" + refusal],
    ]) {
      const msgs = [
        { role: "user", content: "task" }, assistant,
        { role: "user", content: "Please use the safe alternative." },
        { role: "assistant", content: "recent response" },
      ];

      const full = compact(msgs, OPENAI, cfg({ keepRecent: 1, keepThinking: false }));

      const capped = compact(msgs, OPENAI, cfg({ keepRecent: 1, thoughtMaxChars: 10 }));

      assert.ok(full.summary.content.includes("assistant: " + text));
      assert.ok(capped.summary.content.includes("assistant: " + text.slice(0, 10) + "..."));
      assert.deepEqual(full.messages.slice(-1), msgs.slice(-1));
    }
  });

  it("drops long tool results and keeps short ones", () => {
    const res = compact(aSession(10, 3000), ANTHROPIC, cfg({ keepRecent: 1 }));
    const summary = res.messages[1].content;

    assert.equal(summary.includes("X".repeat(600)), false);
    assert.ok(summary.includes("result: test_1 passed (short output)"));
  });

  it("retains legacy Chat Completions function results within resultMaxChars", () => {
    const short = "status: READY";
    const boundary = "boundary result".padEnd(40, ".");
    const oversized = "oversized result".padEnd(41, ".");
    const recentCall = { role: "assistant", content: null, function_call: { name: "recent", arguments: "{}" } };
    const recentResult = { role: "function", name: "recent", content: "recent result" };
    const msgs = [{ role: "user", content: "task" }];

    for (const [name, content] of [["short", " \n" + short + "\n "], ["boundary", boundary], ["oversized", oversized]]) {
      msgs.push({ role: "assistant", content: null, function_call: { name, arguments: "{}" } });
      msgs.push({ role: "function", name, content });
    }

    msgs.push(recentCall, recentResult);
    const res = compact(msgs, OPENAI, cfg({ keepRecent: 1, resultMaxChars: 40 }));

    assert.ok(res);
    assert.equal(res.summary.content, SUMMARY_HEADER + "\n\n" + [
      "[short] {}", "result: " + short,
      "[boundary] {}", "result: " + boundary,
      "[oversized] {}",
    ].join("\n\n---\n\n"));
    assert.equal(res.messages[0], msgs[0]);
    assert.equal(res.messages.at(-2), recentCall);
    assert.equal(res.messages.at(-1), recentResult);
    assert.equal(res.cut, msgs.length - 2);
  });

  it("truncates tool signatures to cmdMaxChars plus ellipsis", () => {
    const res = compact(aSession(6), ANTHROPIC, cfg({ keepRecent: 1, cmdMaxChars: 20 }));
    const summary = res.messages[1].content;

    assert.ok(summary.includes("[bash]"));

    for (const line of summary.split("\n")) {
      if (line.startsWith("[bash] ")) {
        assert.ok(line.length <= "[bash] ".length + 23);
      }
    }
  });

  it("keeps assistant text in full by default", () => {
    const longThought = "T".repeat(2000);

    const msgs = [
      aUser("task"),
      aAssistant(longThought, ["t0", "bash", { command: "ls" }]),
      aResult("t0", "ok"),
      aAssistant("done", null),
      aResult("t0", "bye"),
    ];

    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));

    assert.ok(res.messages[1].content.includes(longThought));
  });

  it("caps assistant text when thoughtMaxChars is set", () => {
    const longThought = "T".repeat(2000);

    const msgs = [
      aUser("task"),
      aAssistant(longThought, ["t0", "bash", { command: "ls" }]),
      aResult("t0", "ok"),
      aAssistant("done", null),
      aResult("t0", "bye"),
    ];

    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1, thoughtMaxChars: 300 }));
    const summary = res.messages[1].content;

    assert.equal(summary.includes(longThought), false);
    assert.ok(summary.includes("T".repeat(300) + "..."));
  });

  it("keeps human text verbatim even when longer than result cap", () => {
    const msgs = aSession(8);
    const human = "IMPORTANT: use the staging database, never prod. ".repeat(20);
    msgs.splice(5, 0, aUser(human));
    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));

    assert.ok(res.messages[1].content.includes(human.trim()));
  });

  it("keeps mixed-message human text and drops the long tool result", () => {
    const longOut = "Z".repeat(5000);

    const mixed = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t0", content: longOut },
        { type: "text", text: "actually, stop and use branch dev-2" },
      ],
    };

    const msgs = [
      aUser("task"),
      aAssistant("step 0", ["t0", "bash", { command: "ls" }]),
      mixed,
      aAssistant("step 1", ["t1", "bash", { command: "pwd" }]),
      aResult("t1", "ok"),
      aAssistant("step 2", ["t2", "bash", { command: "id" }]),
      aResult("t2", "ok"),
    ];

    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));
    const summary = res.messages[1].content;

    assert.ok(summary.includes("actually, stop and use branch dev-2"));
    assert.equal(summary.includes(longOut), false);
  });
});

function thinkingSession() {
  return [
    aUser("task"),
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "The mock is not reset between cases, that is the real bug.",
          signature: "EqQBCgIYAsignedblob",
        },
        { type: "text", text: "step 0 visible text" },
        { type: "tool_use", id: "t0", name: "bash", input: { command: "ls" } },
      ],
    },
    aResult("t0", "ok"),
    aAssistant("step 1", ["t1", "bash", { command: "pwd" }]),
    aResult("t1", "ok"),
    aAssistant("step 2", null),
    aResult("t2", "ok"),
  ];
}

describe("thinking", () => {
  it("keeps thinking as text and drops the signature", () => {
    const res = compact(thinkingSession(), ANTHROPIC, cfg({ keepRecent: 1 }));
    const summary = res.messages[1].content;

    assert.ok(summary.includes("thinking: The mock is not reset between cases"));
    assert.ok(summary.includes("step 0 visible text"));
    assert.equal(summary.includes("signedblob"), false);
  });

  it("applies thought and thinking caps independently", () => {
    const summary = compact(thinkingSession(), ANTHROPIC, cfg({ keepRecent: 1, thoughtMaxChars: 10 }))
      .messages[1].content;

    assert.ok(summary.includes("thinking: The mock is not reset between cases, that is the real bug."));
    assert.ok(summary.includes("step 0 vis..."));

    const summary2 = compact(
      thinkingSession(),
      ANTHROPIC,
      cfg({ keepRecent: 1, thinkingMaxChars: 12 }),
    ).messages[1].content;

    assert.ok(summary2.includes("thinking: The mock is ..."));
    assert.ok(summary2.includes("step 0 visible text"));
  });

  it("can drop thinking entirely", () => {
    const summary = compact(thinkingSession(), ANTHROPIC, cfg({ keepRecent: 1, keepThinking: false }))
      .messages[1].content;

    assert.equal(summary.includes("thinking:"), false);
    assert.ok(summary.includes("step 0 visible text"));
  });

  it("folds openai reasoning_content as thinking text", () => {
    const msgs = oSession(6);
    msgs[2].reasoning_content = "I should check the failing test first.";
    const res = compact(msgs, OPENAI, cfg({ keepRecent: 1 }));
    const summary = res.messages[2].content;

    assert.ok(summary.includes("thinking: I should check the failing test first."));
  });
});

describe("speaker tags and stripping", () => {
  it("tags user, assistant, and result lines", () => {
    const msgs = aSession(8);
    msgs.splice(5, 0, aUser("please target the dev branch"));
    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));
    const summary = res.messages[1].content;

    assert.ok(summary.includes("user: please target the dev branch"));
    assert.ok(summary.includes("assistant: Step 0:"));
    assert.ok(summary.includes("result: test_1 passed"));
  });

  it("strips task-notification blocks from summaries", () => {
    const notif =
      "<task-notification>\n<task-id>abc</task-id>\n" +
      "<result>" +
      "R".repeat(3000) +
      "</result>\n</task-notification>";

    const msgs = [
      aUser("task"),
      aAssistant("step 0", ["t0", "bash", { command: "ls" }]),
      aUser(notif + "\nalso: please use the dev branch"),
      aAssistant("step 1", ["t1", "bash", { command: "pwd" }]),
      aResult("t1", "ok"),
      aAssistant("step 2", null),
      aResult("t2", "ok"),
    ];

    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));
    const summary = res.messages[1].content;

    assert.equal(summary.includes("task-notification"), false);
    assert.equal(summary.includes("RRRR"), false);
    assert.ok(summary.includes("also: please use the dev branch"));

    const msgs2 = msgs.slice();
    msgs2[2] = aUser(notif);
    const res2 = compact(msgs2, ANTHROPIC, cfg({ keepRecent: 1 }));

    assert.equal(res2.messages[1].content.includes("task-notification"), false);
  });

  it("drops images from summaries and keeps surrounding text", () => {
    const imgMsg = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "see the screenshot" },
      ],
    };

    const msgs = [
      aUser("task"),
      aAssistant("step 0", ["t0", "bash", { command: "ls" }]),
      imgMsg,
      aAssistant("step 1", ["t1", "bash", { command: "pwd" }]),
      aResult("t1", "ok"),
      aAssistant("step 2", null),
      aResult("t2", "ok"),
    ];

    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));
    const summary = res.messages[1].content;

    assert.equal(summary.includes("AAAA"), false);
    assert.ok(summary.includes("see the screenshot"));
  });
});

describe("re-compaction", () => {
  it("drops a prior summary before follow-up user messages", () => {
    for (const dialect of [ANTHROPIC, OPENAI, RESPONSES, PI]) {
      const head = dialect.userMessage("original task");

      const first = compact([
        head,
        { role: "assistant", content: "obsolete assistant excerpt" },
        dialect.userMessage("previous continuation"),
      ], dialect, cfg({ keepRecent: 0 }));

      assert.ok(first, dialect.name);

      const recent = { role: "assistant", content: "recent answer" };

      const grown = [
        ...first.messages,
        dialect.userMessage("follow-up request"),
        { role: "assistant", content: "live older answer" },
        dialect.userMessage("live correction"),
        recent,
      ];

      for (const keepRecent of [0, 1]) {
        const result = compact(grown, dialect, cfg({ keepRecent }));

        assert.ok(result, dialect.name);
        assert.equal(result.headLen, 1, dialect.name);
        assert.equal(result.messages[0], head);
        assert.equal(result.messages.filter(dialect.isSummaryMessage).length, 1, dialect.name);
        const text = JSON.stringify(result.summary);

        assert.ok(text.includes("user: follow-up request"), dialect.name);
        assert.ok(text.includes("assistant: live older answer"), dialect.name);
        assert.ok(text.includes("user: live correction"), dialect.name);
        assert.equal(JSON.stringify(result.messages).includes("obsolete assistant excerpt"), false, dialect.name);
        assert.equal(result.cut, grown.length - keepRecent, dialect.name);

        if (keepRecent === 1) assert.equal(result.messages.at(-1), recent);
      }
    }
  });

  it("stays flat and does not merge the previous summary forward", () => {
    const msgs = aSession(10);
    const res1 = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));
    const grown = res1.messages.slice();

    for (let i = 10; i < 16; i++) {
      const tid = "tu_" + i;
      grown.push(aAssistant("Step " + i, [tid, "bash", { command: "cmd " + i }]));
      grown.push(aResult(tid, "K".repeat(2000)));
    }

    const res2 = compact(grown, ANTHROPIC, cfg({ keepRecent: 1 }));

    assert.ok(res2);

    const headers = res2.messages.filter(
      (m) => m.role === "user" && String(m.content).startsWith(SUMMARY_HEADER),
    );

    assert.equal(headers.length, 1);
    assert.equal(headers[0].content.includes("Step 0"), false);
    assert.ok(headers[0].content.includes("Step 14"));
    assert.equal(res2.messages[0], msgs[0]);
  });

  it("groups a leading orphan summary separately from assistant turns", () => {
    const msgs = aSession(4);
    const res = compact(msgs, ANTHROPIC, cfg({ keepRecent: 1 }));
    const turns = groupTurns(res.messages.slice(1), ANTHROPIC);

    assert.ok(String(turns[0][0].content).startsWith(SUMMARY_HEADER));

    for (const t of turns.slice(1)) {
      assert.equal(t[0].role, "assistant");
    }
  });

  it("never lets a content-ful system message precede the injected summary", () => {
    const msgs = [
      { role: "user", content: "the task" },
      { role: "system", content: "directive: be careful" },
    ];

    for (let i = 0; i < 6; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "text", text: "step " + i },
          { type: "tool_use", id: "t" + i, name: "bash", input: { command: "make " + i } },
        ],
      });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t" + i, content: "R".repeat(2000) }],
      });
    }

    const res = compact(msgs, ANTHROPIC, makeConfig({ keepRecent: 2 }));

    assert.ok(res);
    assert.equal(res.headLen, 1);
    assert.equal(res.messages[0].role, "user");
    assert.ok(String(res.messages[1].content).startsWith(SUMMARY_HEADER));
    assert.ok(res.messages[1].content.includes("system: directive: be careful"));

    for (let i = 0; i < res.messages.length; i++) {
      const m = res.messages[i];

      if (m.role === "system" && m.content) {
        assert.ok(i === res.messages.length - 1 || res.messages[i + 1].role === "assistant");
      }
    }
  });

  it("drops directive-only system messages and keeps the tail verbatim", () => {
    const msgs = [{ role: "user", content: "task" }];

    for (let i = 0; i < 5; i++) {
      msgs.push({ role: "assistant", content: "step " + i });
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t" + i, content: "R".repeat(1500) }],
      });

      if (i === 1) {
        msgs.push({ role: "system", content: [] });
      }
    }

    const res = compact(msgs, ANTHROPIC, makeConfig({ keepRecent: 2 }));

    assert.ok(res);
    const text = res.messages[res.headLen].content;
    assert.equal(String(text).includes("system:"), false);
    assert.deepEqual(res.messages[res.messages.length - 1], msgs[msgs.length - 1]);
  });
});
