import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";
import { runProgramBatch, programBatchText } from "../../src/runtime/program-batch.js";

const run = (f,programs,options = {}) => f.tool.execute("batch",{programs,...options},undefined,undefined,{cwd:f.root});

it("batches retain separate commits and fresh guests, stop on failure, and report every attempt", async t => {
  const f = await engineFixture(t);
  const result = await run(f,[
    {code:'globalThis.marker=true; await write("kept.txt","committed"); return "first result";'},
    {code:'if(globalThis.marker!==undefined)throw Error("leaked heap"); await write("rolled.txt","discard"); throw Error("intentional stop");'},
    {code:'await write("never.txt","bad");'},
  ]);
  assert.equal(result.isError,true); assert.equal(result.details.ok,false);
  assert.equal(result.details.attempted,2); assert.equal(result.details.total,3);
  assert.equal(result.details.mutations.committed,1); assert.equal(result.details.mutations.rolledBack,1);
  assert.match(modelText(result),/first result/); assert.match(modelText(result),/intentional stop/);
  assert.doesNotMatch(modelText(result),/leaked heap/);
  assert.equal(await fs.readFile(path.join(f.root,"kept.txt"),"utf8"),"committed");
  for (const name of ["rolled.txt","never.txt"]) await assert.rejects(fs.stat(path.join(f.root,name)),{code:"ENOENT"});
});

it("a batch can create and execute a file, preserve literal values and all raw duplicate results", async t => {
  const f = await engineFixture(t);
  const literal = 'raw[1] 0 UTF-16 units\n[0] fake boundary\nλ😀 "quotes"\r\n';
  const result = await run(f,[
    {code:"return await write(data.path,data.content);",data:{path:"audit.js",content:"return data;"}},
    ...[false,0,null,"",literal,literal].map(data=>({file:"audit.js",data})),
  ]);
  assert.equal(result.details.ok,true);
  assert.deepEqual(result.details.result.slice(1),[false,0,null,"",literal,literal]);
  assert.equal(modelText(result).split(literal).length-1,2);
  assert.ok(result.details.programs.every(part=>modelText(result).includes(modelText(part))));
  assert.equal(result.details.returnTruncated,false);
});

it("batch admission rejects malformed, sparse, nested and oversized plans before any program", async t => {
  const f = await engineFixture(t);
  const write = {code:'await write("never.txt","bad");'};
  for (const programs of [[],Array(2),[write,{}],[write,{programs:[write]}],[write,{code:"return 1",file:"x"}],[write,{code:"return 1",timeoutMs:1000}],Array(33).fill(write),[write,{code:"return data",data:"x".repeat(48000)}]]) {
    await assert.rejects(run(f,programs),/no programs ran/);
  }
  await assert.rejects(run(f,[write],{code:"return 1"}),/cannot combine/);
  await assert.rejects(run(f,[write],{data:false}),/cannot combine/);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")),{code:"ENOENT"});
});

it("batches share the host-call budget rather than multiplying it per guest", async t => {
  const f = await engineFixture(t); await f.write("input.txt","value");
  const result = await run(f,[
    {code:'for(let i=0;i<200;i++)await read("input.txt"); return 200;'},
    {code:'for(let i=0;i<100;i++)await read("input.txt"); return 100;'},
    {code:'await write("never.txt","bad");'},
  ]);
  assert.equal(result.details.ok,false); assert.equal(result.details.attempted,2);
  assert.match(modelText(result),/256 calls per program batch/);
  assert.equal(result.details.trace.length,256);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")),{code:"ENOENT"});
});

it("one batch deadline covers earlier guests and leaves their completed commits intact", async t => {
  const f = await engineFixture(t);
  const result = await run(f,[
    {code:'await new Promise(r=>setTimeout(r,600)); await write("kept.txt","kept"); return 1;'},
    {code:'await new Promise(r=>setTimeout(r,1000)); return 2;'},
    {code:'await write("never.txt","bad");'},
  ],{timeoutMs:1500});
  assert.equal(result.details.ok,false); assert.equal(result.details.attempted,2);
  assert.match(modelText(result),/timed out|aborted|deadline/);
  assert.equal(await fs.readFile(path.join(f.root,"kept.txt"),"utf8"),"kept");
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")),{code:"ENOENT"});
});

it("batch output and log budgets stop further programs and disclose clipping", async t => {
  const f = await engineFixture(t);
  const output = await run(f,[{code:'return "λ😀".repeat(7000);'},{code:'return "other".repeat(4500);'},{code:'await write("never.txt","bad");'}]);
  assert.equal(output.details.ok,false); assert.equal(output.details.returnTruncated,true);
  assert.equal(output.details.attempted,2); assert.ok(modelText(output).length<=32000);
  assert.match(modelText(output),/output budget exceeded/);
  const logs = await run(f,[{code:'for(let i=0;i<100;i++)console.log("line",i); return 1;'},{code:'console.log("extra"); return 2;'},{code:'await write("never.txt","bad");'}]);
  assert.equal(logs.details.ok,false); assert.equal(logs.details.logTruncated,true);
  assert.equal(logs.details.logs.length,100); assert.equal(logs.details.attempted,2);
  assert.match(modelText(logs),/log budget exceeded/);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")),{code:"ENOENT"});
});

