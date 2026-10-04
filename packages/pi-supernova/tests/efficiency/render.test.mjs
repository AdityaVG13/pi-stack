import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import stringWidth from "string-width";
import { renderSupernovaResult } from "../../index.js";
import { engineFixture } from "../helpers/engine.mjs";
import {wrapLine} from "../../src/ui/render-measure.js";
import {progressEmitter} from "../../src/ui/progress.js";

const theme = { fg: (_, text) => text, bg: (_, text) => text, bold: text => text };

test("a completed JavaScript-only batch is shown as execution, not an absence of calls", async t => {
  const f = await engineFixture(t);
  const result = await f.tool.execute("pure-batch", {code:"return data;", data:{shared:true}, programs:[{}, {data:{local:true}}, {data:null}]}, undefined, undefined, {cwd:f.root});
  assert.deepEqual(result.details.result, [{shared:true}, {local:true}, null]);

  for (const expanded of [false, true]) {
    const card = renderSupernovaResult(result, {expanded}, theme, {state:{}});
    const text = card.render(120).join("\n");
    assert.match(text, /JavaScript-only execution/);
    assert.doesNotMatch(text, /no adapter calls/);

    for (const width of [1, 2, 40, 80, 120]) for (const line of card.render(width)) assert.ok(stringWidth(line) <= width);
  }
});

test("host error flags preserve thrown diagnostics and replace cached success styling", async t => {
  const f = await engineFixture(t);
  const failure = await f.execute('await edit(async()=>{await write("undone.txt","candidate"); throw Error("thrown-ui-sentinel");});').then(() => assert.fail("must reject"), error => error);
  const trace = failure.supernovaResult.details.trace;
  const result = {content:[{type:"text",text:failure.message}]};

  for (const host of ["pi", "omp"]) {
    const state = {trace};
    const context = host === "pi" ? {state,isError:false} : {code:"throw Error()"};
    const options = {expanded:false,isPartial:true,state,isError:false};
    renderSupernovaResult({details:{ok:true,trace}}, options, theme, context).render(120);
    context.isError = host === "pi";
    options.isPartial = false;
    options.isError = host === "omp";

    for (const expanded of [false,true]) {
      options.expanded = expanded;
      const card = renderSupernovaResult(result, options, theme, context);
      const text = card.render(120).join("\n");
      assert.match(text, /failed/);
      assert.match(text, /thrown-ui-sentinel/);
      assert.doesNotMatch(text, /JavaScript-only execution|nova: complete|✓\s+write/);

      for (const width of [1,2,40,80,120]) for (const line of card.render(width)) assert.ok(stringWidth(line) <= width);
    }
  }

  await assert.rejects(fs.access(f.root+"/undone.txt"), {code:"ENOENT"});
  const plain = renderSupernovaResult({content:[{type:"text",text:"error handling documentation"}]}, {expanded:false}, theme, {state:{},isError:false}).render(120).join("\n");
  assert.match(plain, /error handling documentation/);
  assert.doesNotMatch(plain, /failed|JavaScript-only execution/);
});

test("failed batches show the original cause and mixed commit/rollback totals without false write ticks", async t => {
  const f = await engineFixture(t);

  const result = await f.tool.execute("batch-ui", {programs:[
    {code:'await write("kept.txt","kept"); return "first";'},
    {code:'await edit(async()=>{await write("undone.txt","candidate"); throw Error("batch-ui-sentinel");});'},
    {code:'await write("unstarted.txt","BAD");'},
  ]}, undefined, undefined, {cwd:f.root});

  const snapshot = JSON.stringify(result);

  for (const expanded of [false,true]) {
    const card = renderSupernovaResult(result, {expanded}, theme, {state:{}});
    const text = card.render(120).join("\n");
    assert.match(text, /batch-ui-sentinel/);
    assert.match(text, /committed=2.*rolledBack=1/);
    assert.match(text, /✓\s+write.*saved kept.txt/);
    assert.match(text, /rolled back undone.txt/);
    assert.doesNotMatch(text, /✓\s+write[^\n]*undone.txt/);

    for (const width of [1,2,40,80,120]) for (const line of card.render(width)) assert.ok(stringWidth(line) <= width);
  }

  assert.equal(JSON.stringify(result), snapshot, "rendering must not mutate execution evidence");
  assert.equal(await fs.readFile(f.root+"/kept.txt","utf8"), "kept");

  await assert.rejects(fs.access(f.root+"/undone.txt"), {code:"ENOENT"});
  assert.equal(await fs.readFile(f.root+"/unstarted.txt","utf8"), "BAD");
});

