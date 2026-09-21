import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";
import { packageFinalReturn } from "../../src/output/bottleneck.js";
import { packageDefaults } from "../../src/config/config.js";

it("plain read values are complete above the former line and display caps", async t => {
  const f = await engineFixture(t);
  const files = {"nine.txt":"x".repeat(9000), "forty.txt":"y".repeat(40000), "lines.log":"line\n".repeat(400)};
  await Promise.all(Object.entries(files).map(([name,text])=>f.write(name,text)));
  const result = await f.execute('const a=await read("nine.txt"); const b=await read("forty.txt",{complete:true}); const c=await read("lines.log"); const lengths=[a.length,b.length,c.length]; await write("lengths.json",JSON.stringify(lengths)); return lengths;');
  assert.deepEqual(result.details.result,[9000,40000,2000]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,"lengths.json"),"utf8")),[9000,40000,2000]);
  const batch = await f.execute('return (await read(["nine.txt","forty.txt"],{complete:true})).map(text=>text.length);');
  assert.deepEqual(batch.details.result,[9000,40000]);
});

it("large JSON selections retain their types in single, coalesced and explicit reads", async t => {
  const f = await engineFixture(t);
  const rows = Array.from({length:1000},(_,id)=>({id,active:id%3===0,padding:"λ".repeat(40)}));
  await f.write("report.json",JSON.stringify({rows,text:"x".repeat(80000),literal:"42"}));
  const result = await f.execute('const rows=await read({path:"report.json",json:".rows"}); const [a,b]=await Promise.all([read({path:"report.json",json:".text"}),read({path:"report.json",json:".text"})]); const both=await read(["report.json","report.json"],{json:".text"}); const mixed=await read({path:"report.json",json:[".rows",".literal"]}); const raw=await read("report.json"); return {count:rows.filter(row=>row.active).length,coalesced:[a.length,b.length],explicit:both.map(text=>text.length),mixed:[mixed[0].length,typeof mixed[1],mixed[1]],raw:[typeof raw,JSON.parse(raw).rows.length]};');
  assert.deepEqual(result.details.result,{count:334,coalesced:[80000,80000],explicit:[80000,80000],mixed:[1000,"string","42"],raw:["string",1000]});
});

it("directory values remain arrays regardless of spelling, size or batching", async t => {
  const f = await engineFixture(t);
  const dir=path.join(f.root,"many-files"); await fs.mkdir(dir);
  const names=Array.from({length:800},(_,i)=>"entry-"+String(i).padStart(4,"0")+"-"+"x".repeat(72)+".txt");
  for(let start=0;start<names.length;start+=64) await Promise.all(names.slice(start,start+64).map(name=>fs.writeFile(path.join(dir,name),"x")));
  const result=await f.execute('const single=await read("many-files"); const concurrent=await Promise.all([read("many-files"),read("./many-files/")]); const batch=await read(["many-files","./many-files/"]); return [single,...concurrent,...batch].map(entries=>({array:Array.isArray(entries),count:entries.filter(entry=>entry.startsWith("entry-")).length}));');
  assert.deepEqual(result.details.result,Array.from({length:5},()=>({array:true,count:800})));
  const shown=await f.execute('return await read("many-files/");');
  assert.equal(shown.details.returnTruncated,true);
  assert.ok(shown.details.result.length<=packageDefaults().maxReturnChars);
});

it("explicit windows preserve long lines and exact UTF-8 and CRLF data", async t => {
  const f=await engineFixture(t);
  const line="λ😀x".repeat(10000)+"\r\n";
  await f.write("long.txt","header\r\n"+line+"tail\r\n");
  const result=await f.execute('const line=await read("long.txt",{offset:2,limit:1}); await write("copy.txt",line); return {length:line.length,end:line.slice(-6)};');
  assert.deepEqual(result.details.result,{length:line.length,end:line.slice(-6)});
  assert.equal(await fs.readFile(path.join(f.root,"copy.txt"),"utf8"),line);
});

it("resolved source can be computed on without a display-sized text cut", async t => {
  const f=await engineFixture(t);
  const source="export function wideView() {\n"+"  // keep exact source λ😀\n".repeat(3000)+"  return 42;\n}\n";
  await f.write("source.js",source);
  const result=await f.execute('const source=await read({query:"wideView",resolve:true}); return {status:source.status,length:source.text.length,complete:source.complete};');
  assert.deepEqual(result.details.result,{status:"found",length:source.length,complete:true});
});