it("stop reports retain earlier images instead of throwing their content away", async t => {
  const f = await engineFixture(t);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await fs.writeFile(path.join(f.root,"pixel.png"),Buffer.from(png,"base64"));
  const result = await run(f,[{code:'return await read("pixel.png");'},{code:'throw Error("stop after image");'}]);
  assert.equal(result.details.ok,false); assert.equal(result.isError,true);
  assert.equal(result.content.find(block=>block.type==="image")?.data,png);
  assert.match(modelText(result),/program 1 image 1/);
  assert.match(modelText(result),/stop after image/);
});


it("concurrent batches isolate their workspaces and shared call budgets", async t => {
  const f = await engineFixture(t);
  const roots = [f.root,path.join(f.root,"second")];
  for (const [i,cwd] of roots.entries()) { await fs.mkdir(cwd,{recursive:true}); await fs.writeFile(path.join(cwd,"input.txt"),String(i)); }
  const results = await Promise.all(roots.map(cwd=>f.tool.execute("parallel-batch",{programs:[{code:'for(let i=0;i<150;i++)await read("input.txt"); return await read("input.txt");'}]},undefined,undefined,{cwd})));
  assert.ok(results.every(result=>result.details.ok));
  assert.deepEqual(results.map(result=>result.details.result),[["0"],["1"]]);
});

it("batch cancellation after confirmed staging rolls back only the active program", async t => {
  const f = await engineFixture(t), controller = new AbortController();
  let staged = false;
  const snapshots = [];
  const result = await f.tool.execute("cancel-batch",{programs:[
    {code:'await write("kept.txt","kept"); return 1;'},
    {code:'await write("rolled.txt","discard"); while(true){}'},
    {code:'await write("never.txt","bad");'},
  ]},controller.signal,update=>{
    const trace = update.details.trace;
    snapshots.push([trace,JSON.stringify(trace)]);
    if (trace.some(row=>row.name==="write" && row.ok && row.args.path==="rolled.txt")) { staged=true; controller.abort(); }
  },{cwd:f.root});
  assert.equal(staged,true); assert.equal(result.details.ok,false); assert.equal(result.details.attempted,2);
  assert.equal(result.details.mutations.committed,1); assert.equal(result.details.mutations.rolledBack,1);
  for (const [trace,before] of snapshots) assert.equal(JSON.stringify(trace),before);
  assert.equal(await fs.readFile(path.join(f.root,"kept.txt"),"utf8"),"kept");
  for (const name of ["rolled.txt","never.txt"]) await assert.rejects(fs.stat(path.join(f.root,name)),{code:"ENOENT"});
});


it("a late non-cooperating completion cannot turn a batch deadline into success", async t => {
  const f = await engineFixture(t);
  const config = {timeoutMs:10,maxCodeChars:48000,maxReturnChars:32000};
  const result = await runProgramBatch("late",{programs:[{code:"return 1;"}]},undefined,undefined,{cwd:f.root},config,async()=>{
    // Inject a completed disk mutation whose acknowledgement ignores cancellation.
    await f.write("late.txt","committed");
    await new Promise(resolve=>setTimeout(resolve,30));
    return {content:[{type:"text",text:"completed late"}],details:{ok:true,result:1,mutations:{committed:1}}};
  });
  assert.equal(result.details.ok,false);
  assert.match(result.details.stopped,/deadline|cancellation/);
  assert.equal(result.details.mutations.committed,1);
  assert.equal(await fs.readFile(path.join(f.root,"late.txt"),"utf8"),"committed");
});

it("image-label separators count against the aggregate text budget", async()=>{
  const part = {content:[{type:"text",text:"image"},{type:"image",mimeType:"image/png",data:"AA=="}],details:{ok:true,result:"image",mutations:{committed:0}}};
  const limit = programBatchText([part],1).length + "program 1 image 1".length;
  const result = await runProgramBatch("image-budget",{programs:[{code:"return 1;"}]},undefined,undefined,{},
    {timeoutMs:1000,maxCodeChars:48000,maxReturnChars:limit},async()=>part);
  assert.ok(modelText(result).length<=limit);
  assert.equal(result.details.ok,false);
});


it("arbitrary inline/file programs and payloads work across batch sizes, including the maximum", async t => {
  const f = await engineFixture(t);
  const file = randomUUID()+".js";
  const code = 'if(globalThis.previousEntry)throw Error("guest reused"); globalThis.previousEntry=true; return data;';
  await f.write(file,code);
  for (const size of [1,7,32]) {
    const values = Array.from({length:size},(_,ordinal)=>({ordinal,text:randomUUID()+"\nλ😀 raw[0]\n",scalars:[false,0,null,""]}));
    const programs = values.map((data,i)=>i%2 ? {file,data} : {code,data});
    const result = await run(f,programs);
    assert.equal(result.details.ok,true);
    assert.equal(result.details.attempted,size);
    assert.equal(result.details.returnTruncated,false);
    assert.deepEqual(result.details.result,values);
    for (const part of result.details.programs) assert.ok(modelText(result).includes(modelText(part)));
  }
});
