import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runGuestProgram } from "../../src/runtime/runtime.js";
import { engineFixture, limits } from "../helpers/engine.mjs";

it("the guest exposes exactly four command bindings, without legacy helpers or dispatch escape hatches", async () => {
  const names = ["read", "edit", "write", "bash", "nova", "exec", "patch", "snap", "surface", "evidence", "speculate", "parallel", "pipeline", "search", "describe", "call", "callMany"];
  const code = `return {${names.map(name => `${name}: typeof ${name}`).join(",")}};`;
  const result = await runGuestProgram({ code, nova: {}, config: limits });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.entries(result.result).filter(([, type]) => type !== "undefined").map(([name]) => name), ["read", "edit", "write", "bash"]);
});

it("read accepts familiar object arguments inside CodeMode and honors the requested line window", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("lines.txt", "one\ntwo\nthree\nfour\n");
  const result = await fixture.execute('return await read({path: "lines.txt", offset: 2, limit: 2});');
  assert.equal(result.details.ok, true, result.details.error);
  assert.equal(result.details.result, "two\nthree\n");
});

it("read normalizes numeric line parameters and reports an empty EOF window honestly", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("lines.txt", "one\ntwo\nthree\n");

  const result = await fixture.execute(`
    return {
      stringOffset: await read({path:"lines.txt", offset:"2", limit:"1"}),
      tail: await read({path:"lines.txt", offset:99, limit:1, resolve:true}),
      stagedTail: await write("staged.txt", "a\\nb\\n").then(() => read({path:"staged.txt", offset:2, limit:10}))
    };
  `);

  assert.equal(result.details.ok, true, result.details.error);
  assert.equal(result.details.result.stringOffset, "two\n");
  assert.equal(result.details.result.tail.status, "incomplete");
  assert.equal(result.details.result.tail.line, 99);
  assert.equal(result.details.result.stagedTail, "b\n");
});

it("one edit command applies a related edit set and returns only after all replacements are visible", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("pair.txt", "left=old\nright=old\n");

  const result = await fixture.execute(`
    await edit({path: "pair.txt", edits: [
      {oldText: "left=old", newText: "left=new"},
      {oldText: "right=old", newText: "right=new"}
    ]});
    return await read("pair.txt");
  `);

  assert.equal(result.details.ok, true, result.details.error);
  assert.equal(await fs.readFile(path.join(fixture.root, "pair.txt"), "utf8"), "left=new\nright=new\n");
  assert.match(result.details.result, /left=new\nright=new/);
});

it("an uncaught program failure is a host-visible failed tool execution, not a successful error-shaped result", async t => {
  const fixture = await engineFixture(t);
  await assert.rejects(fixture.execute('throw new Error("hard-failure-sentinel");'), /hard-failure-sentinel/);
});

it("a failing command attaches a bounded source window for reported file lines", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("a.js", "one\ntwo\nthree\n");
  await assert.rejects(
    fixture.execute('return await bash({command:"printf \\\'a.js:2\\\\n\\\' >&2; exit 7"});'),
    /a\.js:2[\s\S]*--- source[\s\S]*►\s+2 two/,
  );
});


it("bash materializes a staged working directory before running, including symlink spellings", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root,"real"));
  await fs.symlink(path.join(f.root,"real"),path.join(f.root,"alias"),"junction");

  for (const [written,cwd] of [["fresh/nested","fresh/nested"],["real/new","alias/new"]]) {
    const result = await f.tool.execute("staged-cwd", {
      code:'await write(data.path+"/input.txt","staged"); return await bash(data.command);',
      data:{path:written,command:{command:process.execPath,args:["-e",'const fs=require("node:fs"); fs.writeFileSync("result.txt",fs.readFileSync("input.txt"));'],cwd}},
    }, undefined, undefined, {cwd:f.root});

    assert.equal(result.details.ok,true);
    assert.equal(result.details.mutations.committed,1);
    assert.equal(await fs.readFile(path.join(f.root,written,"result.txt"),"utf8"),"staged");
  }
});

