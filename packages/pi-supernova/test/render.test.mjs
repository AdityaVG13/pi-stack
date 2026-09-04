import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractOperationsFromCode,
  renderSupernovaCall,
  renderSupernovaResult,
  SafeText,
  clampLine,
  hardTruncate,
  measureWidth,
  wrapPlainToWidth,
  normalizeCallRenderArgs,
} from "../render.js";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { isFunction } from "../decode.js";

const mockTheme = {
  fg: (token, text) => `[${token}]${text}[/${token}]`,
  bold: (text) => `<b>${text}</b>`,
  dim: (text) => `<dim>${text}</dim>`,
};

/** Pass-through theme — markers must not inflate visible width (matches real ANSI themes). */
const plainTheme = {
  fg: (_token, text) => text,
  bold: (text) => text,
  dim: (text) => text,
};

/** Prefer Pi's visibleWidth when resolvable so we assert the same contract doRender uses. */
const require = createRequire(import.meta.url);
let piVisibleWidth = measureWidth;
try {
  const tui = require("@earendil-works/pi-tui");
  if (isFunction(tui.visibleWidth)) piVisibleWidth = tui.visibleWidth;
} catch {
  // path-install / CI without pi-tui — measureWidth is the fallback contract
}

/** Synthetic long path for width-crash fixtures (no machine-specific home). */
const LONG_ENOENT_PATH =
  "/Users/example/Developer/pi-stack/packages/pi-supernova/test/bridge.test.mjs";

function assertLinesFit(lines, width, label) {
  for (const line of lines) {
    const vw = piVisibleWidth(line);
    assert.ok(
      vw <= width,
      `${label}: visible width ${vw} > ${width} — ${stripVTControlCharacters(line).slice(0, 120)}`,
    );
  }
}

