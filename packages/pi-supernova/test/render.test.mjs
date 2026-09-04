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
  paintNovaRow,
  NOVA_CHROME,
  normalizeCallRenderArgs,
} from "../render.js";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";

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
  if (typeof tui.visibleWidth === "function") piVisibleWidth = tui.visibleWidth;
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
    assert.equal(ops.length, 3);
    assert.equal(ops[0].tool, "read");
    assert.equal(ops[0].target, "package.json");
    assert.equal(ops[1].tool, "bash");
    assert.equal(ops[1].target, "git status");
    assert.equal(ops[2].tool, "search");
    assert.equal(ops[2].target, '"testing"');
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
    const rendered = renderSupernovaCall({ code }, mockTheme, { state: { wallMs: 12 } }).render(160).join("\n");
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

  it("renders call with bordered-tool aesthetic (title · timing, aligned ops)", () => {
    const args = {
      code: 'await nova.call("read", { path: "package.json" });',
    };
    const comp = renderSupernovaCall(args, mockTheme, {
      args,
      state: { wallMs: 84 },
      isPartial: false,
    });
    const rendered = comp.render(91).join("\n");
    assert.match(rendered, /\[toolTitle\]<b>nova<\/b>\[\/toolTitle\]/);
    assert.match(rendered, /· 84ms/);
    assert.match(rendered, /\[syntaxFunction\]read\s*\[\/syntaxFunction\]/);
    assert.match(rendered, /\[muted\]package\.json\[\/muted\]/);
    assert.ok(rendered.includes("[accent]▤ [/accent]"));
    assert.doesNotMatch(rendered, /\{/);
    // Self-framed card: purple bg wash like Pi's Box (no side-rail chars).
    assert.match(rendered, /\x1b\[48;2;/);
    assert.doesNotMatch(rendered, /"code":/);
    assert.doesNotMatch(rendered, /▌/);
  });

  it("paints muted violet/grey-blue chrome within terminal width", () => {
    const row = paintNovaRow("nova · 12ms", 91, "success");
    assert.ok(piVisibleWidth(row) <= 91);
    assert.match(row, /\x1b\[48;2;24;30;46m/); // successBg
    assert.equal(NOVA_CHROME.successBg[2], 46);
  });

  it("accepts OMP renderCall signature (args, options, theme) without throwing", () => {
    const theme = {
      fg: (_t, text) => text,
      bold: (text) => text,
      dim: (text) => text,
    };
    const options = { expanded: false, isPartial: true, executionStarted: true };
    const args = { code: 'await read("package.json");' };
    // OMP order — if we treated options as theme, theme.fg would throw.
    const comp = renderSupernovaCall(args, options, theme);
    const lines = comp.render(80);
    assert.ok(lines.length > 0);
    const text = lines.join("\n");
    assert.match(text, /nova/);
    assert.match(text, /package\.json/);
    assert.doesNotMatch(text, /"code":/);
    // OMP uses rounded framedBlock chrome (same geometry as native write/edit).
    assert.match(text, /╭/);
    assert.match(text, /╰/);
    assert.doesNotMatch(text, /\x1b\[48;2;/); // not the Pi violet wash
    const norm = normalizeCallRenderArgs(args, options, theme);
    assert.equal(norm.host, "omp");
    assert.equal(norm.theme, theme);
    assertLinesFit(lines, 80, "omp framed call");
  });

  it("OMP result cards frame diffs like native write/edit", () => {
    const theme = {
      fg: (_t, text) => text,
      bold: (text) => text,
      dim: (text) => text,
    };
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        ok: true,
        wallMs: 12,
        trace: [
          {
            name: "write",
            diff: {
              path: "a.ts",
              op: "write",
              added: 1,
              removed: 0,
              lines: [{ type: "add", lineNum: 1, text: "hi" }],
            },
          },
        ],
      },
    };
    // 4th arg with `code` marks OMP (args), not Pi context.
    const lines = renderSupernovaResult(result, { expanded: false, isPartial: false }, theme, {
      code: 'await write("a.ts", "hi");',
    }).render(80);
    const text = lines.join("\n");
    assert.match(text, /╭/);
    assert.match(text, /nova/);
    assert.match(text, /a\.ts/);
    assertLinesFit(lines, 80, "omp framed result");
  });

  it("still accepts Pi renderCall signature (args, theme, context)", () => {
    const theme = {
      fg: (_t, text) => text,
      bold: (text) => text,
      dim: (text) => text,
    };
    const context = { state: { wallMs: 12 }, isPartial: false };
    const comp = renderSupernovaCall({ code: 'await read("a.ts");' }, theme, context);
    assert.match(comp.render(80).join("\n"), /· 12ms/);
    assert.equal(normalizeCallRenderArgs({ code: "x" }, theme, context).host, "pi");
  });

  it("prefers dynamic execution trace over static parse when available", () => {
    const args = { code: '// empty' };
    const context = {
      args,
      state: {
        trace: [
          { name: "read", args: { path: "foo.txt" } },
          { name: "apply_patch", args: { path: "patch.diff" } },
        ],
      },
    };
    const comp = renderSupernovaCall(args, mockTheme, context);
    const rendered = comp.render(91).join("\n");
    assert.match(rendered, /read/);
    assert.match(rendered, /patch/);
    assert.match(rendered, /foo\.txt/);
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

  it("embeds elapsed time directly at the top header of renderCall", () => {
    const args = { code: 'read("package.json");' };
    const context = {
      args,
      state: { wallMs: 42 },
    };
    const comp = renderSupernovaCall(args, mockTheme, context);
    const rendered = comp.render(91).join("\n");
    assert.match(rendered, /nova.*· 42ms/);
  });

  it("wraps long paths instead of end-truncating mid-segment (screenshot regression)", () => {
    const args = {
      code: 'await read("packages/pi-supernova/host-bridge.js"); await edit("packages/pi-supernova/diff.js", "a", "b");',
    };
    const lines = renderSupernovaCall(args, plainTheme, { state: { wallMs: 84 } }).render(40);
    assertLinesFit(lines, 40, "narrow call wrap");
    const text = lines.join("\n");
    // Filename must survive intact — old UI died as packages/pi-supern…
    assert.match(text, /host-bridge\.js/);
    assert.match(text, /diff\.js/);
    assert.doesNotMatch(text, /pi-supern…/);
    assert.doesNotMatch(text, /host-\n/);
  });

  it("renders error result cleanly without Done or success badge", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: "err" }],
      details: {
        ok: false,
        wallMs: 15,
        error: "read path escapes workspace",
      },
    };
    const comp = renderSupernovaResult(result, { expanded: false, isPartial: false }, mockTheme, {});
    const rendered = comp.render(91).join("\n");
    assert.match(rendered, /nova/);
    assert.match(rendered, /read path escapes workspace/);
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
    assert.doesNotMatch(rendered, /resolveWorkspacePath|143/);

    const expanded = renderSupernovaResult(result, { expanded: true, isPartial: false }, plainTheme, {}).render(140).join("\n");
    assert.match(expanded, /── changes ──/);
    assert.match(expanded, /✎/);
    assert.match(expanded, /143/);

    // Stats survive narrow width because they precede the path.
    const narrow = comp.render(40).join("\n");
    assert.match(narrow, /\+2/);
    assert.match(narrow, /-1/);
    assertLinesFit(comp.render(40), 40, "narrow diff");
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
    assert.doesNotMatch(textCollapsed, /added|── changes ──/);

    const compExpanded = renderSupernovaResult(result, { expanded: true, isPartial: false }, plainTheme, {});
    const expandedLines = compExpanded.render(140);
    assertLinesFit(expandedLines, 140, "expanded multi-diff");
    const textExpanded = expandedLines.join("\n");
    assert.match(textExpanded, /file1\.ts/);
    assert.match(textExpanded, /file2\.ts/);
    assert.match(textExpanded, /file3\.ts/);
    assert.match(textExpanded, /file4\.ts/);
    assert.match(textExpanded, /── changes ──/);
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
    assert.match(pi, /nova · 1 call · running/);
    assert.match(pi, /snap/);
  });

});