test("recovered checkpoint rollback remains visible without marking the successful program failed", async t => {
  const f = await engineFixture(t);
  const result = await f.execute('await write("kept.txt","kept"); await edit(async()=>{await write("undone.txt","candidate");throw Error("recover");}).catch(()=>{}); return "recovered";');
  const card = renderSupernovaResult(result, {expanded:true}, theme, {state:{}});
  const text = card.render(120).join("\n");
  assert.match(text, /committed=1.*rolledBack=1/);
  assert.match(text, /recovered/);
  assert.doesNotMatch(text, /failed|✓\s+write[^\n]*undone.txt/);
  assert.match(text, /saved kept.txt/);
  assert.match(text, /rolled back undone.txt/);
});

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


test("the latest call window stays in place from live progress to completion", () => {
  const trace = Array.from({length:14}, (_, i) => ({name:"read",args:{path:`call-${String(i+1).padStart(2,"0")}.js`},ok:true,ms:2}));
  const snapshot = JSON.stringify(trace);

  for (const host of ["pi","omp"]) {
    const options = {expanded:false,isPartial:true,state:{}};
    const context = host === "pi" ? {state:{}} : {code:"return 'checks passed';"};
    const live = renderSupernovaResult({details:{trace}},options,theme,context).render(120).join("\n");
    options.isPartial = false;
    const done = renderSupernovaResult({details:{ok:true,trace,result:"checks passed"}},options,theme,context).render(120).join("\n");
    const paths = text => text.match(/call-\d+\.js/g);
    const expected = trace.slice(-8).map(row=>row.args.path);
    assert.deepEqual(paths(live),expected);
    assert.deepEqual(paths(done),expected,"Completion must not jump back to the earliest calls");
    assert.doesNotMatch(done,/checks passed/,"Returned content stays behind expansion when calls are visible");
    assert.match(done,/complete/);
    assert.match(live,/6 earlier calls/);
    assert.match(done,/6 earlier calls/);
    options.expanded = true;
    assert.match(renderSupernovaResult({details:{ok:true,trace,result:"checks passed"}},options,theme,context).render(120).join("\n"),/call-01\.js/);
  }

  assert.equal(JSON.stringify(trace),snapshot);
});

test("collapsed edits preview only the latest change without ballooning the card", () => {
  const trace = Array.from({length:16}, (_, i) => ({name:"edit",args:{path:`file-${i+1}.js`},ok:true,ms:3,
    diff:{path:`file-${i+1}.js`,added:12,removed:12,lines:Array.from({length:24},(_,j)=>({type:j%2?"add":"remove",lineNum:j+1,text:`change-${i+1}-${j}`}))}}));

  // Literal filename controls/newlines must not add rows to the latest caption.
  trace.at(-1).args.path += "\n".repeat(20) + "\x1b[2Jtrailing";
  const result = {details:{ok:true,trace,result:"checks passed",mutations:{committed:16}}};
  const snapshot = JSON.stringify(result);

  for (const host of ["pi","omp"]) {
    const context = host === "pi" ? {state:{}} : {code:"edit"};
    const options = {expanded:false,isPartial:false,state:{}};
    const compact = renderSupernovaResult(result,options,theme,context).render(80);
    assert.ok(compact.length<=26,"One collapsed card must not fan out into eight separate diff blocks");
    assert.match(compact.join("\n"),/latest change.*file-16\.js/);
    assert.match(compact.join("\n"),/change-16-0/);
    assert.doesNotMatch(compact.join("\n"),/change-9-0/);
    assert.doesNotMatch(compact.join("\n"),/checks passed/);
    options.expanded = true;
    const expanded = renderSupernovaResult(result,options,theme,context).render(120).join("\n");
    assert.match(expanded,/change-1-0/);
    assert.match(expanded,/change-16-23/);
    assert.match(expanded,/checks passed/);
    options.expanded = false;
    const failed = renderSupernovaResult({...result,details:{...result.details,trace:trace.map((op,i)=>i===trace.length-1?{...op,ok:false}:op),ok:false,error:"failure-sentinel\n"+"stack detail\n".repeat(100),mutations:{rolledBack:16}}},options,theme,context).render(80);
    assert.ok(failed.length<=30,"Collapsed diagnostics also need a visual-line budget");
    assert.match(failed.join("\n"),/failure-sentinel/);
    assert.match(failed.join("\n"),/latest attempted change/);
    assert.doesNotMatch(failed.join("\n"),/checks passed/);
  }

  assert.equal(JSON.stringify(result),snapshot);
});