describe("supernova UI rendering", () => {
  it("extracts tool operations from JS code statically", () => {
    const code = `
      const f = await nova.call("read", { path: "package.json" });
      const b = await nova.call("bash", { command: "git status" });
      const hits = await nova.search("testing");
      const d = await nova.describe("read");
    `;
    const ops = extractOperationsFromCode(code);
    assert.equal(ops.length, 4);
    assert.equal(ops[0].tool, "read");
    assert.equal(ops[0].target, "package.json");
    assert.equal(ops[1].tool, "bash");
    assert.equal(ops[1].target, "git status");
    assert.equal(ops[2].tool, "search");
    assert.equal(ops[2].target, '"testing"');
    assert.equal(ops[3].tool, "describe");
    assert.equal(ops[3].target, "read");
  });

  it("renders canonical direct globals instead of a generic script row", () => {
    const code = `
      const text = await read("package.json");
      await edit("a.js", "old", "new");
      await bash("npm test");
      return text.length;
    `;
    const ops = extractOperationsFromCode(code);
    assert.deepEqual(ops.map((op) => op.tool), ["read", "edit", "bash"]);
    const rendered = renderSupernovaResult(
      { details: { trace: [], running: true } },
      { expanded: false, isPartial: true },
      mockTheme,
      { state: {}, args: { code } },
    ).render(160).join("\n");
    assert.doesNotMatch(rendered, /script/);
    assert.match(rendered, /package\.json/);
    assert.match(rendered, /a\.js/);
    assert.match(rendered, /npm test/);
  });

  it("extracts callMany operations", () => {
    const code = `
      await nova.callMany([
        { name: "read", args: { path: "a.txt" } },
        { name: "write", args: { path: "b.txt" } }
      ]);
    `;
    const ops = extractOperationsFromCode(code);
    assert.equal(ops.length, 2);
    assert.equal(ops[0].tool, "read");
    assert.equal(ops[1].tool, "write");
  });

  it("keeps renderCall empty for both Pi and OMP so only the result slot is visible", () => {
    const args = { code: 'await read("package.json");' };
    const piContext = { args, state: { trace: [{ name: "read", args: { path: "package.json" } }] } };
    assert.deepEqual(renderSupernovaCall(args, plainTheme, piContext).render(80), []);

    const ompOptions = { expanded: false, isPartial: true, executionStarted: true };
    assert.deepEqual(renderSupernovaCall(args, ompOptions, plainTheme).render(80), []);
    assert.equal(normalizeCallRenderArgs(args, ompOptions, plainTheme).host, "omp");
    assert.equal(normalizeCallRenderArgs(args, plainTheme, piContext).host, "pi");
  });

  it("reuses one result component across partial and final updates in both hosts", () => {
    const args = { code: 'await read("a.ts");' };
    const partial = { details: { trace: [{ name: "read", args: { path: "a.ts" } }], running: true } };
    const final = { details: { ok: true, trace: [{ name: "read", args: { path: "a.ts" }, ok: true }] } };

    const piContext = { state: {}, args };
    const piComponent = renderSupernovaResult(partial, { isPartial: true }, plainTheme, piContext);
    assert.strictEqual(renderSupernovaResult(final, { isPartial: false }, plainTheme, piContext), piComponent);

    const ompOptions = { isPartial: true };
    const ompComponent = renderSupernovaResult(partial, ompOptions, plainTheme, args);
    ompOptions.isPartial = false;
    assert.strictEqual(renderSupernovaResult(final, ompOptions, plainTheme, args), ompComponent);
  });

  it("renders identical framed Pi and OMP results with inline write diffs", () => {
    const result = {
      details: {
        ok: true,
        wallMs: 12,
        trace: [{
          name: "write",
          ok: true,
          diff: {
            path: "src/a.ts",
            op: "write",
            added: 1,
            removed: 0,
            lines: [{ type: "add", lineNum: 1, text: "export const value = 1;" }],
          },
        }],
      },
    };
    const options = { expanded: false, isPartial: false };
    const args = { code: 'await write("src/a.ts", "export const value = 1;");' };
    const piLines = renderSupernovaResult(result, options, plainTheme, { state: {}, args }).render(80);
    const ompLines = renderSupernovaResult(result, options, plainTheme, args).render(80);
    assert.deepEqual(piLines, ompLines);
    const text = piLines.join("\n");
    assert.match(text, /╭.*nova/);
    assert.match(text, /✓ write\s+\+1\/-0 src\/a\.ts/);
    assert.match(text, /src\/a\.ts/);
    assert.match(text, /\+1.*export const value = 1;/);
    assert.match(text, /╰/);
    assertLinesFit(piLines, 80, "unified Pi/OMP write result");
  });

  it("normalizes official host edit diff strings into inline rows", () => {
    const result = { details: { ok: true, trace: [{
      name: "edit",
      args: { path: "official.ts" },
      ok: true,
      diff: " 9 before\n-10 old value\n+10 new value\n 11 after",
    }] } };
    const text = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, {}).render(90).join("\n");
    assert.match(text, /edit.*\+1\/-1.*official\.ts/);
    assert.match(text, /-10.*old value/);
    assert.match(text, /\+10.*new value/);
  });

  it("uses dynamic result trace instead of static source operations", () => {
    const args = { code: 'await read("static.txt");' };
    const context = { args, state: { trace: [{ name: "read", args: { path: "dynamic.txt" }, ok: true }] } };
    const result = { details: { ok: true, wallMs: 7 } };
    const text = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, context).render(80).join("\n");
    assert.match(text, /dynamic\.txt/);
    assert.doesNotMatch(text, /static\.txt/);
  });

  it("renders a program with no host calls as one status line, not an empty frame", () => {
    const result = { details: { ok: true, wallMs: 386, result: 42 } };
    const pi = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, { state: {}, args: { code: "return 42" } }).render(60);
    const omp = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, { code: "return 42" }).render(60);
    assert.deepEqual(pi, ["nova: complete · 386ms"]);
    assert.deepEqual(omp, pi);
    const expanded = renderSupernovaResult(result, { expanded: true, isPartial: false }, plainTheme, {}).render(60).join("\n");
    assert.match(expanded, /╭.*nova: complete · 386ms/);
    assert.match(expanded, /── result ──\s+│\n│ 42/);
  });

  it("keeps a compact completion card when no file edits occurred", () => {
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        ok: true,
        wallMs: 42,
        result: { mode: "parallel", lengths: [100, 200] },
      },
    };
    const comp = renderSupernovaResult(result, { expanded: false, isPartial: false }, mockTheme, {});
    const collapsed = comp.render(91).join("\n");
    assert.match(collapsed, /nova/);
    assert.match(collapsed, /complete/);
    assert.doesNotMatch(collapsed, /lengths/);

    const compExp = renderSupernovaResult(result, { expanded: true, isPartial: false }, mockTheme, {});
    const textExp = compExp.render(91).join("\n");
    assert.match(textExp, /── result ──/);
    assert.match(textExp, /lengths/);
  });

  it("renders error result cleanly without Done or success badge", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: "err" }],
      details: {
        ok: false,
        wallMs: 15,
        error: "read path escapes workspace",
        trace: [{ name: "read", args: { path: "outside.txt" } }],
      },
    };
    const comp = renderSupernovaResult(result, { expanded: false, isPartial: false }, mockTheme, {});
    const rendered = comp.render(91).join("\n");
    assert.match(rendered, /nova/);
    assert.match(rendered, /read path escapes workspace/);
    assert.match(rendered, /×/);
    assert.doesNotMatch(rendered, /✓/);
  });

  it("renders mixed command outcomes accurately", () => {
    const result = {
      isError: true,
      details: {
        ok: false,
        error: "second call failed",
        trace: [
          { name: "read", args: { path: "present.txt" }, ok: true },
          { name: "read", args: { path: "missing.txt" }, ok: false },
        ],
      },
    };
    const rendered = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, {}).render(91).join("\n");
    assert.match(rendered, /✓ read\s+present\.txt/);
    assert.match(rendered, /× read\s+missing\.txt/);
  });

  it("renders one aligned ledger row per call with duration and exit code", () => {
    const result = {
      details: {
        ok: true,
        wallMs: 6871,
        trace: [
          { name: "bash", args: { command: "python3 - <<'EOF'\nprint(1)\nEOF" }, ok: true, ms: 6210 },
          { name: "bash", args: { command: "pytest -q" }, ok: false, ms: 120, exitCode: 3 },
          { name: "read", args: { path: "b.ts" }, ok: true, ms: 3 },
        ],
      },
    };
    const lines = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, {}).render(80);
    assert.equal(lines.length, 5, "frame + 3 rows, no spacer rows");
    assert.match(lines[0], /nova: 3 calls · 6\.9s/);
    assert.match(lines[1], /✓ bash\s+6\.2s  python3 - <<'EOF' …\+2 lines/);
    assert.match(lines[2], /× bash\s+120ms  exit 3  pytest -q/);
    assert.match(lines[3], /✓ read\s+3ms  b\.ts/);
    // The column after the duration starts at the same offset on every row.
    const col = (line) => stripVTControlCharacters(line).search(/python3|exit 3|b\.ts/);
    assert.equal(col(lines[1]), col(lines[2]));
    assert.equal(col(lines[2]), col(lines[3]));
  });

  it("never emits a line wider than the terminal (Pi crash contract)", () => {
    const longNames = Array.from({ length: 40 }, (_, i) => `meta_tool_with_a_very_long_name_${i}`);
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        ok: true,
        wallMs: 4,
        result: { searchNames: longNames, describeOk: true, preview: "x".repeat(500) },
      },
    };
    const width = 91;
    const lines = renderSupernovaResult(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      {},
    ).render(width);
    assertLinesFit(lines, width, "expanded result");
  });

  it("clamps long ENOENT error paths (exact prior crash: 92 > 91)", () => {
    const err = `ENOENT: no such file or directory, open '${LONG_ENOENT_PATH}'`;
    // Real themes wrap with ANSI; reproduce that so we don't only test the plain path.
    const ansiTheme = {
      fg: (_t, text) => `\x1b[38;2;247;118;142m${text}\x1b[39m`,
      bold: (text) => text,
      dim: (text) => text,
    };
    const result = {
      isError: true,
      content: [{ type: "text", text: "err" }],
      details: { ok: false, error: err },
    };
    const width = 91;
    const lines = renderSupernovaResult(
      result,
      { expanded: false, isPartial: false },
      ansiTheme,
      {},
    ).render(width);
    assert.ok(lines.length >= 2, "expected error header + path line");
    assertLinesFit(lines, width, "ENOENT");
    // The exact failure mode: buggy truncate(maxWidth)+ellipsis === width+1.
    for (const line of lines) {
      assert.notEqual(piVisibleWidth(line), width + 1, "must not be classic off-by-one");
    }
  });

  it("clampLine / hardTruncate never return width+1 (ellipsis off-by-one)", () => {
    for (const w of [1, 2, 10, 91, 92]) {
      const line = "x".repeat(200);
      const out = clampLine(line, w);
      assert.ok(piVisibleWidth(out) <= w, `clampLine(${w}) => ${piVisibleWidth(out)}`);
      assert.ok(piVisibleWidth(hardTruncate(line, w)) <= w, `hardTruncate(${w})`);
      const safe = new SafeText(`  ENOENT: ${"p".repeat(300)}`);
      assertLinesFit(safe.render(w), w, `SafeText(${w})`);
    }
    // Exact prior crash shape at width 91 (synthetic path — same length class).
    const crash = `  ENOENT: no such file or directory, open '${LONG_ENOENT_PATH}'`;
    assert.equal(piVisibleWidth(crash) > 91, true);
    const fixed = clampLine(crash, 91);
    assert.ok(piVisibleWidth(fixed) <= 91);
    assert.notEqual(piVisibleWidth(fixed), 92);
    assert.equal(measureWidth("🚀"), 2);
    const wrappedEmoji = wrapPlainToWidth("a🚀b", 1);
    assert.deepEqual(wrappedEmoji, ["a", "…", "b"]);
    assert.ok(wrappedEmoji.every((line) => measureWidth(line) <= 1));
  });

  it("renders diff card with added/removed stats and gutter matching Screenshot 2", () => {
    const diff = {
      path: "packages/pi-supernova/host-bridge.js",
      op: "edit",
      added: 2,
      removed: 1,
      lines: [
        { type: "context", lineNum: 142, text: "function resolveWorkspacePath(...) {" },
        { type: "remove", lineNum: 143, text: "const target = path.resolve(cwd, \"\");" },
        { type: "add", lineNum: 143, text: "if (!isString(inputPath)) throw ...;" },
        { type: "add", lineNum: 144, text: "const target = resolveWorkspacePath(...);" },
        { type: "context", lineNum: 145, text: "if (signal?.aborted) return;" },
      ],
    };

    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        ok: true,
        wallMs: 84,
        trace: [{ name: "edit", diff }],
      },
    };

    const comp = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, {});
    const lines = comp.render(140);
    assertLinesFit(lines, 140, "diff card");
    const rendered = lines.join("\n");
    assert.match(rendered, /nova.*1 call/);
    assert.match(rendered, /edit/);
    assert.match(rendered, /host-bridge\.js/);
    assert.match(rendered, /\+2/);
    assert.match(rendered, /-1/);
    assert.match(rendered, /resolveWorkspacePath/);
    assert.match(rendered, /143/);

    const expanded = renderSupernovaResult(result, { expanded: true, isPartial: false }, plainTheme, {}).render(140).join("\n");
    assert.doesNotMatch(expanded, /── changes ──/);
    assert.match(expanded, /resolveWorkspacePath/);
    assert.match(expanded, /143/);

    // Stats survive narrow width because they precede the path.
    const narrow = comp.render(40).join("\n");
    assert.match(narrow, /\+2/);
    assert.match(narrow, /-1/);
    assertLinesFit(comp.render(40), 40, "narrow diff");
  });

  it("shows bounded mutation hunks collapsed and a larger hunk when expanded", () => {
    const diff = {
      path: "many-lines.ts",
      op: "write",
      added: 12,
      removed: 0,
      displayLineCount: 12,
      lines: Array.from({ length: 12 }, (_, index) => ({ type: "add", lineNum: index + 1, text: `line ${index + 1}` })),
    };
    const result = { details: { ok: true, trace: [{ name: "write", ok: true, diff }] } };
    const collapsed = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, {}).render(100).join("\n");
    assert.match(collapsed, /line 8/);
    assert.doesNotMatch(collapsed, /line 9/);
    assert.match(collapsed, /4 more lines/);
    const expanded = renderSupernovaResult(result, { expanded: true, isPartial: false }, plainTheme, {}).render(100).join("\n");
    assert.match(expanded, /line 12/);
    assert.doesNotMatch(expanded, /more lines/);
  });

  it("cleans up raw result JSON dump and formats output lines without ok/value noise when expanded", () => {
    const rawToolOutput = {
      ok: true,
      value: "\n> pi-supernova@0.1.0 test\n> node --test test/*.test.mjs\n",
      truncated: false,
      isError: false,
    };
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        ok: true,
        wallMs: 174,
        result: rawToolOutput,
      },
    };
    const comp = renderSupernovaResult(result, { expanded: true, isPartial: false }, mockTheme, {});
    const rendered = comp.render(140).join("\n");
    assert.match(rendered, /pi-supernova@0\.1\.0 test/);
  });


  it("compacts multi-file edits when more than 2 files changed", () => {
    const makeDiff = (p) => ({
      path: p,
      op: "edit",
      added: 1,
      removed: 1,
      lines: [{ type: "add", lineNum: 1, text: "added" }],
    });

    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        ok: true,
        wallMs: 95,
        trace: [
          { name: "edit", diff: makeDiff("file1.ts") },
          { name: "edit", diff: makeDiff("file2.ts") },
          { name: "edit", diff: makeDiff("file3.ts") },
          { name: "edit", diff: makeDiff("file4.ts") },
        ],
      },
    };

    const compCollapsed = renderSupernovaResult(result, { expanded: false, isPartial: false }, plainTheme, {});
    const collapsedLines = compCollapsed.render(140);
    assertLinesFit(collapsedLines, 140, "collapsed multi-diff");
    const textCollapsed = collapsedLines.join("\n");
    assert.match(textCollapsed, /file1\.ts/);
    assert.match(textCollapsed, /file2\.ts/);
    assert.match(textCollapsed, /file3\.ts/);
    assert.match(textCollapsed, /file4\.ts/);
    assert.match(textCollapsed, /added/);
    assert.doesNotMatch(textCollapsed, /── changes ──/);

    const compExpanded = renderSupernovaResult(result, { expanded: true, isPartial: false }, plainTheme, {});
    const expandedLines = compExpanded.render(140);
    assertLinesFit(expandedLines, 140, "expanded multi-diff");
    const textExpanded = expandedLines.join("\n");
    assert.match(textExpanded, /file1\.ts/);
    assert.match(textExpanded, /file2\.ts/);
    assert.match(textExpanded, /file3\.ts/);
    assert.match(textExpanded, /file4\.ts/);
    assert.match(textExpanded, /added/);
    assert.doesNotMatch(textExpanded, /── changes ──/);
  });

  it("keeps partial execution visible when live trace updates replace the call card", () => {
    const result = {
      content: [{ type: "text", text: "" }],
      details: { trace: [{ name: "snap", args: { query: "auth token", path: "src" } }], running: true },
    };
    const omp = renderSupernovaResult(
      result,
      { expanded: false, isPartial: true },
      plainTheme,
      { code: `await snap("auth token", "src");` },
    ).render(80).join("\n");
    assert.match(omp, /nova: 1 call · running/);
    assert.match(omp, /snap/);
    assert.match(omp, /"auth token" → src/);

    const pi = renderSupernovaResult(
      result,
      { expanded: false, isPartial: true },
      plainTheme,
      { state: {}, args: { code: `await snap("auth token", "src");` } },
    ).render(80).join("\n");
    assert.match(pi, /nova: 1 call · running/);
    assert.match(pi, /snap/);

    const custom = renderSupernovaResult(
      { content: [{ type: "text", text: "" }], details: { trace: [{ name: "custom_tool", args: { action: "run" } }] } },
      { expanded: false, isPartial: true },
      plainTheme,
      { code: `await nova.call("custom_tool", { action: "run" });` },
    ).render(80).join("\n");
    assert.match(custom, /custom_tool/);
  });

  it("accounts for emoji-presentation variation selectors", () => {
    assert.equal(measureWidth("❤️"), 2);
    assert.ok(measureWidth(clampLine("❤️x", 2)) <= 2);
  });

  it("never exceeds ultra-narrow OMP render widths", () => {
    const result = { details: { trace: [{ name: "custom_tool", args: { query: "value" } }] } };
    for (const width of [1, 2, 4, 7]) {
      const lines = renderSupernovaResult(
        result,
        { expanded: false, isPartial: true },
        plainTheme,
        { code: `await nova.call("custom_tool", {});` },
      ).render(width);
      assertLinesFit(lines, width, `OMP width ${width}`);
    }
  });

  it("strips terminal controls and renders error logs once", () => {
    const result = {
      isError: true,
      details: {
        ok: false,
        error: "boom\u001b[2J\u0007\u0008\u202e",
        logs: ["one-log\u001b[31m\u0000"],
        trace: [{ name: "read", args: { path: "src/a.js\nspoof" } }],
      },
    };
    const text = renderSupernovaResult(
      result,
      { expanded: true, isPartial: false },
      plainTheme,
      { code: `await read("src/a.js");` },
    ).render(100).join("\n");
    for (const control of ["\u001b", "\u0000", "\u0007", "\u0008", "\u202e"]) {
      assert.equal(text.includes(control), false);
    }
    assert.match(text, /src\/a\.js spoof/);
    assert.equal(text.match(/one-log/g)?.length, 1);
  });

});
