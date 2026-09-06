// Opt-in stress against the checkout or an isolated npm installation. No provider calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(process.env.SUPERNOVA_PACKAGE_ROOT || fileURLToPath(new URL("../../",import.meta.url)));
const rounds = Number(process.env.SUPERNOVA_STRESS_RUNS || 256);
assert.ok(Number.isInteger(rounds) && rounds >= 32 && rounds <= 2048,"SUPERNOVA_STRESS_RUNS must be 32..2048");
process.env.PI_SUPERNOVA_CONFIG = path.join(packageRoot,"src/config/config.default.json");
const { registerCodeMode } = await import(pathToFileURL(path.join(packageRoot,"index.js")).href);
const { WorkspaceIndex } = await import(pathToFileURL(path.join(packageRoot,"src/context/repo-index.js")).href);
const tools = new Map();
registerCodeMode({registerTool:tool=>tools.set(tool.name,tool),getAllTools:()=>[...tools.values()],registerCommand(){},on(){}});
assert.deepEqual([...tools.keys()],["supernova"]);
const tool = tools.get("supernova");
const root = await fs.mkdtemp(path.join(os.tmpdir(),"supernova-stress-"));
const report = {packageRoot,root,node:process.version,machine:os.cpus()[0].model,programs:0,phases:{},status:"running"};
console.error("Stress fixture retained: " + root);
const times = [];
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function run(id,cwd,code,timeoutMs=5000,cancelOnWrite=false) {
  report.programs++;
  const started=performance.now();
  let first, snapshot, updates=0, staged=false;
  const cancellation=cancelOnWrite ? new AbortController() : undefined;
  const onUpdate = update => {
    updates++;
    if (!first && update.details?.trace?.length) { first=update.details.trace; snapshot=JSON.stringify(first); }
    if(cancellation && update.details?.trace?.some(row=>row.name==="write" && row.ok===true)) { staged=true; cancellation.abort(); }
    if (updates===2 && report.programs%17===0) throw Error("intentional UI callback failure");
  };
  try {
    return await tool.execute(id,{code,timeoutMs},cancellation?.signal,onUpdate,{cwd,
      sessionManager:{getSessionId:()=>id,getSessionFile:()=>undefined},model:{provider:"stress",id},thinkingLevel:"high"});
  } finally {
    times.push(performance.now()-started);
    if(cancelOnWrite)assert.ok(staged,"cancellation must follow a confirmed staged write");
    if(first)assert.equal(JSON.stringify(first),snapshot,"an emitted frame was mutated");
    const completed=updates;
    await tick();
    assert.equal(updates,completed,"a completed program emitted a trailing frame");
  }
}
async function phase(name,fn) {
  const start=performance.now();
  report.phases[name]=await fn();
  report.phases[name].ms=performance.now()-start;
  console.error(name+": "+JSON.stringify(report.phases[name]));
}
try {
  const workspaces=[];
  for(let i=0;i<2;i++) {
    const cwd=path.join(root,"workspace-"+i);
    await fs.mkdir(cwd);
    const body=Array.from({length:80},(_,line)=>'workspace '+i+' line '+line+' λ😀 "quoted" \\path').join("\r\n")+"\r\n";
    await fs.writeFile(path.join(cwd,"input.txt"),body);
    workspaces.push({cwd,body});
  }
  await phase("mixed",async()=>{
    for(let base=0;base<rounds;base+=8) await Promise.all(Array.from({length:Math.min(8,rounds-base)},async(_,offset)=>{
      const i=base+offset, {cwd,body}=workspaces[i%2], id="mixed-"+i, file=id+".json", candidate=id+".candidate";
      const result=await run(id,cwd,`
        if(globalThis.stressMarker!==undefined)throw Error("worker reused");
        globalThis.stressMarker=${JSON.stringify(id)};
        const checkpoint=await edit(async()=>{await write(${JSON.stringify(candidate)},"discard");throw Error("reject");});
        if(checkpoint.ok)throw Error("checkpoint accepted");
        await write(${JSON.stringify(file)},${JSON.stringify(JSON.stringify({id,counter:0}))});
        await edit(${JSON.stringify(file)},'"counter":0','"counter":1');
        const saved=JSON.parse(await read(${JSON.stringify(file)}));
        const values=await Promise.all(Array.from({length:129},()=>read("input.txt")));
        if(values.some(value=>value!==${JSON.stringify(body)}))throw Error("read corruption");
        const session=await bash('printf "%s" "$PI_SESSION_ID"');
        return {saved,session};
      `);
      assert.deepEqual(result.details.result,{saved:{id,counter:1},session:id});
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,file),"utf8")),{id,counter:1});
      await assert.rejects(fs.stat(path.join(cwd,candidate)),{code:"ENOENT"});
      assert.deepEqual(result.details.trace.filter(row=>row.name==="read" && Array.isArray(row.args.path)).map(row=>row.args.path.length),[64,64]);
    }));
    return {programs:rounds,independentReads:rounds*129,concurrency:8};
  });
  await phase("contention",async()=>{
    const cwd=workspaces[0].cwd;
    await fs.writeFile(path.join(cwd,"counter.txt"),"0");
    let committed=0, conflicts=0;
    for(let wave=0;wave<20;wave++) {
      const outcomes=await Promise.allSettled(Array.from({length:8},(_,i)=>run("contended-"+wave+"-"+i,cwd,
        'const value=Number(await read("counter.txt"));await new Promise(resolve=>setTimeout(resolve,20));await write("counter.txt",String(value+1));return value+1;')));
      for(const outcome of outcomes) {
        if(outcome.status==="fulfilled")committed++;
        else {assert.match(outcome.reason.message,/write conflict/);conflicts++;}
      }
      assert.equal(Number(await fs.readFile(path.join(cwd,"counter.txt"),"utf8")),committed,"successful updates were lost");
    }
    assert.ok(committed>=20 && conflicts>0);
    return {programs:160,committed,conflicts};
  });
  await phase("cancellation",async()=>{
    for(let wave=0;wave<8;wave++) await Promise.all(Array.from({length:8},async(_,i)=>{
      const {cwd,body}=workspaces[i%2], id="cancel-"+wave+"-"+i;
      if(i%2===0) {
        await assert.rejects(run(id,cwd,'await write('+JSON.stringify(id)+',"must roll back");globalThis.stressMarker=true;while(true){}',5000,true),/timed out|aborted/);
        await assert.rejects(fs.stat(path.join(cwd,id)),{code:"ENOENT"});
      } else {
        const result=await run(id,cwd,'if(globalThis.stressMarker!==undefined)throw Error("worker reused");return await read("input.txt");');
        assert.equal(result.details.result,body);
      }
    }));
    return {cancelled:32,healthy:32};
  });
  await phase("rawFidelity",async()=>{
    for(let i=0;i<16;i++) {
      const {cwd,body}=workspaces[i%2];
      const result=await run("raw-"+i,cwd,'return await read(Array(8).fill("input.txt"));');
      assert.deepEqual(result.details.result,Array(8).fill(body));
      const text=result.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
      assert.equal(text.split(body).length-1,8,"source copies were escaped, omitted or deduplicated");
    }
    return {programs:16,completeSourceCopies:128};
  });
  await phase("patchSource",async()=>{
    const cwd=workspaces[0].cwd;
    const lines=Array.from({length:60},(_,i)=>"line "+(i+1));
    lines[0]="first"; lines[49]="remove-me"; lines[50]="sentinel-after-delete";
    const expansion=Array.from({length:50},(_,i)=>"expanded "+i);
    await fs.writeFile(path.join(cwd,"patch.txt"),lines.join("\n")+"\n");
    const patch="--- a/patch.txt\n+++ b/patch.txt\n@@ -1,1 +1,50 @@\n-first\n"+expansion.map(line=>"+"+line+"\n").join("")+"@@ -50,1 +98,0 @@\n-remove-me\n";
    const result=await run("patch",cwd,'return await edit({path:"patch.txt",patch:'+JSON.stringify(patch)+'});');
    assert.equal(await fs.readFile(path.join(cwd,"patch.txt"),"utf8"),[...expansion,...lines.slice(1,49),...lines.slice(50)].join("\n")+"\n");
    assert.match(result.details.result,/sentinel-after-delete/,"a shifted deletion must return its actual post-edit source window");
    return {shiftedDeletionSource:true};
  });
  await phase("coldSource",async()=>{
    const cwd=path.join(root,"large-tree");
    await fs.mkdir(cwd);
    for(let base=0;base<5000;base+=100) await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(path.join(cwd,"irrelevant-"+(base+i)+".js"),"export const filler = 0;\n")));
    const body="export function stressLookupToken() { return true; }\n";
    await fs.writeFile(path.join(cwd,"zz-target.js"),body);
    const original=WorkspaceIndex.prototype.files;
    WorkspaceIndex.prototype.files=()=>assert.fail("ordinary source lookup built an index");
    try {
      const result=await run("source",cwd,'return await read({query:"stressLookupToken",resolve:true});');
      assert.equal(result.details.result.path,"zz-target.js");
      assert.equal(result.details.result.text,body);
      const miss=await run("fuzzy",cwd,'return await read({query:"unlikelytokenzzzzz",resolve:true});');
      assert.equal(miss.details.result.status,"incomplete");
      assert.equal(miss.details.result.path,null);
    } finally {WorkspaceIndex.prototype.files=original;}
    const large='export function stressLargeToken() {\r\n'+('// λ😀 "payload" \\path\r\n'.repeat(5000))+'}\r\n';
    await fs.writeFile(path.join(cwd,"large.js"),large);
    let offset=1, reconstructed="", windows=0;
    do {
      const result=await run("continuation-"+windows,cwd,'return await read({path:"large.js",offset:'+offset+',resolve:true});');
      reconstructed+=result.details.result.text;
      offset=result.details.result.nextOffset;
      assert.ok(++windows<100);
    } while(offset!==undefined);
    assert.equal(reconstructed,large);
    return {files:5002,sourceWindows:windows,exactContinuation:true};
  });
  report.status="passed";
} catch(error) {
  report.status="failed";
  report.error=error.stack;
  process.exitCode=1;
} finally {
  times.sort((a,b)=>a-b);
  report.latencyMs={p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],max:times.at(-1)};
  report.memory=process.memoryUsage();
  console.log(JSON.stringify(report,null,2));
}