it("large internal reads commit their derived work while final display stays bounded", async t => {
  const f=await engineFixture(t);
  const text="unchanged data\n".repeat(12000);
  await f.write("input.txt",text);
  const result=await f.execute('const text=await read("input.txt"); await write("copy.txt",text); return text;');
  assert.equal(result.details.ok,true);
  assert.equal(await fs.readFile(path.join(f.root,"copy.txt"),"utf8"),text);
  assert.equal(result.details.returnTruncated,true);
  assert.ok(result.details.result.length<=packageDefaults().maxReturnChars);
  assert.match(result.details.result,/truncated/);
});

it("a literal routing-looking file is data, not an implicit protocol message", async t => {
  const f=await engineFixture(t);
  const text='{"status":"too_large","path":"literal.txt","chars":12,"keys":["x"]}';
  await f.write("literal.txt",text);
  const result=await f.execute('const text=await read("literal.txt"); return {type:typeof text,length:text.length};');
  assert.deepEqual(result.details.result,{type:"string",length:text.length});
});

it("final presentation obeys its cap even for thousands of string entries", () => {
  const config=packageDefaults();
  const packed=packageFinalReturn(Array.from({length:5000},(_,i)=>"entry-"+i+"-"+"x".repeat(80)),[],config);
  assert.equal(packed.returnTruncated,true);
  assert.ok(packed.returnText.length<=config.maxReturnChars,packed.returnText.length+" exceeds "+config.maxReturnChars);
  assert.match(packed.returnText,/truncated|omitted/);
});

it("large JSON selector batches keep independently mutable values in both delivery modes", async t => {
  const f=await engineFixture(t);
  for (const size of [2,50000]) {
    await f.write("aliases.json",JSON.stringify({nested:{text:"x".repeat(size)}}));
    const result=await f.execute('const reads=await read(["aliases.json","aliases.json"],{json:[".nested",".nested"]}); reads[0][0].text="changed"; return reads.map(parts=>parts.map(part=>part.text.length));');
    assert.deepEqual(result.details.result,[[7,size],[size,size]]);
  }
});

it("oversized object, sparse-array and log displays are bounded before expansion", async t => {
  const f=await engineFixture(t);
  const result=await f.execute('const values=Array(100000).fill("x".repeat(10000)); console.log({values}); return {values};');
  assert.equal(result.details.ok,true);
  assert.equal(result.details.returnTruncated,true);
  assert.equal(result.details.logTruncated,true);
  assert.ok(result.content[0].text.length<=32000);
  const sparse=await f.execute('const a=Array(100000); a[99999]="last"; return a;');
  assert.equal(sparse.details.returnTruncated,true);
  assert.ok(sparse.content[0].text.length<=32000);
  assert.match(sparse.details.result,/null,null/);
  const hidden=await f.execute('return Object.fromEntries(Array.from({length:10000},(_,i)=>["field-"+i,undefined]));');
  assert.equal(hidden.details.returnTruncated,true);
  assert.match(hidden.details.result,/truncated/,"hidden metadata must not bypass the output budget");
  const literal=await f.execute('console.log("","[log truncated literal]"); return "\\ud800";');
  assert.deepEqual(literal.details.logs,[" [log truncated literal]"]);
  assert.equal(literal.details.logTruncated,false);
  assert.equal(literal.content[0].text.isWellFormed(),true);
});

it("native read delivery backpressure holds at most eight I/O slots and drains on release", async t => {
  const {createHostBridge}=await import("../../src/bridge/host-bridge.js");
  const f=await engineFixture(t);
  await f.write("payload.txt","x".repeat(50000));
  const bridge=createHostBridge({pi:null,config:packageDefaults(),getCwd:()=>f.root});
  const gate=Promise.withResolvers(),eight=Promise.withResolvers();
  let started=0,active=0,peak=0;
  const pending=bridge.natives.read({path:Array(24).fill("payload.txt")},undefined,async (_index,raw) => {
    assert.equal(raw.content[0].text.length,50000);
    started++; active++; peak=Math.max(peak,active);
    if(started===8) eight.resolve();
    await gate.promise; active--;
  });
  const timer=setTimeout(()=>eight.reject(new Error("stream delivery did not fill its eight slots")),5000);
  try {
    await eight.promise;
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(started,8);
    gate.resolve();
    const result=await pending;
    assert.equal(started,24);
    assert.equal(peak,8);
    assert.equal(active,0);
    assert.equal(result.details.streamed,true);
    assert.deepEqual(result.details.items,[],"the host must not retain another whole-batch copy");
  } finally {clearTimeout(timer); gate.resolve(); await pending.catch(()=>{}); bridge.close();}
});

