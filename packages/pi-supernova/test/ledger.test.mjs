import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SeenLedger } from "../ledger.js";
import { quickCheck } from "../check.js";
import piSupernova from "../index.js";

function tool() {
  const tools = new Map();
  const pi = { registerTool(t) { tools.set(t.name, t); }, registerCommand() {}, on() {}, getAllTools() { return [...tools.values()]; } };
  piSupernova(pi);
  return tools.get("supernova");
}

const FILE = Array.from({ length: 20 }, (_, i) => "export const value" + i + " = compute(" + i + ");").join("\n") + "\n";

describe("seen-ledger: the model's context is memory", () => {
  it("collapses only runs it already sent, cites their source, and never hides a changed line", () => {
    const ledger = new SeenLedger();
    const lines = FILE.trimEnd().split("\n");
    ledger.beginProgram(1);
    ledger.recordOrigin("a.js", 1, lines);
    assert.equal(ledger.dedupe("ok\n" + lines.join("\n"), 1).split("\n").length, 21, "first time: verbatim");
    ledger.beginProgram(2);
    ledger.recordOrigin("a.js", 1, lines);
    assert.equal(ledger.dedupe("ok\n" + lines.join("\n"), 2), "ok\n⋯ 20 lines same as #1 · a.js:1–20 ⋯");
    const edited = [...lines];
    edited[10] = "export const value10 = recompute(10);";
    ledger.beginProgram(3);
    ledger.recordOrigin("a.js", 1, edited);
    const delta = ledger.dedupe("ok\n" + edited.join("\n"), 3);
    assert.match(delta, /^ok\n⋯ 10 lines same as #1 · a.js:1–10 ⋯\nexport const value10 = recompute\(10\);\n⋯ 9 lines same as #1 · a.js:12–20 ⋯$/);
    ledger.beginProgram(4);
    ledger.recordOrigin("a.js", 5, edited.slice(4, 12), true);
    assert.equal(ledger.dedupe("ok\n" + edited.slice(4, 12).join("\n"), 4).split("\n").length, 9, "explicit window is pinned: shown verbatim");
  });

  it("forgets results outside the window and short or trivial runs stay verbatim", () => {
    const ledger = new SeenLedger({ window: 2 });
    const trivial = ["}", "};", "", "}", "});", "}"];
    ledger.beginProgram(1);
    ledger.dedupe(trivial.join("\n"), 1);
    ledger.beginProgram(2);
    assert.equal(ledger.dedupe(trivial.join("\n"), 2), trivial.join("\n"), "brace-only runs never collapse");
    const five = FILE.trimEnd().split("\n").slice(0, 5).join("\n");
    ledger.dedupe(five, 2);
    ledger.beginProgram(3);
    assert.equal(ledger.dedupe(five, 3), five, "runs under six lines stay verbatim");
    ledger.beginProgram(10);
    assert.equal(ledger.results.size, 0, "window expired");
  });

  it("quickCheck names the unbalanced token and line, and ignores strings, templates, regexes, comments", () => {
    assert.deepEqual(quickCheck("function a() { return /[{]/.test(x); } // {", ".js"), { ok: true, kind: "balance" });
    assert.deepEqual(quickCheck("const s = `a ${ { b: 1 }.b } c`;\nif (x) {", ".js"), { ok: false, kind: "balance", message: "unclosed '{' opened at line 2" });
    assert.equal(quickCheck("a) b", ".js").message, "unexpected ')' at line 1");
    assert.equal(quickCheck("x = 'open", ".js").message, "unterminated string at line 1");
    assert.equal(quickCheck('{"a": 1,}', ".json").ok, false);
    assert.equal(quickCheck("if x:\n  pass", ".py"), null);
  });

  it("edit results carry the post-edit lines, a check, and references to a changed declaration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-summary-"));
    try {
      await fs.writeFile(path.join(dir, "a.js"), "export function verifySession(token) {\n  return token.length > 0;\n}\n");
      await fs.writeFile(path.join(dir, "b.js"), "import { verifySession } from './a.js';\nverifySession('x');\n");
      const nova = tool();
      const run = async (code) => (await nova.execute("id", { code }, undefined, undefined, { cwd: dir })).content[0].text;
      const edited = await run('return await edit("a.js", "verifySession(token) {", "verifySession(token, opts) {")');
      assert.match(edited, /edited a\.js:1–3\n\s+1 export function verifySession\(token, opts\) \{\n\s+2   return token\.length > 0;\n\s+3 \}/);
      assert.match(edited, /verifySession also referenced in b\.js:1, b\.js:2/);
      assert.doesNotMatch(edited, /check:/);
      const broken = await run('return await edit("a.js", "return token.length > 0;", "return token.length > 0;\\n  if (opts) {")');
      assert.match(broken, /check: unclosed '\{' opened at line 1/, "the new } closes the if; the function brace is what is left open");
      const reread = await run('return await read("a.js")');
      assert.match(reread, /if \(opts\) \{/, "changed line is shown");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a failing command attaches the source behind path:line references it printed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-source-"));
    try {
      await fs.writeFile(path.join(dir, "lib.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n");
      const nova = tool();
      const run = async (code) => (await nova.execute("id", { code }, undefined, undefined, { cwd: dir })).content[0].text;
      const out = await run('return await bash("echo failing at lib.js:3 && exit 2").catch(e => e.message)');
      assert.match(out, /--- source\nlib\.js:3\n\s+1 const a = 1;\n\s+2 const b = 2;\n►\s+3 const c = 3;\n\s+4 const d = 4;/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
