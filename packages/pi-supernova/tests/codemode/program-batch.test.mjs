import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";
import { runProgramBatch, programBatchText } from "../../src/runtime/program-batch.js";

const run = (f,programs,options = {}) => f.tool.execute("batch",{programs,...options},undefined,undefined,{cwd:f.root});

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


it("read/edit/write/bash pipelines disclose clipping introduced by logs and the final envelope", async t => {
  const f = await engineFixture(t);
  const verifier = 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(x.payload.length));';
  for (const [text,lines] of [["x".repeat(31200),1],["λ😀",101]]) {
    const result = await f.tool.execute("pipeline-limits",{data:{text,lines,verifier,oldKey:JSON.stringify("value"),newKey:JSON.stringify("payload")},code:
      'await write("report.json",JSON.stringify({value:data.text})); '+
      'const value=await read({path:"report.json",json:".value"}); '+
      'await edit("report.json",data.oldKey,data.newKey); '+
      'const proof=await bash({command:process.execPath,args:["-e",data.verifier,"report.json"]}); '+
      'if(proof!==String(value.length))throw Error("disk verification failed"); '+
      'for(let i=0;i<data.lines;i++)console.log("diagnostic ".repeat(120)); return value;'
    },undefined,undefined,{cwd:f.root});
    assert.equal(result.details.ok,true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,"report.json"),"utf8")),{payload:text});
    assert.ok(modelText(result).length<=32000);
    if(lines===1) assert.equal(result.details.returnTruncated,true,"the final envelope, not only the return value, must disclose truncation");
    else {
      assert.equal(result.details.logTruncated,true);
      assert.ok(modelText(result).includes("logs truncated"),"log omissions must be visible to the model");
    }
  }
});


it("failed cutovers compose file reuse, JSON, checkpoints, argv, images and repair across workspaces", async t => {
  const f = await engineFixture(t);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const failure = 'throw Error("post-verification failure");';
  const source = [
    'globalThis.executions=(globalThis.executions||0)+1; if(globalThis.executions!==1)throw Error("guest reused");',
    'await write(data.path,JSON.stringify({version:1,payload:data.payload}));',
    'const rejected=await edit(async()=>{await edit(data.path,data.oldText,data.newText); await write("rejected.txt","bad"); throw Error("reject candidate");});',
    'if(rejected.ok || await read({path:data.path,json:".version"})!==1)throw Error("checkpoint leaked");',
    'await edit(data.path,data.oldText,data.newText);',
    'const args={command:process.execPath,args:["-e",data.verifier,data.path,data.literal]}; const before=JSON.stringify(args);',
    'const proof=await bash(args); const repeated=await bash(args); if(proof!==data.literal || repeated!==proof || JSON.stringify(args)!==before)throw Error("argv changed");',
    'console.log(proof); await write("late.txt","after verification");',
    failure,
  ].join("\n");
  const roots = [f.root,path.join(f.root,"second")];
  await fs.mkdir(roots[1]);
  await Promise.all(roots.map(async(cwd,i)=>{
    await fs.writeFile(path.join(cwd,"pixel.png"),Buffer.from(png,"base64"));
    const literal = String(i)+" quoted ' "+String.fromCharCode(34,96)+" $HOME $(touch injected) "+String.fromCharCode(36)+"{notCode} λ😀\r\n";
    const data = {path:"cutover.json",literal,payload:literal+String.fromCharCode(0),oldText:'"version":1',newText:'"version":2',
      verifier:'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.version!==2||x.payload!==process.argv[2]+String.fromCharCode(0))process.exit(9);process.stdout.write(process.argv[2]);'};
    const execute = programs=>f.tool.execute("cutover",{programs},undefined,undefined,{cwd});
    const stopped = await execute([
      {code:'const saved=await write(data.path,data.content); return {saved,image:await read("pixel.png")};',data:{path:"scripts/flow.js",content:source}},
      {file:"scripts/flow.js",data},
      {code:'await write("never.txt","bad");'},
    ]);
    assert.equal(stopped.details.ok,false); assert.equal(stopped.details.attempted,2);
    assert.equal(stopped.details.mutations.committed,2); assert.equal(stopped.details.mutations.rolledBack,3);
    assert.equal(stopped.details.mutations.external,2);
    assert.match(modelText(stopped),/cannot be rolled back/);
    assert.equal(stopped.content.find(block=>block.type==="image")?.data,png);
    assert.ok(modelText(stopped).includes(literal));
    assert.match(modelText(stopped),/post-verification failure/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,data.path),"utf8")),{version:2,payload:data.payload});
    for(const name of ["rejected.txt","late.txt","never.txt","injected"]) await assert.rejects(fs.stat(path.join(cwd,name)),{code:"ENOENT"});
    // Repair the saved source through Nova, then execute it again. Stale source
    // or leaked worker state would repeat the failure instead of returning proof.
    const repaired = await execute([
      {code:'return await edit(data.path,data.oldText,data.newText);',data:{path:"scripts/flow.js",oldText:failure,newText:'return {version:await read({path:data.path,json:".version"}),alias:typeof exec};'}},
      {file:"scripts/flow.js",data},
    ]);
    assert.equal(repaired.details.ok,true);
    assert.deepEqual(repaired.details.result[1],{version:2,alias:"undefined"});
    assert.equal(await fs.readFile(path.join(cwd,"late.txt"),"utf8"),"after verification");
  }));
});