it("directory limits count unique entries and never present an incomplete array as complete", async t => {
  const {createDirectoryReader,MAX_DIRECTORY_ENTRIES}=await import("../../src/fs/directory.js");
  const {READ_VALUE}=await import("../../src/shared/result.js");
  const f=await engineFixture(t);
  const paths=Array.from({length:MAX_DIRECTORY_ENTRIES},(_,i)=>path.join(f.root,"entry-"+i));
  await f.write("entry-0","disk value shadowed by the overlay");
  const read=createDirectoryReader({getOverlayPaths:()=>paths,getOverlay:()=>"x"});
  const result=await read(f.root);
  assert.equal(result[READ_VALUE].length,MAX_DIRECTORY_ENTRIES);
  assert.equal(result[READ_VALUE][0],"entry-0 (file, 1 bytes)");
  paths.push(path.join(f.root,"one-too-many"));
  await assert.rejects(read(f.root),/directory exceeds 10000 entries.*bounded directory parser/);
});

it("64 large reads, blocked acknowledgements and expanded returns leave a constrained host usable", async t => {
  const {execFile}=await import("node:child_process");
  const {promisify}=await import("node:util");
  const f=await engineFixture(t);
  const text="x".repeat(2*1024*1024)+"END";
  await f.write("large.txt",text);
  const code=String.raw`await write("derived.txt","retained"); return await Promise.all(Array.from({length:64},async()=>{const text=await read("large.txt"); return [text.length,text.slice(-3)];}));`;
  const blocked=String.raw`await write("cancelled.txt","must roll back"); const jobs=Array.from({length:64},()=>read("large.txt")); await Promise.race(jobs); while(true) {}`;
  const expansion=String.raw`const values=Array(100000).fill("x".repeat(10000)); console.log({values}); return {values};`;
  const program=`import assert from "node:assert/strict";
    import {registerCodeMode} from ${JSON.stringify(new URL("../../index.js",import.meta.url).href)};
    import {stopWarmGuestWorker} from ${JSON.stringify(new URL("../../src/runtime/runtime.js",import.meta.url).href)};
    let tool; registerCodeMode({registerTool:t=>{tool=t},registerCommand(){},on(){}});
    const ctx={cwd:${JSON.stringify(f.root)}};
    const result=await tool.execute("large-wave",{code:${JSON.stringify(code)},timeoutMs:10000},undefined,undefined,ctx);
    assert.deepEqual(result.details.result,Array.from({length:64},()=>[${text.length},"END"]));
    await assert.rejects(tool.execute("blocked-ack",{code:${JSON.stringify(blocked)},timeoutMs:300},undefined,undefined,ctx),/timed out/);
    const expanded=await tool.execute("expanded",{code:${JSON.stringify(expansion)}},undefined,undefined,ctx);
    assert.equal(expanded.details.ok,true); assert.equal(expanded.details.returnTruncated,true);
    assert.ok(expanded.content[0].text.length<=32000);
    const next=await tool.execute("next",{code:"return 42;"},undefined,undefined,ctx);
    assert.equal(next.details.result,42);
    await stopWarmGuestWorker();
    await new Promise(resolve=>setTimeout(resolve,50));
    console.log("streamed, cancelled, bounded, and survived");`;
  const child=await promisify(execFile)(process.execPath,["--max-old-space-size=128","--input-type=module","-e",program],{timeout:20000,maxBuffer:1024*1024});
  assert.match(child.stdout,/streamed, cancelled, bounded, and survived/);
  assert.equal(await fs.readFile(path.join(f.root,"derived.txt"),"utf8"),"retained");
  await assert.rejects(fs.stat(path.join(f.root,"cancelled.txt")),{code:"ENOENT"});
});

it("staged line windows enforce the same UTF-8 byte ceiling as disk windows", async () => {
  const {createWindowReader}=await import("../../src/fs/read-window.js");
  const readWindow=createWindowReader({getOverlay:()=>"λλλλ\nnext\n"});
  const exact=await readWindow("staged.txt",1,1,9);
  assert.equal(exact.satisfied,true);
  assert.equal(exact.text,"λλλλ\n");
  assert.equal((await readWindow("staged.txt",1,1,8)).satisfied,false);
  assert.equal((await readWindow("staged.txt",2,1,8)).text,"next\n");
});
