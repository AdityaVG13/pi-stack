import test from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { renderSupernovaResult } from "../../index.js";
import { engineFixture } from "../helpers/engine.mjs";

const theme = { fg: (_, text) => text, bg: (_, text) => text, bold: text => text };

test("actual edit results remain readable and fresh across repaint and terminal resize", async t => {
  const f = await engineFixture(t);
  await f.write("unicode-😀.js", "export const value = \"中👩‍💻é\";\n");
  const context = {state:{}};

  for (const value of ["first", "second"]) {
    const result = await f.execute(`return await write("unicode-😀.js", ${JSON.stringify("export const " + value + " = \"中👩‍💻é\";\n")});`);

    for (const expanded of [false, true]) {
      const card = renderSupernovaResult(result, {expanded}, theme, context);
      assert.match(card.render(120).join("\n"), new RegExp("export const " + value), "new results must replace a same-width cached card");

      for (const width of [1, 2, 40, 80, 120]) {
        const lines = card.render(width);
        assert.ok(lines.length);

        for (const line of lines) assert.ok(stringWidth(line) <= width, "rendered text must fit the terminal");

        if (width === 120) assert.match(lines.join("\n"), new RegExp("export const " + value));
      }

      card.invalidate();
      assert.match(card.render(120).join("\n"), new RegExp("export const " + value));
    }
  }

  const error = await f.execute('throw Error("visible failure sentinel");').then(() => assert.fail("must reject"), e => e);
  const card = renderSupernovaResult({isError:true,content:[{type:"text",text:error.message}]}, {expanded:true}, theme, context);
  assert.match(card.render(80).join("\n"), /visible failure sentinel/);
});

test("omp host box leaves no unpainted trailing bar on framed result rows", async t => {
  // Faithful to OMP's host path for unmarked extension renderers: the tool
  // block pads one column per side and wraps every padded row once with the
  // plain state bg (tool-execution contentBox + box pushRow), while theme fg
  // resets only the foreground and theme bg wraps without stabilization
  // (theme-class fg/bg). A second bg wrap inside the child would clear the
  // outer bg with \x1b[49m and strand the host's right pad unpainted.
  const BG = "\x1b[48;5;236m";
  const ompTheme = {
    fg: (_, text) => `\x1b[38;5;252m${text}\x1b[39m`,
    bg: (_, text) => `${BG}${text}\x1b[49m`,
    getBgAnsi: () => BG,
  };
  const hostBoxRow = line => `${BG} ${line} \x1b[49m`;
  const trailingUnpainted = row => {
    const cells = [];
    let bg = false;
    // eslint-disable-next-line no-control-regex -- intentional ANSI SGR recognition
    for (const m of row.matchAll(/\x1b\[([0-9;]*)m|[^\x1b]/g)) {
      if (m[0].startsWith("\x1b")) {
        if (m[1] === "49" || m[1] === "0" || m[1] === "") bg = false;
        else if (m[1].startsWith("48")) bg = true;
      } else cells.push(bg);
    }
    let trailing = 0;
    for (let i = cells.length - 1; i >= 0 && !cells[i]; i--) trailing++;
    return trailing;
  };

  const f = await engineFixture(t);
  await f.write("doc.md", "line one\nline two\n");
  const result = await f.execute('await edit("doc.md", "line two", "line TWO"); await bash("echo hi"); await bash("echo yo"); return "done";');
  const card = renderSupernovaResult(result, {expanded:false, isPartial:false}, ompTheme, {code:"x"});
  const lines = card.render(100);
  assert.ok(lines.length > 2, "framed card must render header, body and footer rows");

  for (const line of lines) {
    assert.equal(stringWidth(line), 100, "framed child row must exactly fill the host content width");
    assert.equal(trailingUnpainted(hostBoxRow(line)), 0, "host right pad must keep the outer bg on every row");
  }
});

test("a real program coalesces progress without changing delivered frames or emitting after completion", async t => {
  const f = await engineFixture(t);
  const frames = [];

  const result = await f.tool.execute("progress", {code:'for(let i=0;i<250;i++) await write("state.txt", String(i)); return await read("state.txt");'}, undefined, frame => {
    frames.push({frame, snapshot:JSON.stringify(frame)});
  }, {cwd:f.root});

  assert.equal(result.details.result, "249");
  assert.ok(frames.length > 0 && frames.length < 250, "progress must not repaint once per operation");

  for (const {frame,snapshot} of frames) assert.equal(JSON.stringify(frame), snapshot);
  const count = frames.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(frames.length, count, "no delayed progress after result delivery");
  const healthy = await f.tool.execute("broken-ui", {code:'return await read("state.txt");'}, undefined, () => {throw Error("UI callback failed");}, {cwd:f.root});
  assert.equal(healthy.details.result, "249");
});
