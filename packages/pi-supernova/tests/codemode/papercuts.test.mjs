import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { engineFixture } from "../helpers/engine.mjs";

it("unsupported edit overloads fail before dispatch with usable signatures", async t => {
  const f = await engineFixture(t);
  for (const call of ['edit("missing.txt", {oldText:"a",newText:"b"})', 'edit({path:"missing.txt",edits:[]})', 'edit({path:"missing.txt",patch:"",oldText:"a",newText:"b"})']) {
    await assert.rejects(f.execute('await ' + call), /edit.*(?:signature|use|requires)/i);
  }
  await f.write("edit.txt", "retained");
  await assert.rejects(f.execute('await edit("edit.txt", "");'), /edit.*(?:signature|use|requires)/i);
  assert.equal(await fs.readFile(path.join(f.root,"edit.txt"),"utf8"), "retained");
});

it("JSON projection parses the full report before selecting fields and array slices", async t => {
  const f = await engineFixture(t);
  const report = { padding:"λ".repeat(50000), verdict:"REVIEW", values:[false,0,null,{pitch:123}], 'a.b':{ 'x/y': 7 } };
  await f.write("report.json", JSON.stringify(report,null,2));
  await assert.rejects(f.execute('return JSON.parse(await read("report.json"));'), /incomplete JSON read/);
  const selectors = [".verdict", ".values[1:4]", '.["a.b"]["x/y"]'];
  const result = await f.execute('return await read({path:"report.json",json:' + JSON.stringify(selectors) + '});');
  assert.deepEqual(result.details.result, ["REVIEW",[0,null,{pitch:123}],7]);
  const both = await f.execute('return await Promise.all([read({path:"report.json",json:".values[0]"}),read({path:"report.json",json:".values[0]"})]);');
  assert.deepEqual(both.details.result,[false,false]);
  const array = await f.execute('return await read(["report.json","report.json"],{json:".values[2]"});');
  assert.deepEqual(array.details.result,[null,null]);
  await assert.rejects(f.execute('return await read({path:"report.json",json:".padding"});'), /JSON selection exceeds.*budget/);
  await assert.rejects(f.execute('return await read({path:"report.json",json:true});'), /JSON selection exceeds.*budget/);
  for (const json of [".missing", ".toString", ".values[99]", ".verdict.length", ".values | length", "", "..verdict", ".values[-1]", ".values[1:9007199254740992]"]) {
    await assert.rejects(f.execute('return await read({path:"report.json",json:' + JSON.stringify(json) + '});'), /JSON (?:selector|field|index)/);
  }
  await assert.rejects(f.execute('return await read({path:"report.json",json:".verdict",limit:1});'), /JSON.*cannot combine/);
  await f.write("invalid.json", '{"verdict":"OK"} trailing junk');
  await assert.rejects(f.execute('return await read({path:"invalid.json",json:".verdict"});'), /invalid JSON/);
  await f.write("oversize.json", JSON.stringify({padding:"x".repeat(16*1024*1024)}));
  await assert.rejects(f.execute('return await read({path:"oversize.json",json:".padding"});'), /JSON input exceeds/);
});

it("projected reads see staged JSON and session URI queries without losing isolation", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root,"artifacts"));
  await fs.writeFile(path.join(f.root,"artifacts","SanskritModelSurvey.md"), JSON.stringify({answer:"answer λ",ignored:"x".repeat(50000)}));
  const execute = code => f.tool.execute("resource",{code},undefined,undefined,{cwd:f.root,sessionManager:{getArtifactsDir:()=>path.join(f.root,"artifacts")}});
  assert.equal((await execute('return await read("agent://SanskritModelSurvey?q=.answer");')).details.result,"answer λ");
  assert.equal((await execute('return await read("agent://SanskritModelSurvey?q=%2Eanswer");')).details.result,"answer λ");
  for (const uri of ["agent://SanskritModelSurvey?q=.answer&x=y","agent://SanskritModelSurvey?q=.answer&q=.ignored","agent://SanskritModelSurvey?q=", "agent://SanskritModelSurvey?q=.answer#extra"]) {
    await assert.rejects(execute('return await read(' + JSON.stringify(uri) + ');'), /session resource|JSON selector/);
  }
  const staged = await f.execute('await write("staged.json",JSON.stringify({value:42})); return await read({path:"staged.json",json:".value"});');
  assert.equal(staged.details.result,42);
});


