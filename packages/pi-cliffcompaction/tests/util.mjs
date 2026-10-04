/** Fixture builders: realistic Anthropic / OpenAI / Pi agent message lists. */

export function aUser(text) {
  return { role: "user", content: text };
}

export function aAssistant(text, tool = null) {
  const content = [];

  if (text) {
    content.push({ type: "text", text });
  }

  if (tool) {
    const [tid, name, inp] = tool;
    content.push({ type: "tool_use", id: tid, name, input: inp });
  }

  return { role: "assistant", content };
}

export function aResult(toolUseId, text) {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
  };
}

export function aSession(nTurns, longResultChars = 3000) {
  const msgs = [aUser("Fix the failing test in repo X.")];

  for (let i = 0; i < nTurns; i++) {
    const tid = "tu_" + i;
    msgs.push(
      aAssistant("Step " + i + ": I will inspect module " + i + " to find the bug.", [
        tid,
        "bash",
        { command: "pytest tests/test_" + i + ".py -x" },
      ]),
    );

    if (i % 2 === 0) {
      msgs.push(aResult(tid, "X".repeat(longResultChars)));
    } else {
      msgs.push(aResult(tid, "test_" + i + " passed (short output)"));
    }
  }

  return msgs;
}

export function aBody(msgs, system = "You are a coding agent.") {
  return {
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system,
    messages: msgs,
  };
}

export function oSystem(text) {
  return { role: "system", content: text };
}

export function oUser(text) {
  return { role: "user", content: text };
}

export function oAssistant(text, tool = null) {
  const msg = { role: "assistant", content: text };

  if (tool) {
    const [tid, name, args] = tool;
    msg.tool_calls = [
      {
        id: tid,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ];
  }

  return msg;
}

export function oTool(toolCallId, text) {
  return { role: "tool", tool_call_id: toolCallId, content: text };
}

export function oSession(nTurns, longResultChars = 3000) {
  const msgs = [oSystem("You are a coding agent."), oUser("Fix the failing test.")];

  for (let i = 0; i < nTurns; i++) {
    const tid = "call_" + i;
    msgs.push(
      oAssistant("Step " + i + ": inspecting module " + i + ".", [
        tid,
        "bash",
        { command: "pytest tests/test_" + i + ".py -x" },
      ]),
    );

    if (i % 2 === 0) {
      msgs.push(oTool(tid, "Y".repeat(longResultChars)));
    } else {
      msgs.push(oTool(tid, "test_" + i + " passed"));
    }
  }

  return msgs;
}

export function oBody(msgs) {
  return { model: "gpt-5", messages: msgs };
}

export function pUser(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

export function pAssistant(text, tool = null) {
  const content = [];

  if (text) {
    content.push({ type: "text", text });
  }

  if (tool) {
    const [id, name, args] = tool;
    content.push({ type: "toolCall", id, name, arguments: args });
  }

  return { role: "assistant", content, timestamp: 0 };
}

export function pResult(toolCallId, text) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

export function grow(msgs, start, n, resultChars = 2000) {
  const out = msgs.slice();

  for (let i = start; i < start + n; i++) {
    const tid = "tu_" + i;
    out.push(aAssistant("Step " + i, [tid, "bash", { command: "cmd " + i }]));
    out.push(aResult(tid, "R".repeat(resultChars)));
  }

  return out;
}