test("large raw result details use an explicit bounded UI preview without modifying the value", () => {
  const value = "visible-head\n" + "x".repeat(25000) + "raw-value-middle" + "x".repeat(25000) + "\nraw-value-tail";
  const result = {details:{ok:true,trace:[],result:value,returnTruncated:true}};
  const options = {expanded:true,isPartial:false};
  const context = {state:{}};
  const card = renderSupernovaResult(result,options,theme,context);
  const rows = card.render(80);
  const expanded = rows.join("\n");
  const displayed = rows.filter(row=>row.startsWith("│ ")).map(row=>row.slice(2,-2).trimEnd()).join("");
  assert.ok(rows.length<=450,"The expanded preview must respect its 32k text budget before layout");
  assert.match(expanded,/visible-head/);
  assert.match(expanded,/UI preview.*clipped/);
  // Existing head/tail clipping deliberately retains diagnostic endings.
  assert.ok(!displayed.includes("raw-value-middle"),"The omitted middle must not be laid out as a complete value");
  assert.equal(result.details.result,value);
  card.invalidate();
  options.expanded = false;
  const compact = renderSupernovaResult(result,options,theme,context).render(80);
  assert.ok(compact.length<=12);
  assert.match(compact.join("\n"),/UI preview.*clipped/);

  for (const width of [1,2,40,80,120]) for (const line of card.render(width)) assert.ok(stringWidth(line)<=width);
});


test("bulk ASCII wrapping and Unicode fallback preserve text across column budgets", () => {
  const samples = [" leading and trailing text ","tabs\tstay\tvisible","中👩‍💻é Greek λ emoji 😀 and tail", "é".repeat(60)];

  for (const text of samples) for (const width of [2,3,7,32,76]) {
    const rows = wrapLine(text,width);
    assert.equal(rows.join(""),text.replaceAll("\t","   "));

    for (const row of rows) assert.ok(stringWidth(row)<=width);
  }

  const ascii = "0123456789".repeat(100);
  const rows = wrapLine(ascii,7.5);
  assert.equal(rows.join(""),ascii,"Fractional inputs must still use whole terminal columns without losing characters");

  for (const row of rows) assert.ok(stringWidth(row)<=7);
});


test("32ms progress frame delivers the latest state and cancels pending repaint on completion", t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let now = 0;
  t.mock.method(performance,"now",()=>now);
  const frames = [];
  const emit = progressEmitter(frame=>frames.push(frame));

  try {
    emit([]);
    const first = {name:"read",args:{path:"first.js"}};
    emit([first]);
    const latest = {name:"read",args:{path:"latest.js"}};
    emit([first,latest]);
    now = 31;
    t.mock.timers.tick(31);
    assert.equal(frames.length,1,"Changes inside a frame must stay coalesced");
    now = 32;
    t.mock.timers.tick(1);
    assert.deepEqual(frames[1]?.details.trace,[first,latest],"The live card must receive the newest state within one 32ms frame");
    latest.ok = true;
    assert.equal(frames[1].details.trace[1].ok,undefined,"Previously displayed state must stay immutable");
    emit([first,latest]);
    emit.flush();
    now = 200;
    t.mock.timers.tick(168);
    assert.equal(frames.length,2,"Completion must cancel its queued repaint");
  } finally {emit.flush();}
});