it("projection fails closed for incompatible views, batches and delegated readers", async t => {
  const f = await engineFixture(t);
  await f.write("report.json", JSON.stringify({value:"x".repeat(20000)}));
  for (const options of [{complete:true}, {resolve:true}, {about:"value"}, {outline:true}, {evidence:true}, {offset:1}]) {
    await assert.rejects(f.execute('return await read(' + JSON.stringify({path:"report.json",json:".value",...options}) + ');'), /JSON reads cannot combine/);
  }
  await assert.rejects(f.execute('return await read(["report.json","report.json","report.json","report.json"],{json:".value"});'), /incomplete read/);
  const outcomes = await f.execute('return (await Promise.allSettled([read({path:"report.json",json:".value"}),read({path:"missing.json",json:".value"})])).map(r=>r.status);');
  assert.deepEqual(outcomes.details.result,["fulfilled","rejected"]);
  let calls = 0;
  f.pi.registerTool({name:"read",execute:async()=>{calls++; return {content:[{type:"text",text:'{"wrong":true}'}]};}});
  await assert.rejects(f.execute('return await read({path:"report.json",json:".value"});'), /Supernova-owned read adapter/);
  assert.equal(calls,0);
});

it("large Markdown path audits use matching windows rather than complete-file reads", async t => {
  const f = await engineFixture(t);
  await f.write("handoff.md", "unrelated progress\n".repeat(6000) + "archive manifest: docs/intake/audio-list.json\n");
  const result = await f.execute('return await read("handoff.md",{about:"archive manifest"});');
  assert.match(result.details.result, /docs\/intake\/audio-list.json/);
  assert.ok(result.details.result.length < 8000);
});


it("sparse argument lists cannot silently become successful null results", async t => {
  const f = await engineFixture(t);
  await f.write("small.json", '{"value":1}');
  for (const code of [
    'return await read({path:"small.json",json:Array(2)});',
    'return await read(Array(2));',
    'return await edit({path:"small.json",edits:Array(2)});',
  ]) await assert.rejects(f.execute(code), /selector|paths|edit.*signature/);
});

it("JSON reads reject a FIFO without waiting for a writer or occupying an I/O worker", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const fifo = path.join(f.root,"report.json");
  await promisify(execFile)("mkfifo",[fifo]);
  // Release a pre-fix blocked open after its deadline; never leave a hung test worker.
  const release = new Promise(resolve => setTimeout(resolve,200)).then(async () => {
    const file = await fs.open(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK).catch(error => {
      if (error.code !== "ENXIO") throw error;
    });
    await file?.close();
  });
  try {
    await assert.rejects(f.tool.execute("fifo",{code:'return await read({path:"report.json",json:true});',timeoutMs:100},undefined,undefined,{cwd:f.root}), /regular file/);
  } finally { await release; }
});

it("64 oversized JSON slice selections fail within a bounded host heap and leave it usable", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  await f.write("large.json",JSON.stringify({items:Array(400000).fill(0)}));
  const entry = fileURLToPath(new URL("../../index.js",import.meta.url));
  const program = [
    'import assert from "node:assert/strict";',
    'import {registerCodeMode} from ' + JSON.stringify(entry) + ';',
    'let tool; registerCodeMode({registerTool:t=>{tool=t},getAllTools:()=>[tool],registerCommand(){},on(){}});',
    'const ctx={cwd:' + JSON.stringify(f.root) + '};',
    'await assert.rejects(tool.execute("expansion",{code:\'return await read({path:"large.json",json:Array(64).fill(".items[0:400000]")});\'},undefined,undefined,ctx),/JSON selection exceeds/);',
    'const result=await tool.execute("healthy",{code:\'return await read({path:"large.json",json:".items[0:2]"});\'},undefined,undefined,ctx);',
    'assert.deepEqual(result.details.result,[0,0]);console.log("budget rejected; host healthy");',
  ].join("\n");
  const result = await promisify(execFile)("bash",["-c",'ulimit -c 0; exec "$@"',"json-budget",process.execPath,"--max-old-space-size=128","--input-type=module","-e",program],{timeout:10000,maxBuffer:1024*1024});
  assert.match(result.stdout,/budget rejected; host healthy/);
});


