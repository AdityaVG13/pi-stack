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