test("Unicode result geometry survives repaint without stale content, colors or width", t => {
  const value = "中👩‍💻é cache λ refresh 😀 ".repeat(1100);
  const result = {details:{ok:true,trace:[],result:value}};
  const context = {state:{}};
  const options = {expanded:false};
  let color = "\x1b[31m";
  const repaintTheme = {fg:(_,text)=>color+text+"\x1b[39m",bg:(_,text)=>text};
  const card = renderSupernovaResult(result,options,repaintTheme,context);
  const first = card.render(80);
  const segment = Intl.Segmenter.prototype.segment;

  const guard = t.mock.method(Intl.Segmenter.prototype,"segment",function(text) {
    // Repaint must not redo full-value layout; short chrome/row measurements
    // may still use the Unicode oracle after a palette change.
    assert.ok(text.length < 1000,"Repaint must reuse the existing result geometry");

    return segment.call(this,text);
  });

  try {
    card.invalidate();
    assert.deepEqual(card.render(80),first);
    color = "\x1b[32m";
    const repainted = renderSupernovaResult(result,options,repaintTheme,context);
    assert.equal(repainted,card);
    const rows = repainted.render(80);
    assert.ok(rows.join("\n").includes("\x1b[32m"),"Palette changes must repaint the result");
    assert.ok(!rows.join("\n").includes("\x1b[31m"),"Previous colors must not survive invalidation");
    options.expanded = true;
    const expanded = renderSupernovaResult(result,options,repaintTheme,context).render(80);
    assert.ok(expanded.length > rows.length);
    assert.equal(result.details.result,value);
  } finally {guard.mock.restore();}

  for (const width of [40,80,120]) {
    const rows = card.render(width);

    for (const row of rows) assert.ok(stringWidth(row)<=width);
    const fresh = renderSupernovaResult(result,options,repaintTheme,{state:{}}).render(width);
    assert.deepEqual(rows,fresh,"Resizing must rebuild the same geometry as a new card");
  }

  result.details.result = {message:"first-value"};
  const before = renderSupernovaResult(result,options,repaintTheme,context).render(80).join("\n");
  assert.match(before,/first-value/);
  result.details.result.message = "latest-value";
  const after = renderSupernovaResult(result,options,repaintTheme,context).render(80).join("\n");
  assert.match(after,/latest-value/);
  assert.doesNotMatch(after,/first-value/);
});


test("collapsed read cards keep source and JSON results behind expansion", async t => {
  const f = await engineFixture(t);
  const source = "raw-result-sentinel\nsource body\n";
  await f.write("README.md",source);
  await f.write("next.txt","second-result-sentinel\n");

  for (const code of ['return await read("README.md");','return await read(["README.md","next.txt"]);']) {
    const result = await f.execute(code);
    const value = code.includes("next.txt") ? [source,"second-result-sentinel\n"] : source;
    assert.deepEqual(result.details.result,value);
    const snapshot = JSON.stringify(result);

    for (const host of ["pi","omp"]) {
      const options = {expanded:false,isPartial:false,state:{}};
      const context = host === "pi" ? {state:{}} : {code};
      const card = renderSupernovaResult(result,options,theme,context);
      const compact = card.render(120);
      assert.match(compact.join("\n"),/README\.md/);
      assert.doesNotMatch(compact.join("\n"),/raw-result-sentinel|second-result-sentinel|more result lines/);
      assert.ok(compact.length<=4,"Default read cards must not grow a returned-content body");
      options.expanded = true;
      const expanded = renderSupernovaResult(result,options,theme,context).render(120).join("\n");
      assert.match(expanded,/raw-result-sentinel/);

      if (Array.isArray(value)) assert.match(expanded,/second-result-sentinel/);
    }

    assert.equal(JSON.stringify(result),snapshot,"Hiding the UI preview must not change returned values");
  }
});

test("saved edits stay visibly saved after a failed test command", async t => {
  const f = await engineFixture(t);
  const error = await f.execute('await write("saved.txt","saved");await bash({command:process.execPath,args:["-e","process.exit(1)"]});').then(()=>assert.fail("test command must fail"),error=>error);
  assert.equal(error.supernovaResult.details.mutations.committed, 1);
  assert.equal(error.supernovaResult.details.mutations.rolledBack, 0);
  assert.equal(await fs.readFile(f.root + "/saved.txt", "utf8"), "saved");

  for (const host of ["pi", "omp"]) for (const expanded of [false, true]) for (const result of [error.supernovaResult,{content:error.supernovaResult.content}]) {
    const options = {expanded, isError:true, state:{trace:error.supernovaResult.details.trace}};
    const context = host === "pi" ? {state:options.state,isError:true} : {code:"failed test"};
    const card = renderSupernovaResult(result, options, theme, context);
    const text = card.render(140).join("\n");
    assert.match(text, /partial/);
    assert.match(text, /✓\s+write[^\n]*saved\s+saved.txt/);
    assert.doesNotMatch(text, /attempted saved.txt|latest attempted change/);
    assert.match(text, /exit 1|command failed/);

    for (const width of [1,2,40,80,140]) for (const line of card.render(width)) assert.ok(stringWidth(line) <= width);
  }
});