it("JSON selectors preserve quoted keys, scalar roots and all 64 mixed slice results", async t => {
  const f = await engineFixture(t);
  const keys = ["", "__proto__", "constructor", "λ😀", "a.b", "a]b", "q?%&+#", "\\\"\n"];
  const document = Object.fromEntries(keys.map((key,i)=>[key,{values:[i,false,0,null]}]));
  await f.write("keys.json",JSON.stringify(document));
  const selectors = Array.from({length:64},(_,i)=>".["+JSON.stringify(keys[i%keys.length])+"].values[0:4]["+(i%4)+"]");
  const result = await f.execute('return await read({path:"keys.json",json:'+JSON.stringify(selectors)+'});');
  assert.deepEqual(result.details.result,selectors.map((_,i)=>document[keys[i%keys.length]].values[i%4]));
  for (const value of [null,false,0,"",[],{}]) {
    await f.write("scalar.json",JSON.stringify(value));
    assert.deepEqual((await f.execute('return await read({path:"scalar.json",json:true});')).details.result,value);
  }
  await assert.rejects(f.execute('return await read({path:"keys.json",json:Array(65).fill(".")});'),/1 to 64 selectors/);
});

it("the JSON input limit counts UTF-8 bytes and accepts the exact boundary", async t => {
  const f = await engineFixture(t);
  const cap = 16*1024*1024, prefix = '{"ok":true,"padding":"', suffix = '"}';
  const bytes = cap - Buffer.byteLength(prefix + suffix);
  const text = prefix + "λ".repeat(Math.floor(bytes/2)) + (bytes%2 ? "x" : "") + suffix;
  assert.equal(Buffer.byteLength(text),cap);
  await f.write("boundary.json",text);
  assert.equal((await f.execute('return await read({path:"boundary.json",json:".ok"});')).details.result,true);
  await fs.appendFile(path.join(f.root,"boundary.json")," ");
  await assert.rejects(f.execute('return await read({path:"boundary.json",json:".ok"});'),/JSON input exceeds/);
});

it("literal data respects encoded size, accepts falsy inputs and does not leak between workers", async t => {
  const f = await engineFixture(t);
  const execute = data => f.tool.execute("data-boundary",{code:'return data;',data},undefined,undefined,{cwd:f.root});
  for (const value of [null,false,0,""]) assert.equal((await execute(value)).details.result,value);
  const code='return data.length;', data="x".repeat(47998);
  assert.equal((await f.tool.execute("exact-data",{code,data},undefined,undefined,{cwd:f.root})).details.result,47998);
  await assert.rejects(execute("\n".repeat(24000)),/data exceeds/);
  assert.equal((await f.execute('return typeof data;')).details.result,"undefined");
  assert.equal((await f.execute('const data=7; return data;')).details.result,7);
  await assert.rejects(f.tool.execute("data-before-commands",{code:'await write("never.txt","bad");',data:"x".repeat(48001)},undefined,undefined,{cwd:f.root}),/data exceeds/);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")),{code:"ENOENT"});
});

it("concurrent queried resources remain session-scoped and cannot escape through symlinks", async t => {
  const f = await engineFixture(t);
  const dirs = await Promise.all(["one","two"].map(async name=>{
    const dir=path.join(f.root,name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir,"CaseSensitive.md"),JSON.stringify({"q?%&+#":name}));
    return dir;
  }));
  const uri='agent://CaseSensitive?q='+encodeURIComponent('.["q?%&+#"]');
  const execute=(index,path=uri)=>f.tool.execute("uri-scope",{code:'return await read(data);',data:path},undefined,undefined,{cwd:f.root,sessionManager:{getArtifactsDir:()=>dirs[index]}});
  const results=await Promise.all(Array.from({length:16},(_,i)=>execute(i%2)));
  assert.deepEqual(results.map(r=>r.details.result),Array.from({length:16},(_,i)=>i%2 ? "two" : "one"));
  await fs.symlink(path.join(dirs[1],"CaseSensitive.md"),path.join(dirs[0],"Escape.md"));
  await assert.rejects(execute(0,"agent://Escape?q=."),/escapes its artifacts directory/);
  await assert.rejects(execute(0,"agent://%2e%2e%2fEscape?q=."),/invalid session resource ID/);
});
