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

  it("compacts native shell-only steps while keeping the recent call and output together", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const head = [dev("Run commands locally."), user("Build the project.")];

    const older = [
      {
        type: "shell_call", id: "shell_0", call_id: "native_shell_0", status: "completed",
        environment: { type: "local" },
        action: { commands: ["make build"], max_output_length: null, timeout_ms: 1000 },
      },
      { type: "shell_call_output", call_id: "native_shell_0", output: [
        { stdout: "OLD-SHELL-LOG-" + "x".repeat(5000), stderr: "", outcome: { type: "exit", exit_code: 0 } },
      ] },
    ];

    const recent = [
      {
        type: "shell_call", id: "shell_1", call_id: "native_shell_1", status: "completed",
        environment: { type: "local" },
        action: { commands: ["make test"], max_output_length: null, timeout_ms: 1000 },
      },
      { type: "shell_call_output", call_id: "native_shell_1", output: [
        { stdout: "Tests passed", stderr: "", outcome: { type: "exit", exit_code: 0 } },
      ] },
    ];

    const items = [...head, ...older, ...recent];
    const body = rBody(items);
    const engine = new Engine(cfg);
    const first = engine.prepare(body, DIALECT);

    assert.equal(first.compacted, true);
    assert.equal(first.overBudget, false);
    assert.equal(first.baseHead, head.length);
    assert.equal(first.baseCut, head.length + older.length);
    const output = ctxOutgoingBody(first);
    const summary = output.input[head.length].content[0].text;

    assert.ok(summary.includes("[shell_call] "));
    assert.ok(summary.includes("make build"));
    assert.equal(summary.includes("OLD-SHELL-LOG-"), false);
    assert.equal(output.input[0], head[0]);
    assert.equal(output.input[1], head[1]);
    assert.deepEqual(output.input.slice(head.length + 1), recent);
    assert.equal(output.input.at(-2), recent[0]);
    assert.equal(output.input.at(-1), recent[1]);
    assert.deepEqual(groupTurns(items, DIALECT), [head, older, recent]);
    const cached = engine.prepare(body, DIALECT);

    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);
  });

  it("compacts native apply-patch-only histories and keeps the recent patch turn verbatim", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const head = [dev("Make the requested edits."), user("Fix the failing test.")];

    const older = [
      {
        type: "apply_patch_call", id: "ap_0", call_id: "patch_0", status: "completed",
        operation: { type: "update_file", path: "test.js", diff: "@@\n-old\n+" + "x".repeat(5000) },
      },
      { type: "apply_patch_call_output", call_id: "patch_0", status: "completed", output: "OLD-PATCH-LOG-" + "x".repeat(5000) },
    ];

    const recent = [
      {
        type: "apply_patch_call", id: "ap_1", call_id: "patch_1", status: "completed",
        operation: { type: "update_file", path: "test.js", diff: "@@\n-old\n+fixed" },
      },
      { type: "apply_patch_call_output", call_id: "patch_1", status: "completed", output: "Patch applied" },
    ];

    const items = [...head, ...older, ...recent];
    const body = rBody(items);
    const engine = new Engine(cfg);
    const first = engine.prepare(body, DIALECT);

    assert.equal(first.compacted, true);
    assert.equal(first.overBudget, false);
    assert.equal(first.baseHead, head.length);
    assert.equal(first.baseCut, head.length + older.length);
    const output = ctxOutgoingBody(first);
    const summary = output.input[head.length].content[0].text;

    assert.ok(summary.startsWith(SUMMARY_HEADER));
    assert.equal(summary.includes("OLD-PATCH-LOG-"), false);
    assert.equal(output.input[0], head[0]);
    assert.equal(output.input[1], head[1]);
    assert.deepEqual(output.input.slice(head.length + 1), recent);
    assert.equal(output.input.at(-2), recent[0]);
    assert.equal(output.input.at(-1), recent[1]);
    assert.deepEqual(groupTurns(items, DIALECT), [head, older, recent]);
    const cached = engine.prepare(body, DIALECT);

    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);
  });

  it("keeps a recent file-search model step verbatim rather than splitting off its answer", () => {
    const recent = [
      reasoning(1, "Find the deployment setting."),
      {
        type: "file_search_call", id: "fs_1", status: "completed",
        queries: ["deployment setting"],
        results: [{ file_id: "file_1", filename: "deploy.md", text: "Use the staging endpoint." }],
      },
      assistant("Use the staging endpoint."),
    ];

    const items = [user("task"), reasoning(0), fcall(0), fout(0), ...recent];
    const cfg = makeConfig({ keepRecent: 1 });
    const result = compact(items, DIALECT, cfg);

    assert.ok(result);
    assert.deepEqual(result.messages.slice(-recent.length), recent);

    for (let i = 0; i < recent.length; i++) {
      assert.equal(result.messages.at(i - recent.length), recent[i]);
    }

    assert.equal(result.cut, items.length - recent.length);
    assert.deepEqual(groupTurns(items, DIALECT).at(-1), recent);
  });

  it("keeps the recent code-interpreter model step verbatim", () => {
    const recent = [
      reasoning(1, "Calculate the total."),
      {
        type: "code_interpreter_call", id: "ci_1", status: "completed",
        container_id: "cntr_1", code: "print(41 + 1)",
        outputs: [{ type: "logs", logs: "42" }],
      },
      assistant("The total is 42."),
    ];

    const items = [user("task"), reasoning(0), fcall(0), fout(0), ...recent];
    const result = compact(items, DIALECT, makeConfig({ keepRecent: 1 }));

    assert.ok(result);
    assert.deepEqual(result.messages.slice(result.headLen + 1), recent);
    assert.equal(result.cut, items.length - recent.length);
    assert.deepEqual(groupTurns(items, DIALECT).at(-1), recent);

    for (let i = 0; i < recent.length; i++) {
      assert.equal(result.messages[result.headLen + 1 + i], recent[i]);
    }
  });

  it("keeps a recent MCP model step verbatim instead of compacting its tool call", () => {
    const recent = [
      reasoning(1, "Read the deployment guide."),
      {
        type: "mcp_call", id: "mcp_1", status: "completed",
        server_label: "docs", name: "read_guide", arguments: '{"path":"deploy.md"}',
        output: "Use the staging endpoint.", error: null,
      },
      assistant("Use the staging endpoint."),
    ];

    const items = [user("task"), reasoning(0), fcall(0), fout(0), ...recent];
    const result = compact(items, DIALECT, makeConfig({ keepRecent: 1 }));

    assert.ok(result);
    assert.deepEqual(result.messages.slice(result.headLen + 1), recent);
    assert.equal(result.cut, items.length - recent.length);
    assert.deepEqual(groupTurns(items, DIALECT).at(-1), recent);

    for (let i = 0; i < recent.length; i++) {
      assert.equal(result.messages[result.headLen + 1 + i], recent[i]);
    }
  });

  it("keeps server tool-search output in the recent model step without merging client replies", () => {
    const cfg = makeConfig({ thresholdTokens: 800, keepRecent: 1 });
    const head = [dev("Use the discovered tools."), user("Read the deployment guide.")];
    const older = [reasoning(0), fcall(0), fout(0, "OLD-LOG-" + "x".repeat(5000))];

    const recent = [
      reasoning(1, "Find the deployment tool."),
      {
        type: "tool_search_call", id: "ts_1", call_id: null, execution: "server", status: "completed",
        arguments: { query: "deployment guide" },
      },
      {
        type: "tool_search_output", id: "tso_1", call_id: null, execution: "server", status: "completed",
        tools: [{
          type: "function", name: "read_guide", description: "Read the complete deployment guide. ".repeat(100),
          parameters: {
            type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
          },
          strict: true,
        }],
      },
      { ...fcall(1), name: "read_guide", arguments: '{"path":"deploy.md"}' },
      fout(1, "Use staging."),
    ];

    const items = [...head, ...older, ...recent];
    const body = rBody(items);
    const engine = new Engine(cfg);
    const first = engine.prepare(body, DIALECT);
    const output = ctxOutgoingBody(first);

    assert.equal(first.compacted, true);
    assert.deepEqual(output.input.slice(head.length + 1), recent);
    assert.equal(first.baseCut, head.length + older.length);
    assert.equal(first.overBudget, true, "the protected tool definitions exceed the budget");
    assert.equal(output.input[0], head[0]);
    assert.equal(output.input[1], head[1]);
    assert.equal(JSON.stringify(output).includes("OLD-LOG-"), false);
    assert.deepEqual(groupTurns(items, DIALECT), [head, older, recent]);

    for (let i = 0; i < recent.length; i++) {
      assert.equal(output.input[head.length + 1 + i], recent[i]);
    }

    const cached = engine.prepare(body, DIALECT);
    assert.equal(cached.overBudget, true);
    assert.deepEqual(ctxOutgoingBody(cached), output);
    assert.deepEqual(ctxOutgoingBody(new Engine(cfg).prepare(structuredClone(body), DIALECT)), output);

    const client = structuredClone(recent);
    client[1].execution = "client";
    client[1].call_id = "search_1";
    client[2].execution = "client";
    client[2].call_id = "search_1";
    assert.deepEqual(groupTurns([...head, ...older, ...client], DIALECT), [
      head, older, client.slice(0, 3), client.slice(3),
    ]);
  });

  it("keeps MCP tool discovery in the recent model step verbatim", () => {
    const recent = [
      reasoning(1, "Discover the documentation tools."),
      {
        type: "mcp_list_tools", id: "mcp_tools_1", server_label: "docs",
        tools: [{ name: "read_guide", description: "Read a guide", input_schema: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"],
        } }],
      },
      {
        type: "mcp_call", id: "mcp_1", server_label: "docs", name: "read_guide",
        arguments: '{"path":"deploy.md"}', output: "Use staging.", error: null,
      },
      assistant("Use staging."),
    ];

    const items = [user("task"), reasoning(0), fcall(0), fout(0), ...recent];
    const result = compact(items, DIALECT, makeConfig({ keepRecent: 1 }));

    assert.ok(result);
    assert.deepEqual(result.messages.slice(result.headLen + 1), recent);
    assert.equal(result.cut, items.length - recent.length);
    assert.deepEqual(groupTurns(items, DIALECT).at(-1), recent);

    for (let i = 0; i < recent.length; i++) {
      assert.equal(result.messages[result.headLen + 1 + i], recent[i]);
    }
  });

  it("keeps MCP approval requests with the recent model step and its approval response", () => {
    const recent = [
      reasoning(1, "Request approval to read the deployment guide."),
      {
        type: "mcp_approval_request", id: "mcpr_1", server_label: "docs",
        name: "read_guide", arguments: '{"path":"deploy.md"}',
      },
      assistant("Please approve reading the deployment guide."),
      { type: "mcp_approval_response", approval_request_id: "mcpr_1", approve: true },
    ];

    const items = [user("task"), reasoning(0), fcall(0), fout(0), ...recent];
    const result = compact(items, DIALECT, makeConfig({ keepRecent: 1 }));

    assert.ok(result);
    assert.deepEqual(result.messages.slice(result.headLen + 1), recent);
    assert.equal(result.cut, items.length - recent.length);

    for (let i = 0; i < recent.length; i++) {
      assert.equal(result.messages[result.headLen + 1 + i], recent[i]);
    }

    const resumed = [
      {
        type: "mcp_call", id: "mcp_1", server_label: "docs", name: "read_guide",
        arguments: '{"path":"deploy.md"}', approval_request_id: "mcpr_1",
        output: "Use staging.", error: null,
      },
      assistant("Use staging."),
    ];

    const turns = groupTurns([...items, ...resumed], DIALECT);

    assert.deepEqual(turns.at(-2), recent);
    assert.deepEqual(turns.at(-1), resumed);
  });

  it("ignores id and status in digests", () => {
    const a = fcall(1);
    const b = { ...fcall(1), id: "totally-different", status: "in_progress" };

    assert.equal(digestMessage(a), digestMessage(b));
    assert.notEqual(digestMessage(fcall(1)), digestMessage(fcall(2)));
  });

  it("recaps code-interpreter source and invalidates cached excerpts after redaction", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, humanMaxChars: 30 });
    const engine = new Engine(cfg);

    const call = {
      type: "code_interpreter_call", id: "ci_0", status: "completed",
      container_id: "cntr_0", code: 'print("SENSITIVE-CODE")',
      outputs: [{ type: "logs", logs: "ok" }],
    };

    const items = [user("task"), call, user("x".repeat(5000)), assistant("done")];
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-CODE"));
    const originalDigest = digestMessage(call);
    assert.equal(originalDigest, digestMessage({ ...call, id: "ci_changed", status: "in_progress" }));
    call.code = 'print("[redacted]")';
    assert.notEqual(digestMessage(call), originalDigest);
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    const summary = warm.substituted[warm.baseHead].content[0].text;

    assert.ok(summary.includes('[code_interpreter_call] print("[redacted]")'));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-CODE"), false);
    assert.equal(ctxOutgoingBody(warm).input.at(-1), items.at(-1));
    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, cmdMaxChars: 8 }));

    assert.ok(capped.summary.content[0].text.includes('[code_interpreter_call] print("[...'));
  });

  it("retains short code-interpreter logs without reusing redacted results", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 40, humanMaxChars: 30 });
    const image = { type: "image", url: "https://example.com/private-plot.png" };

    const call = {
      type: "code_interpreter_call", id: "ci_0", status: "completed", container_id: "cntr_0",
      code: 'print(open("build.log").read())',
      outputs: [{ type: "logs", logs: "SENSITIVE-CODE-RESULT" }, image, { type: "logs", logs: "exit 0" }],
    };

    const items = [user("task"), call, user("x".repeat(5000)), assistant("done")];
    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    const summary = first.substituted[first.baseHead].content[0].text;
    assert.ok(summary.includes('[code_interpreter_call] print(open("build.log").read())'));
    assert.ok(summary.includes("result: SENSITIVE-CODE-RESULT\nexit 0"));
    assert.equal(summary.includes("private-plot"), false);
    assert.equal(ctxOutgoingBody(first).input[0], items[0]);
    assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
    const cached = engine.prepare(rBody(items), DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

    call.outputs[0].logs = "[redacted]";
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(warm.substituted[warm.baseHead].content[0].text.includes("result: [redacted]\nexit 0"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-CODE-RESULT"), false);

    call.outputs = [image];
    const removed = engine.prepare(rBody(items), DIALECT);
    const fresh = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(removed), ctxOutgoingBody(fresh));
    const imageOnly = removed.substituted[removed.baseHead].content[0].text;
    assert.equal(imageOnly.includes("result: "), false);
    assert.equal(imageOnly.includes("private-plot"), false);

    call.outputs = [{ type: "logs", logs: "a".repeat(cfg.resultMaxChars) }];
    const exact = compact(items, DIALECT, cfg);
    assert.ok(exact);
    assert.ok(exact.summary.content[0].text.includes("result: " + "a".repeat(cfg.resultMaxChars)));

    call.outputs = [{ type: "logs", logs: "a".repeat(20) }, { type: "logs", logs: "b".repeat(20) }];
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped);
    assert.ok(capped.summary.content[0].text.includes("[code_interpreter_call]"));
    assert.equal(capped.summary.content[0].text.includes("result: "), false);
  });

  it("recaps image-generation revised prompts without reusing redacted text", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, cmdMaxChars: 40, humanMaxChars: 30 });
    const engine = new Engine(cfg);

    const call = {
      type: "image_generation_call", id: "ig_0", status: "completed",
      revised_prompt: "SENSITIVE-IMAGE-PROMPT-" + "x".repeat(100),
      result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=",
    };

    const items = [user("Create a diagram."), call, user("x".repeat(5000)), assistant("recent response")];
    const body = rBody(items);
    const first = engine.prepare(body, DIALECT);
    const output = ctxOutgoingBody(first);
    const summary = output.input[1].content[0].text;

    assert.equal(first.compacted, true);
    assert.ok(summary.includes("[image_generation_call] " + call.revised_prompt.slice(0, cfg.cmdMaxChars) + "..."),
      "the call signature must retain the native revised prompt");
    assert.equal(summary.includes(call.revised_prompt), false);
    assert.equal(summary.includes(call.result), false);
    assert.equal(output.input[0], items[0]);
    assert.equal(output.input.at(-1), items.at(-1));
    const cached = engine.prepare(body, DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);

    const originalDigest = digestMessage(call);
    assert.equal(originalDigest, digestMessage({ ...call, id: "ig_changed", status: "in_progress" }));

    for (const prompt of ["[redacted]", null]) {
      call.revised_prompt = prompt;
      const warm = engine.prepare(body, DIALECT);
      const cold = new Engine(cfg).prepare(structuredClone(body), DIALECT);
      const redacted = ctxOutgoingBody(warm);

      assert.deepEqual(redacted, ctxOutgoingBody(cold));
      assert.equal(JSON.stringify(redacted).includes("SENSITIVE-IMAGE-PROMPT"), false);
      assert.equal(redacted.input[0], items[0]);
      assert.equal(redacted.input.at(-1), items.at(-1));
      assert.notEqual(digestMessage(call), originalDigest);

      if (prompt !== null) assert.ok(redacted.input[1].content[0].text.includes("[image_generation_call] " + prompt));
    }
  });

  it("preserves custom-tool input and invalidates cached excerpts after redaction", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const engine = new Engine(cfg);

    const items = [
      user("task"),
      { type: "custom_tool_call", id: "ct_0", call_id: "custom_0", name: "apply_patch", input: "SENSITIVE-PATCH" },
      { type: "custom_tool_call_output", call_id: "custom_0", output: "x".repeat(5000) },
      assistant("done"),
    ];

    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("[apply_patch] SENSITIVE-PATCH"));
    const originalDigest = digestMessage(items[1]);
    assert.equal(originalDigest, digestMessage({ ...items[1], id: "ct_changed", status: "completed" }));
    items[1].input = "[redacted]";
    assert.notEqual(digestMessage(items[1]), originalDigest);
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("[apply_patch] [redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-PATCH"), false);
    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, cmdMaxChars: 4 }));
    assert.ok(capped.summary.content[0].text.includes("[apply_patch] [red..."));
  });

  it("preserves local-shell actions and invalidates cached commands after redaction", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const engine = new Engine(cfg);

    const items = [
      user("task"),
      {
        type: "local_shell_call", id: "shell_0", call_id: "shell_call_0", status: "completed",
        action: { type: "exec", command: ["bash", "-lc", "SENSITIVE-COMMAND"], timeout_ms: 1000 },
      },
      { type: "local_shell_call_output", call_id: "shell_call_0", output: "x".repeat(5000) },
      assistant("done"),
    ];

    const first = engine.prepare(rBody(items), DIALECT);
    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-COMMAND"));
    const originalDigest = digestMessage(items[1]);
    assert.equal(originalDigest, digestMessage({ ...items[1], id: "shell_changed", status: "in_progress" }));
    items[1].action.command[2] = "[redacted]";
    assert.notEqual(digestMessage(items[1]), originalDigest);
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("[redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-COMMAND"), false);
    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, cmdMaxChars: 8 }));
    assert.ok(capped.summary.content[0].text.includes('[local_shell_call] {"comman...'));
  });

  it("recaps native shell actions and invalidates cached commands after redaction", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, cmdMaxChars: 100 });
    const engine = new Engine(cfg);

    const call = {
      type: "shell_call", id: "shell_0", call_id: "native_shell_0", status: "completed",
      environment: { type: "local" },
      action: {
        commands: ["SENSITIVE-NATIVE-SHELL-COMMAND-" + "x".repeat(150), "pwd"],
        max_output_length: null, timeout_ms: 1000,
      },
    };

    const items = [
      user("task"), reasoning(0), call,
      { type: "shell_call_output", call_id: call.call_id, output: [
        { stdout: "x".repeat(5000), stderr: "", outcome: { type: "exit", exit_code: 0 } },
      ] },
      assistant("recent response"),
    ];

    const body = rBody(items);
    const first = engine.prepare(body, DIALECT);
    const firstOutput = ctxOutgoingBody(first);
    const args = JSON.stringify(call.action);

    assert.equal(first.compacted, true);
    assert.ok(firstOutput.input[1].content[0].text.includes("[shell_call] " + args.slice(0, cfg.cmdMaxChars) + "..."));
    assert.equal(firstOutput.input[1].content[0].text.includes(args), false);
    assert.equal(firstOutput.input[0], items[0]);
    assert.equal(firstOutput.input.at(-1), items.at(-1));
    const cached = engine.prepare(body, DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), firstOutput);

    const oldDigest = digestMessage(call);
    assert.equal(oldDigest, digestMessage({ ...call, id: "shell_changed", status: "in_progress" }));
    call.action.commands[0] = "[redacted]";
    assert.notEqual(digestMessage(call), oldDigest);
    const warm = engine.prepare(body, DIALECT);
    const cold = new Engine(cfg).prepare(structuredClone(body), DIALECT);
    const output = ctxOutgoingBody(warm);

    assert.deepEqual(output, ctxOutgoingBody(cold));
    assert.ok(output.input[1].content[0].text.includes("[shell_call] " + JSON.stringify(call.action)));
    assert.equal(JSON.stringify(output).includes("SENSITIVE-NATIVE-SHELL-COMMAND"), false);
    assert.equal(output.input[0], items[0]);
    assert.equal(output.input.at(-1), items.at(-1));
  });

  it("recaps native apply-patch operations without reusing redacted edits", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const engine = new Engine(cfg);

    const call = {
      type: "apply_patch_call", id: "ap_0", call_id: "patch_0", status: "completed",
      operation: { type: "update_file", path: "SENSITIVE-PATCH-PATH.js", diff: "@@\n-old\n+SENSITIVE-PATCH-DIFF" },
    };

    const items = [
      user("task"), call,
      { type: "apply_patch_call_output", call_id: call.call_id, status: "completed", output: "x".repeat(5000) },
      assistant("recent response"),
    ];

    const body = rBody(items);
    const first = engine.prepare(body, DIALECT);
    const output = ctxOutgoingBody(first);
    const expected = JSON.stringify({ diff: "@@\n-old\n+SENSITIVE-PATCH-DIFF", path: "SENSITIVE-PATCH-PATH.js", type: "update_file" });

    assert.equal(first.compacted, true);
    assert.ok(output.input[1].content[0].text.includes("[apply_patch_call] " + expected), "the recap must retain the native patch operation");
    assert.equal(output.input[0], items[0]);
    assert.equal(output.input.at(-1), items.at(-1));
    const cached = engine.prepare(body, DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);

    const originalDigest = digestMessage(call);
    assert.equal(originalDigest, digestMessage({ ...call, id: "ap_changed", status: "in_progress" }));
    call.operation.path = "[redacted].js";
    call.operation.diff = "[redacted]";
    assert.notEqual(digestMessage(call), originalDigest);
    const warm = engine.prepare(body, DIALECT);
    const cold = new Engine(cfg).prepare(structuredClone(body), DIALECT);
    const redacted = JSON.stringify({ diff: "[redacted]", path: "[redacted].js", type: "update_file" });

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(warm.substituted[warm.baseHead].content[0].text.includes("[apply_patch_call] " + redacted));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-PATCH"), false);
    assert.equal(ctxOutgoingBody(warm).input[0], items[0]);
    assert.equal(ctxOutgoingBody(warm).input.at(-1), items.at(-1));
    const capped = compact(items, DIALECT, makeConfig({ ...cfg, cmdMaxChars: 12 }));

    assert.ok(capped);
    assert.ok(capped.summary.content[0].text.includes("[apply_patch_call] " + redacted.slice(0, 12) + "..."));
    assert.equal(capped.summary.content[0].text.includes(redacted), false);
  });

  it("preserves web-search actions and invalidates cached queries after edits", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, humanMaxChars: 30 });
    const engine = new Engine(cfg);

    const items = [
      user("task"),
      {
        type: "web_search_call", id: "ws_0", status: "completed",
        action: { type: "search", query: "SENSITIVE-QUERY" },
      },
      user("x".repeat(5000)),
      assistant("done"),
    ];

    const first = engine.prepare(rBody(items), DIALECT);
    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-QUERY"));
    const originalDigest = digestMessage(items[1]);
    assert.equal(originalDigest, digestMessage({ ...items[1], id: "ws_changed", status: "in_progress" }));
    items[1].action.query = "[redacted]";
    assert.notEqual(digestMessage(items[1]), originalDigest);
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("[redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-QUERY"), false);
    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, cmdMaxChars: 8 }));
    assert.ok(capped.summary.content[0].text.includes('[web_search_call] {"query"...'));
  });

  it("retains native file-search queries and invalidates cached excerpts after redaction", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, humanMaxChars: 30 });
    const engine = new Engine(cfg);

    const call = {
      type: "file_search_call", id: "fs_0", status: "completed",
      queries: ["SENSITIVE-FILE-QUERY"], results: [],
    };

    const items = [user("task"), call, user("x".repeat(5000)), assistant("done")];

    const first = engine.prepare(rBody(items), DIALECT);
    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-FILE-QUERY"));
    const originalDigest = digestMessage(call);
    assert.equal(originalDigest, digestMessage({ ...call, id: "fs_changed", status: "in_progress" }));
    call.queries[0] = "[redacted]";
    assert.notEqual(digestMessage(call), originalDigest);
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("[redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-FILE-QUERY"), false);
    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, cmdMaxChars: 8 }));
    assert.ok(capped.summary.content[0].text.includes('[file_search_call] ["[redac...'));
  });

  it("retains short file-search result excerpts without reusing redacted results", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 60, humanMaxChars: 30 });
    const firstText = "SENSITIVE-FILE-EXCERPT";
    const secondText = "Deploy to staging.";

    const call = {
      type: "file_search_call", id: "fs_0", status: "completed", queries: ["deployment setting"],
      results: [
        { file_id: "file_0", filename: "private-deploy.md", score: 0.9, attributes: {}, text: firstText },
        { file_id: "file_1", filename: "deploy.md", score: 0.8, attributes: {}, text: secondText },
      ],
    };

    const items = [user("task"), call, user("x".repeat(5000)), assistant("recent response")];
    const body = rBody(items);
    const engine = new Engine(cfg);
    const first = engine.prepare(body, DIALECT);
    const output = ctxOutgoingBody(first);
    const summary = output.input[first.baseHead].content[0].text;

    assert.equal(first.compacted, true);
    assert.ok(summary.includes('[file_search_call] ["deployment setting"]'));
    assert.ok(summary.includes("result: " + firstText + "\n" + secondText));
    assert.equal(summary.includes("private-deploy.md"), false);
    assert.equal(output.input[0], items[0]);
    assert.equal(output.input.at(-1), items.at(-1));
    const cached = engine.prepare(body, DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);

    const originalDigest = digestMessage(call);
    assert.equal(originalDigest, digestMessage({ ...call, id: "fs_changed", status: "in_progress" }));
    call.results[0].text = "[redacted]";
    assert.notEqual(digestMessage(call), originalDigest);
    const warm = engine.prepare(body, DIALECT);
    const cold = new Engine(cfg).prepare(structuredClone(body), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(warm.substituted[warm.baseHead].content[0].text.includes("result: [redacted]\n" + secondText));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes(firstText), false);

    call.results = [];
    const removed = engine.prepare(body, DIALECT);
    const fresh = new Engine(cfg).prepare(structuredClone(body), DIALECT);
    assert.deepEqual(ctxOutgoingBody(removed), ctxOutgoingBody(fresh));
    assert.equal(removed.substituted[removed.baseHead].content[0].text.includes("result: "), false);

    call.results = [{ file_id: "file_0", filename: "deploy.md", score: 0.9, attributes: {}, text: "a".repeat(cfg.resultMaxChars) }];
    const exact = compact(items, DIALECT, cfg);
    assert.ok(exact.summary.content[0].text.includes("result: " + call.results[0].text));
    call.results.push({ ...call.results[0], text: "b" });
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped.summary.content[0].text.includes("[file_search_call]"));
    assert.equal(capped.summary.content[0].text.includes("result: "), false);
  });

  it("keeps computer-use steps together and recaps single or batched actions without stale text", () => {
    for (const field of ["action", "actions"]) {
      const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, humanMaxChars: 30 });
      const engine = new Engine(cfg);
      const action = { type: "type", text: "SENSITIVE-TYPED-TEXT" };

      const call = {
        type: "computer_call", id: "cu_0", call_id: "computer_0", status: "completed",
        pending_safety_checks: [], [field]: field === "action" ? action : [action],
      };

      const output = {
        type: "computer_call_output", call_id: "computer_0",
        output: { type: "computer_screenshot", image_url: "https://example.com/screenshot.png" },
      };

      const items = [user("task"), call, output, user("x".repeat(5000)), assistant("done")];
      const turns = groupTurns(items, DIALECT);

      assert.deepEqual(turns.map(turn => turn.map(item => item.type)), [
        ["message"], ["computer_call", "computer_call_output", "message"], ["message"],
      ]);
      const first = engine.prepare(rBody(items), DIALECT);
      assert.equal(first.compacted, true);
      assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("SENSITIVE-TYPED-TEXT"));
      assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
      const originalDigest = digestMessage(call);
      assert.equal(originalDigest, digestMessage({ ...call, id: "changed", status: "in_progress" }));
      action.text = "[redacted]";
      assert.notEqual(digestMessage(call), originalDigest);
      const warm = engine.prepare(rBody(items), DIALECT);
      const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("[redacted]"));
      assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-TYPED-TEXT"), false);
      const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, cmdMaxChars: 8 }));
      assert.ok(capped.summary.content[0].text.includes("[computer_call] " + (field === "action" ? '{"text":...' : '[{"text"...')));
    }
  });

  it("drops image-only tool output arrays instead of recapping their JSON", () => {
    const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1 });

    for (const image of [
      { type: "input_image", image_url: "https://example.com/private-screenshot.png" },
      { type: "input_image", file_id: "file-private-screenshot" },
    ]) {
      const items = [user("task"), fcall(0), fout(0, [image]), assistant("recent response")];
      const engine = new Engine(cfg);
      const first = engine.prepare(rBody(items), DIALECT);

      assert.equal(first.compacted, true);
      const summary = first.substituted[first.baseHead].content[0].text;

      assert.ok(summary.includes("[exec_command]"));
      assert.equal(summary.includes("result: "), false);
      assert.equal(summary.includes("private-screenshot"), false);
      assert.equal(ctxOutgoingBody(first).input[0], items[0]);
      assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
      const warm = engine.prepare(rBody(items), DIALECT);
      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(first));

      items[2].output.push({ type: "input_text", text: "Screenshot captured." });
      const mixed = engine.prepare(rBody(items), DIALECT);
      const mixedSummary = mixed.substituted[mixed.baseHead].content[0].text;

      assert.ok(mixedSummary.includes("result: Screenshot captured."));
      assert.equal(mixedSummary.includes("private-screenshot"), false);
    }
  });

  it("does not reuse textual JSON excerpts when tool outputs become content blocks", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, humanMaxChars: 30 });
    const image = { image_url: "https://example.com/private-screenshot.png", type: "input_image" };

    for (const blocks of [[image], [{ text: "Screenshot captured.", type: "input_text" }, image]]) {
      const text = JSON.stringify(blocks);
      const result = fout(0, text);
      const items = [user("task"), fcall(0), result, user("x".repeat(5000)), assistant("recent response")];
      const body = rBody(items);
      const engine = new Engine(cfg);
      const first = engine.prepare(body, DIALECT);

      assert.equal(first.compacted, true);
      assert.ok(first.substituted[first.baseHead].content[0].text.includes("result: " + text));
      const cached = engine.prepare(body, DIALECT);
      assert.equal(cached.compacted, false);
      assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

      result.output = blocks;
      const warm = engine.prepare(body, DIALECT);
      const cold = new Engine(cfg).prepare(structuredClone(body), DIALECT);
      const output = ctxOutgoingBody(warm);
      const summary = output.input[warm.baseHead].content[0].text;

      assert.deepEqual(output, ctxOutgoingBody(cold));
      assert.equal(summary.includes("private-screenshot"), false);
      assert.equal(summary.includes("result: "), blocks.length > 1);

      if (blocks.length > 1) assert.ok(summary.includes("result: Screenshot captured."));
      assert.equal(output.input[0], items[0]);
      assert.equal(output.input.at(-1), items.at(-1));

      result.output = text;
      const restored = engine.prepare(body, DIALECT);
      const fresh = new Engine(cfg).prepare(structuredClone(body), DIALECT);
      assert.deepEqual(ctxOutgoingBody(restored), ctxOutgoingBody(fresh));
      assert.ok(restored.substituted[restored.baseHead].content[0].text.includes("result: " + text));
    }
  });

  it("retains short custom-tool results in the mechanical recap", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 20, humanMaxChars: 30 });

    const items = [
      user("task"),
      { type: "custom_tool_call", call_id: "custom_0", name: "apply_patch", input: "patch" },
      { type: "custom_tool_call_output", call_id: "custom_0", output: "Patch applied" },
      user("x".repeat(5000)),
      assistant("done"),
    ];

    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("result: Patch applied"));

    items[2].output = "[redacted]";
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("result: [redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("Patch applied"), false);

    items[2].output = "TOO-LONG-" + "x".repeat(cfg.resultMaxChars);
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped);
    assert.equal(capped.summary.content[0].text.includes("TOO-LONG-"), false);
  });

  it("retains short MCP call outputs without reusing redacted results", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 40, humanMaxChars: 30 });

    const call = {
      type: "mcp_call", id: "mcp_0", status: "completed", server_label: "docs",
      name: "read_guide", arguments: '{"path":"deploy.md"}', output: "SENSITIVE-MCP-RESULT", error: null,
    };

    const items = [user("task"), call, user("x".repeat(5000)), assistant("done")];
    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    const summary = first.substituted[first.baseHead].content[0].text;
    assert.ok(summary.includes('[read_guide] {"path":"deploy.md"}'));
    assert.ok(summary.includes("result: SENSITIVE-MCP-RESULT"));
    assert.equal(ctxOutgoingBody(first).input[0], items[0]);
    assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
    const cached = engine.prepare(rBody(items), DIALECT);
    assert.equal(cached.modified, true);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

    for (const output of ["[redacted]", null]) {
      call.output = output;
      const warm = engine.prepare(rBody(items), DIALECT);
      const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-MCP-RESULT"), false);

      const text = warm.substituted[warm.baseHead].content[0].text;
      assert.equal(text.includes("result: "), output !== null);

      if (output !== null) assert.ok(text.includes("result: " + output));
    }

    call.output = "OVERSIZED-" + "x".repeat(cfg.resultMaxChars);
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped);
    assert.ok(capped.summary.content[0].text.includes('[read_guide] {"path":"deploy.md"}'));
    assert.equal(capped.summary.content[0].text.includes("OVERSIZED-"), false);
  });

  it("retains short MCP errors without reusing redacted diagnostics", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 40, humanMaxChars: 30 });

    const call = {
      type: "mcp_call", id: "mcp_0", status: "failed", server_label: "docs",
      name: "read_guide", arguments: '{"path":"deploy.md"}', output: null,
      error: "Permission denied: SENSITIVE-MCP-PATH",
    };

    const items = [user("task"), call, user("x".repeat(5000)), assistant("checking the failure")];
    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(first.substituted[first.baseHead].content[0].text.includes("result: " + call.error));
    assert.equal(ctxOutgoingBody(first).input[0], items[0]);
    assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
    const cached = engine.prepare(rBody(items), DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

    for (const error of ["[redacted]", null]) {
      call.error = error;
      const warm = engine.prepare(rBody(items), DIALECT);
      const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);

      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-MCP-PATH"), false);

      const text = warm.substituted[warm.baseHead].content[0].text;
      assert.equal(text.includes("result: "), error !== null);

      if (error !== null) assert.ok(text.includes("result: " + error));
    }

    call.error = "a".repeat(cfg.resultMaxChars);
    const exact = compact(items, DIALECT, cfg);
    assert.ok(exact);
    assert.ok(exact.summary.content[0].text.includes("result: " + call.error));
    call.error += "b";
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped);
    assert.ok(capped.summary.content[0].text.includes('[read_guide] {"path":"deploy.md"}'));
    assert.equal(capped.summary.content[0].text.includes("result: "), false);
  });

  it("retains short local-shell results and drops oversized outputs", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 40, humanMaxChars: 30 });

    const items = [
      user("task"),
      { type: "local_shell_call", call_id: "shell_0", action: { type: "exec", command: ["make", "test"] } },
      { type: "local_shell_call_output", call_id: "shell_0", output: "Tests failed (exit 1)" },
      user("x".repeat(5000)),
      assistant("checking the failure"),
    ];

    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(JSON.stringify(ctxOutgoingBody(first)).includes("result: Tests failed (exit 1)"));
    items[2].output = "[redacted]";
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(JSON.stringify(ctxOutgoingBody(warm)).includes("result: [redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("Tests failed (exit 1)"), false);
    items[2].output = "OVERSIZED-" + "x".repeat(cfg.resultMaxChars);
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped);
    assert.equal(capped.summary.content[0].text.includes("OVERSIZED-"), false);
  });

  it("retains short native shell outputs without reusing redacted results", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 200, humanMaxChars: 30 });

    const output = {
      type: "shell_call_output", call_id: "native_shell_0", output: [
        { stdout: "SENSITIVE-SHELL-RESULT", stderr: "Tests failed", outcome: { type: "exit", exit_code: 1 } },
        { stdout: "Retry timed out", stderr: "", outcome: { type: "timeout" } },
      ],
    };

    const items = [
      user("task"),
      {
        type: "shell_call", id: "shell_0", call_id: output.call_id, status: "completed",
        environment: { type: "local" },
        action: { commands: ["make test", "make build"], max_output_length: null, timeout_ms: 1000 },
      },
      output,
      user("x".repeat(5000)),
      assistant("checking the failure"),
    ];

    const expected = '[{"outcome":{"exit_code":1,"type":"exit"},"stderr":"Tests failed","stdout":"SENSITIVE-SHELL-RESULT"},{"outcome":{"type":"timeout"},"stderr":"","stdout":"Retry timed out"}]';
    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(first.substituted[first.baseHead].content[0].text.includes("result: " + expected));
    assert.equal(ctxOutgoingBody(first).input[0], items[0]);
    assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
    const cached = engine.prepare(rBody(items), DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

    const exact = compact(items, DIALECT, makeConfig({ ...cfg, resultMaxChars: expected.length }));
    assert.ok(exact);
    assert.ok(exact.summary.content[0].text.includes("result: " + expected));
    const capped = compact(items, DIALECT, makeConfig({ ...cfg, resultMaxChars: expected.length - 1 }));
    assert.ok(capped);
    assert.ok(capped.summary.content[0].text.includes("[shell_call]"));
    assert.equal(capped.summary.content[0].text.includes("result: "), false);

    output.output[0].stdout = "[redacted]";
    output.output[0].stderr = "[redacted diagnostic]";
    output.output[0].outcome.exit_code = 2;
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    const summary = warm.substituted[warm.baseHead].content[0].text;
    assert.ok(summary.includes('"stdout":"[redacted]"'));
    assert.ok(summary.includes('"stderr":"[redacted diagnostic]"'));
    assert.ok(summary.includes('"outcome":{"exit_code":2,"type":"exit"}'));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-SHELL-RESULT"), false);
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("Tests failed"), false);
  });

  it("retains short native apply-patch outputs without reusing redacted results", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1, resultMaxChars: 40, humanMaxChars: 30 });

    const output = {
      type: "apply_patch_call_output", call_id: "patch_0", status: "failed",
      output: "Patch failed: SENSITIVE-PATCH-PATH",
    };

    const items = [
      user("task"),
      {
        type: "apply_patch_call", id: "ap_0", call_id: output.call_id, status: "completed",
        operation: { type: "update_file", path: "test.js", diff: "@@\n-old\n+fixed" },
      },
      output,
      user("x".repeat(5000)),
      assistant("checking the failure"),
    ];

    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    assert.ok(first.substituted[first.baseHead].content[0].text.includes("result: " + output.output));
    assert.equal(ctxOutgoingBody(first).input[0], items[0]);
    assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
    const cached = engine.prepare(rBody(items), DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

    output.output = "[redacted]";
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(warm.substituted[warm.baseHead].content[0].text.includes("result: [redacted]"));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes("SENSITIVE-PATCH-PATH"), false);

    output.output = "a".repeat(cfg.resultMaxChars);
    const exact = compact(items, DIALECT, cfg);
    assert.ok(exact);
    assert.ok(exact.summary.content[0].text.includes("result: " + output.output));
    output.output += "b";
    const capped = compact(items, DIALECT, cfg);
    assert.ok(capped);
    assert.equal(capped.summary.content[0].text.includes("result: "), false);
  });

  it("retains assistant refusal text and applies the assistant excerpt cap", () => {
    const refusal = {
      type: "message", role: "assistant",
      content: [{ type: "refusal", refusal: "I cannot disclose that secret." }],
    };

    const items = [user("task"), refusal, user("Try a safe alternative."), fcall(0), fout(0), assistant("done")];
    const cfg = makeConfig({ keepRecent: 1, thoughtMaxChars: 0 });
    const result = compact(items, DIALECT, cfg);

    assert.ok(result);
    assert.ok(result.summary.content[0].text.includes("assistant: I cannot disclose that secret."));
    assert.equal(result.messages.at(-1), items.at(-1));
    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, thoughtMaxChars: 8 }));
    assert.ok(capped.summary.content[0].text.includes("assistant: I cannot..."));
    assert.equal(capped.summary.content[0].text.includes("disclose that secret"), false);
  });

  it("retains plaintext reasoning content without reusing redacted excerpts", () => {
    const cfg = makeConfig({ thresholdTokens: 400, keepRecent: 1 });
    const texts = ["SENSITIVE-RAW-REASONING", "Run the focused test before editing."];

    const item = {
      type: "reasoning", id: "rs_0", status: "completed", summary: [],
      content: texts.map(text => ({ type: "reasoning_text", text })),
      encrypted_content: "ENCRYPTED-CONTENT-MUST-STAY-OUT",
    };

    const items = [user("task"), item, fcall(0), fout(0, "x".repeat(5000)), assistant("done")];
    const engine = new Engine(cfg);
    const first = engine.prepare(rBody(items), DIALECT);

    assert.equal(first.compacted, true);
    const summary = first.substituted[first.baseHead].content[0].text;
    assert.ok(summary.includes("thinking: " + texts.join("\n")));
    assert.equal(summary.includes(item.encrypted_content), false);
    assert.equal(ctxOutgoingBody(first).input[0], items[0]);
    assert.equal(ctxOutgoingBody(first).input.at(-1), items.at(-1));
    const cached = engine.prepare(rBody(items), DIALECT);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), ctxOutgoingBody(first));

    const capped = compact(items, DIALECT, makeConfig({ keepRecent: 1, thinkingMaxChars: 12 }));
    assert.ok(capped);
    assert.ok(capped.summary.content[0].text.includes("thinking: " + texts.join("\n").slice(0, 12) + "..."));
    assert.equal(capped.summary.content[0].text.includes(texts[1]), false);
    const dropped = compact(items, DIALECT, makeConfig({ keepRecent: 1, keepThinking: false }));
    assert.ok(dropped);
    assert.equal(dropped.summary.content[0].text.includes("thinking: "), false);

    const originalDigest = digestMessage(item);
    assert.equal(originalDigest, digestMessage({ ...item, id: "rs_changed", status: "in_progress" }));
    item.content[0].text = "[redacted]";
    assert.notEqual(digestMessage(item), originalDigest);
    const warm = engine.prepare(rBody(items), DIALECT);
    const cold = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
    assert.ok(warm.substituted[warm.baseHead].content[0].text.includes("thinking: [redacted]\n" + texts[1]));
    assert.equal(JSON.stringify(ctxOutgoingBody(warm)).includes(texts[0]), false);

    item.content = [];
    const removed = engine.prepare(rBody(items), DIALECT);
    const fresh = new Engine(cfg).prepare(rBody(structuredClone(items)), DIALECT);
    assert.deepEqual(ctxOutgoingBody(removed), ctxOutgoingBody(fresh));
    assert.equal(removed.substituted[removed.baseHead].content[0].text.includes("thinking: "), false);
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
