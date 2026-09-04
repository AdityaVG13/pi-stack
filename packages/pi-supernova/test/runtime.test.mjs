import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGuestProgram } from "../runtime.js";
import piSupernova, { renderSupernovaCall, renderSupernovaResult } from "../index.js";

describe("guest runtime", () => {
  const config = {
    timeoutMs: 5000,
    maxCodeChars: 10000,
    maxReturnChars: 5000,
    maxLogLines: 20,
    maxLogLineChars: 200,
    maxCallResultChars: 2000,
    maxBridgeCalls: 50,
  };

  it("runs async body with nova.call and returns shaped value", async () => {
    const nova = {
      search: () => [{ name: "read", description: "Read a file" }],
      describe: (name) => ({ ok: true, name }),
      call: async (name, args) => ({ ok: true, value: `called:${name}:${args.path}`, truncated: false }),
      callMany: async () => ({ results: [], mode: "serial" }),
      has: () => true,
    };
    const outcome = await runGuestProgram({
      code: `
        const hits = nova.search("read");
        const r = await nova.call("read", { path: "a.txt" });
        return { hits: hits.length, r: r.value };
      `,
      nova,
      config,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.hits, 1);
    assert.equal(outcome.result.r, "called:read:a.txt");
  });

  it("supports parallel helper", async () => {
    const nova = {
      search: () => [],
      describe: () => ({ ok: false }),
      call: async () => ({ ok: true, value: "x" }),
      callMany: async () => ({ results: [] }),
      has: () => false,
    };
    const outcome = await runGuestProgram({
      code: `return await parallel([async () => 1, async () => 2]);`,
      nova,
      config,
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, [1, 2]);
  });

  it("rejects empty code", async () => {
    const outcome = await runGuestProgram({
      code: "   ",
      nova: {},
      config,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /non-empty|code/i);
  });

  it("returns syntax errors without throwing", async () => {
    const outcome = await runGuestProgram({ code: "return (;", nova: {}, config });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /unexpected|syntax/i);
  });

  it("rolls back the outer transaction after a syntax error", async () => {
    let supernovaTool;
    const pi = {
      getAllTools: () => [],
      registerTool(tool) {
        if (tool.name === "supernova") supernovaTool = tool;
      },
      registerCommand() {},
      on() {},
    };
    piSupernova(pi);

    const failed = await supernovaTool.execute(
      "syntax-error",
      { code: "return (;" },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd(), state: {} },
    );
    assert.equal(failed.details.ok, false);

    const recovered = await supernovaTool.execute(
      "after-syntax-error",
      { code: 'return await bash("printf recovered");' },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd(), state: {} },
    );
    assert.equal(recovered.details.ok, true);
    assert.equal(recovered.details.result, "recovered");
  });

  it("seeds the result slot before the first host call", async () => {
    let supernovaTool;
    const pi = {
      getAllTools: () => [],
      registerTool(tool) {
        if (tool.name === "supernova") supernovaTool = tool;
      },
      registerCommand() {},
      on() {},
    };
    piSupernova(pi);
    const updates = [];
    const response = await supernovaTool.execute(
      "initial-result-slot",
      { code: `return "done";` },
      new AbortController().signal,
      (update) => updates.push(update),
      { cwd: process.cwd(), state: {} },
    );
    assert.equal(response.details.ok, true);
    assert.ok(updates.length >= 1);
    assert.deepEqual(updates[0].details.trace, []);
    assert.equal(updates[0].details.running, true);
  });

  it("returns structured values from direct nova.snap and nova.surface helpers", async () => {
    let supernovaTool;
    const pi = {
      getAllTools: () => [],
      registerTool(tool) {
        if (tool.name === "supernova") supernovaTool = tool;
      },
      registerCommand() {},
      on() {},
    };
    piSupernova(pi);

    const response = await supernovaTool.execute(
      "structured-nova-helpers",
      {
        code: `const hit = await nova.snap("syntax errors roll back outer VFS transaction", "."); const outline = await nova.surface(hit.path); return { path: hit.path, line: hit.line, items: outline.items.length };`,
      },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd(), state: {} },
    );
    assert.equal(response.details.ok, true);
    assert.match(response.details.result.path, /host-bridge\.js$/);
    assert.ok(response.details.result.line > 0);
    assert.ok(response.details.result.items > 0);
  });

  it("renders real write and edit traces identically in Pi and OMP", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "supernova-unified-ui-"));
    let supernovaTool;
    const pi = {
      getAllTools: () => [],
      registerTool(tool) {
        if (tool.name === "supernova") supernovaTool = tool;
      },
      registerCommand() {},
      on() {},
    };
    piSupernova(pi);
    const code = `await write("sample.txt", "old line\\n"); await edit("sample.txt", "old line", "new line"); return "done";`;
    const theme = { fg: (_token, text) => text, bold: (text) => text, dim: (text) => text };
    try {
      const response = await supernovaTool.execute(
        "unified-mutation-ui",
        { code },
        new AbortController().signal,
        undefined,
        { cwd: tmpDir, state: {} },
      );
      assert.equal(response.details.ok, true);
      assert.equal(response.details.trace.length, 2);
      assert.ok(response.details.trace.every((record) => record.diff?.lines?.length > 0));
      const options = { expanded: false, isPartial: false };
      const piLines = renderSupernovaResult(response, options, theme, { state: {}, args: { code } }).render(100);
      const ompLines = renderSupernovaResult(response, options, theme, { code }).render(100);
      assert.deepEqual(piLines, ompLines);
      const text = piLines.join("\n");
      assert.match(text, /write.*\+1\/-0.*sample\.txt/);
      assert.match(text, /edit.*\+1\/-1.*sample\.txt/);
      assert.match(text, /old line/);
      assert.match(text, /new line/);
      assert.deepEqual(renderSupernovaCall({ code }, theme, { state: response.details }).render(100), []);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes the real process to guest code", async () => {
    const outcome = await runGuestProgram({
      code: `
        return {
          hasProcess: typeof process !== "undefined",
          hasCwd: typeof process.cwd === "function",
          cwdType: typeof process.cwd(),
        };
      `,
      nova: {},
      config,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.hasProcess, true);
    assert.equal(outcome.result.hasCwd, true);
    assert.equal(outcome.result.cwdType, "string");
  });

  it("throws on failed canonical bash calls and shell-quotes exec arguments", async () => {
    const commands = [];
    const nova = {
      call: async (name, args) => {
        commands.push({ name, args });
        if (args.command === "false") {
          return { ok: false, value: "exit 1", details: '{"exitCode":1}' };
        }
        return { ok: true, value: "ok" };
      },
    };
    const failed = await runGuestProgram({ code: 'await bash("false");', nova, config });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /exit 1/);

    const succeeded = await runGuestProgram({
      code: 'return await exec("printf", ["%s", "hello world", "it\'s"]);',
      nova,
      config,
    });
    assert.equal(succeeded.ok, true);
    assert.match(commands.at(-1).args.command, /'hello world'/);
    assert.match(commands.at(-1).args.command, /'it'\\''s'/);
  });

  it("blocks late bridge mutations after an internal timeout", async () => {
    let supernovaTool;
    let mutations = 0;
    const listeners = new Map();
    const pi = {
      getAllTools: () => [],
      registerTool(tool) {
        if (tool.name === "supernova") supernovaTool = tool;
      },
      registerCommand() {},
      on(name, handler) {
        listeners.set(name, handler);
      },
    };
    piSupernova(pi);
    pi.registerTool({
      name: "mutate",
      async execute() {
        mutations += 1;
        return { content: [{ type: "text", text: "mutated" }] };
      },
    });

    const outcome = await supernovaTool.execute(
      "timeout-test",
      {
        code: `await new Promise((resolve) => setTimeout(resolve, 30)); await nova.call("mutate", {});`,
        timeoutMs: 5,
      },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd(), state: {} },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(outcome.details.ok, false);
    assert.match(outcome.details.error, /timed out|aborted/);
    assert.equal(mutations, 0);
  });

  it("turns guest ReferenceError into a tool error, not a crash", async () => {
    const outcome = await runGuestProgram({
      code: `return totallyUndefinedGlobal.foo;`,
      nova: {},
      config,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /ReferenceError|totallyUndefinedGlobal|not defined/i);
  });
});