it("invalid working directories cannot execute shells or undo saved files and checkpoints", async t => {
  const f = await engineFixture(t);
  t.after(()=>f.emit("session_shutdown"));
  await f.write("existing-file.txt","original");

  for (const background of [false,true]) {
    for (const cwd of ["absent","prefix","queued-file.txt","existing-file.txt","../outside"]) {
      await assert.rejects(f.tool.execute("invalid-cwd", {
        code:'await write("prefix-sibling/input.txt","staged"); await write("queued-file.txt","staged"); return await bash(data);',
        data:{command:process.execPath,args:["-e",'require("node:fs").writeFileSync("executed.txt","bad");'],cwd,background},
      }, undefined, undefined, {cwd:f.root}),error=>{
        assert.equal(error.supernovaResult.details.mutations.committed,2);
        assert.equal(error.supernovaResult.details.mutations.external,0);
        assert.match(error.message,/cwd is not a directory|escapes workspace/);

        return true;
      });
      assert.equal(await fs.readFile(path.join(f.root,"prefix-sibling/input.txt"),"utf8"),"staged");
      assert.equal(await fs.readFile(path.join(f.root,"queued-file.txt"),"utf8"),"staged");
      await assert.rejects(fs.stat(path.join(f.root,"executed.txt")),{code:"ENOENT"});
      assert.equal(await fs.readFile(path.join(f.root,"existing-file.txt"),"utf8"),"original");
    }

    await assert.rejects(f.tool.execute("checkpoint-cwd", {
      code:'return await edit(async()=>{await write("checkpoint/input.txt","staged"); return await bash(data);});',
      data:{command:process.execPath,args:["-e","process.exit(0)"],cwd:"checkpoint",background},
    }, undefined, undefined, {cwd:f.root}),/cannot run inside an edit checkpoint/);
    await assert.rejects(fs.stat(path.join(f.root,"checkpoint")),{code:"ENOENT"});
  }

  assert.deepEqual((await f.execute('return await bash({action:"list"});')).details.result,[]);
});


it("C++ raw literal receipts preserve source without false string warnings or auto references", async t => {
  const f = await engineFixture(t);
  const original = 'const auto sql = u8R"SQL(\nSELECT "quoted", \'{ [ } ]\';\n)SQL";\n';
  await f.write("caller.js","export const auto = 1;\n");
  const created = await f.tool.execute("raw-cpp",{code:'return await write("query.cpp",data);',data:original},undefined,undefined,{cwd:f.root});
  assert.doesNotMatch(created.details.result,/check:/);
  const edited = await f.execute('return await edit("query.cpp","const auto sql","const auto query");');
  assert.doesNotMatch(edited.details.result,/check:|auto also referenced/);
  assert.equal(await fs.readFile(path.join(f.root,"query.cpp"),"utf8"),original.replace("const auto sql","const auto query"));
  const malformed = await f.tool.execute("broken-cpp",{code:'return await write("broken.cpp",data);',data:original.replace(')SQL";',')OTHER";')},undefined,undefined,{cwd:f.root});
  assert.match(malformed.details.result,/check: unterminated raw string/);
  await f.write("value.js","export const auto = 1;\n");
  const js = await f.execute('return await edit("value.js","auto = 1","auto = 2");');
  assert.match(js.details.result,/auto also referenced/);
});

it("multi-edit keeps original coordinates for reversed adjacent replacements and deletions", async t => {
  const f = await engineFixture(t);
  const original = "HEAD😀|delete me|grow me|TAIL\r\n";
  await f.write("adjacent.txt", original);

  const result = await f.execute(`
    await edit({path:"adjacent.txt",edits:[
      {oldText:"TAIL\\r\\n",newText:"尾\\r\\n"},
      {oldText:"grow me|",newText:"expanded😀\\nsecond|"},
      {oldText:"HEAD😀|",newText:""},
      {oldText:"delete me|",newText:""}
    ]});
    return await read("adjacent.txt");
  `);

  const expected = "expanded😀\nsecond|尾\r\n";
  assert.equal(result.details.result, expected);
  assert.equal(await fs.readFile(path.join(f.root, "adjacent.txt"), "utf8"), expected);
});

it("multi-edit receipts preserve shifted coordinates and literal line endings", async t => {
  const f = await engineFixture(t);
  await f.write("receipt.txt", "remove me\r\nkeep 😀\nexpand me\r\nfooter");

  const result = await f.execute(`
    return await edit({path:"receipt.txt",edits:[
      {oldText:"expand me",newText:"expanded\\nnew"},
      {oldText:"remove me\\r\\n",newText:""}
    ]});
  `);

  assert.equal(await fs.readFile(path.join(f.root, "receipt.txt"), "utf8"), "keep 😀\nexpanded\nnew\r\nfooter");
  const diff = result.details.trace.find(row => row.name === "edit").diff;
  assert.deepEqual(diff.lines.map(({ type, lineNum, newLineNum, text }) => [type, lineNum, newLineNum, text]), [
    ["remove", 1, 1, "remove me"],
    ["remove", 3, 2, "expand me"],
    ["add", 2, undefined, "expanded"],
    ["add", 3, undefined, "new"],
  ]);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
});
