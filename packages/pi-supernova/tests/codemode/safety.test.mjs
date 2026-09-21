import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";

it("large document chunks append without round-tripping bounded reads", async t => {
  const f = await engineFixture(t);
  const first = "λ😀\r\n".repeat(14000);
  await f.write("chunks.txt", first);
  await f.execute('await write({path:"chunks.txt",content:"tail\\n",append:true});');
  assert.equal(await fs.readFile(path.join(f.root,"chunks.txt"),"utf8"), first + "tail\n");
  await assert.rejects(f.execute('await write({path:"chunks.txt",content:"lost",append:true}); throw Error("rollback append");'), /rollback append/);
  assert.equal(await fs.readFile(path.join(f.root,"chunks.txt"),"utf8"), first + "tail\n");
  await assert.rejects(f.execute('await write({path:"chunks.txt",content:"…[host-result truncated 10 chars]…",append:true});'), /refusing.*truncat/i);
  await assert.rejects(f.execute('await write({path:"chunks.txt",content:"…[output truncated]…",append:true});'), /refusing.*truncat/i);
  await f.execute('await write({path:"new.txt",content:"a",append:true}); await write({path:"new.txt",content:"b",append:true});');
  assert.equal(await fs.readFile(path.join(f.root,"new.txt"),"utf8"), "ab");
  let called = false;
  f.pi.registerTool({name:"write",execute:async () => {called = true;

 return {};}});
  await assert.rejects(f.execute('await write({path:"chunks.txt",content:"unsafe",append:true});'), /append.*owned/);
  assert.equal(called, false);
  const budget = f.tool.parameters.properties.code.maxLength;
  assert.ok(Number.isInteger(budget) && budget > 0, "the program cap must be exposed");
  await assert.rejects(f.execute('await write("chunks.txt", "overwritten");' + " ".repeat(budget)), /code exceeds/);
  assert.equal(await fs.readFile(path.join(f.root,"chunks.txt"),"utf8"), first + "tail\n");
});

it("large overwrites report exact added and removed line counts", async t => {
  const f = await engineFixture(t);
  const oldLines = 150000;
  await f.write("large.txt", "old line\n".repeat(oldLines));
  const result = await f.execute('await write("large.txt", "replacement\\n"); return "done";');
  const record = result.details.trace.find(entry => entry.name === "write");
  assert.equal(record.diff.removed, oldLines);
  assert.equal(record.diff.added, 1);
  assert.equal(await fs.readFile(path.join(f.root,"large.txt"),"utf8"), "replacement\n");
});

it("bash rejects invalid timeout values before spawning", async t => {
  const f = await engineFixture(t);

  for (const literal of ["0", "-1", "NaN", "Infinity", JSON.stringify("later")]) {
    await assert.rejects(f.execute(`return await bash({command:"printf should-not-run",timeoutMs:${literal}});`), /positive finite number/);
  }
});

it("focused plain-text reads select matching log lines instead of a truncated prefix", async t => {
  const f = await engineFixture(t);
  await f.write("status.log", "unrelated status entry\n".repeat(10000) + "STT database migration pending\nrequired archive: recordings.zip\n");
  const result = await f.execute('return await read("status.log",{about:"STT database"});');
  assert.match(result.details.result, /10001 STT database migration pending/);
  assert.match(result.details.result, /required archive: recordings.zip/);
  assert.ok(result.details.result.length < 8000);
  const absent = await f.execute('return await read("status.log",{about:"quasar"});');
  assert.match(absent.details.result, /no matching text/);
  await assert.rejects(f.execute('return await read("status.log",{about:"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen"});'), /at most 16 keywords/);
});

it("complete data does not bypass write-after-read or literal-artifact protection", async t => {
  const f=await engineFixture(t);
  const body="unique_value = 1\n"+"safe_value = 1\n".repeat(6000);
  await f.write("large.py",body);
  await assert.rejects(f.execute('await write("large.py",(await read("large.py")).replace("safe_value", "new_value"));'),/already read this program; use edit/i);
  assert.equal(await fs.readFile(path.join(f.root,"large.py"),"utf8"),body);
  assert.equal((await f.execute('return (await read({path:"large.py",complete:true})).length;')).details.result,body.length);
  await assert.rejects(f.execute('await write("large.py","…[host-result truncated 11669 chars]…");'),/refusing.*truncat/i);
  assert.equal(await fs.readFile(path.join(f.root,"large.py"),"utf8"),body);
  await f.execute('await edit("large.py", "unique_value = 1", "unique_value = 2");');
  assert.equal(await fs.readFile(path.join(f.root,"large.py"),"utf8"),body.replace("unique_value = 1","unique_value = 2"));
});

it("complete read batches preserve full data and intentional literal markers need opt-in", async t => {
  const f=await engineFixture(t);
  const body="payload\n".repeat(2500);

  for(const file of ["a.txt","b.txt","c.txt","d.txt"])await f.write(file,body);
  assert.equal((await f.execute('return await read({path:"a.txt",complete:true});')).details.result,body);
  assert.deepEqual((await f.execute('return (await read(["a.txt","b.txt","c.txt","d.txt"],{complete:true})).map(text=>text.length);')).details.result,Array(4).fill(body.length));
  await assert.rejects(f.execute('return await read({path:"a.txt",offset:2,complete:true});'),/complete:true requires the whole file/);
  await f.execute('await write({path:"literal.txt",content:"…[host-result truncated 10 chars]…",allowReadArtifacts:true});');
  assert.equal(await fs.readFile(path.join(f.root,"literal.txt"),"utf8"),"…[host-result truncated 10 chars]…");
});

it("explicit read batches reject missing files and expose per-path outcomes through allSettled", async t => {
  const f=await engineFixture(t);
  await f.write("present.txt","retained");
  await assert.rejects(f.execute('return await read(["present.txt","missing.txt"]);'),/missing.txt/);
  await assert.rejects(f.execute('return await read(["present.txt","missing.txt"],{resolve:true});'),/missing.txt/);
});

it("session resource reads preserve IDs, pagination and caller isolation", async t => {
  const f=await engineFixture(t);

  const roots=await Promise.all(["one","two"].map(async name=>{
    const dir=path.join(f.root,name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir,"ResearchDigest.md"),name+" λ😀\r\n".repeat(2000));
    await fs.writeFile(path.join(dir,"131.txt"),"artifact "+name);

    return dir;
  }));

  const execute=(code,dir)=>f.tool.execute("uri",{code,timeoutMs:2000},undefined,undefined,{cwd:f.root,sessionManager:{getArtifactsDir:()=>dir}});
  const values=await Promise.all(roots.map(dir=>execute('return await read(["agent://ResearchDigest","artifact://131"]);',dir)));
  assert.deepEqual(values.map(r=>r.details.result[1]),["artifact one","artifact two"]);
  assert.equal(values[0].details.result[0],"one"+" λ😀\r\n".repeat(2000));
  const source=(await execute('return await read({path:"agent://ResearchDigest",resolve:true,offset:2,limit:1});',roots[0])).details.result;
  assert.equal(source.path,"agent://ResearchDigest"); assert.equal(source.text," λ😀\r\n");
  await assert.rejects(f.execute('return await read("agent://ResearchDigest");'),/does not expose an artifacts directory/);
  await assert.rejects(execute('return await read("agent://%2e%2e%2fsecret");',roots[0]),/invalid session resource ID/);
  await fs.symlink(path.join(roots[1],"ResearchDigest.md"),path.join(roots[0],"Escape.md"));
  await assert.rejects(execute('return await read("agent://Escape");',roots[0]),/escapes its artifacts directory/);
  await fs.writeFile(path.join(roots[0],"131.json"),"{}");
  await assert.rejects(execute('return await read("artifact://131");',roots[0]),/ambiguous session artifact/);
  await assert.rejects(f.execute('await write("agent://ResearchDigest","bad");'),/read-only/);
});

it("coalescing never confuses actual file content with a batch error marker", async t => {
  const f = await engineFixture(t);
  await f.write("literal.txt", "[read error: this is literal source text]");
  await f.write("other.txt", "other");
  const result = await f.execute('return await Promise.all([read("literal.txt"), read("other.txt")]);');
  assert.deepEqual(result.details.result, ["[read error: this is literal source text]", "other"]);
});

it("an independent failed read rejects only its own promise", async t => {
  const f = await engineFixture(t);
  await f.write("present.txt", "retained");
  const result = await f.execute('return await Promise.allSettled([read("missing.txt"), read("present.txt")]);');
  assert.equal(result.details.result[0].status, "rejected");
  assert.deepEqual(result.details.result[1], { status: "fulfilled", value: "retained" });
});

it("read, mutation, read submission order survives automatic batching", async t => {
  const f = await engineFixture(t);
  await f.write("ordered.txt", "before");

  const result = await f.execute(`
    const before = read("ordered.txt");
    const change = edit("ordered.txt", "before", "after");
    const after = read("ordered.txt");
    await change;
    return [await before, await after];
  `);

  assert.deepEqual(result.details.result, ["before", "after"]);
});

it("a failed edit set and a failed program do not install partial file changes", async t => {
  const f = await engineFixture(t);
  await f.write("atomic.txt", "original");
  await assert.rejects(f.execute('await edit({path:"atomic.txt", edits:[{oldText:"original",newText:"changed"},{oldText:"missing",newText:"bad"}]});'), /not found/);
  assert.equal(await fs.readFile(path.join(f.root, "atomic.txt"), "utf8"), "original");
  await assert.rejects(f.execute('await write("atomic.txt", "staged"); throw Error("rollback");'), /rollback/);
  assert.equal(await fs.readFile(path.join(f.root, "atomic.txt"), "utf8"), "original");
});

it("plain reads reject a FIFO without waiting for a writer", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  await f.execute('await bash("mkfifo pipe.txt");');
  await assert.rejects(f.execute('return await read("pipe.txt");'), /regular file/);
});

it("image reads reject staged non-images and FIFOs", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.execute('await write("staged.png","png-data"); return await read("staged.png");'), /invalid image.*staged.png.*signature/);
  await assert.rejects(fs.stat(path.join(f.root,"staged.png")),{code:"ENOENT"});
  await f.execute('await bash("mkfifo fifo.png");');
  await assert.rejects(f.execute('return await read("fifo.png");'), /regular file/);
});

it("paged reads reconstruct CRLF and Unicode source without missing or duplicated lines", async t => {
  const f=await engineFixture(t);
  const body=Array.from({length:1400},(_,i)=>i+": "+"λ😀 ".repeat(20)+"\r\n").join("");
  await f.write("pages.txt",body);
  let reconstructed="";
  for(let offset=1;offset<=1400;offset+=80) {
    const result=await f.execute('return await read({path:"pages.txt",offset:'+offset+',limit:80});');
    assert.equal(result.details.returnTruncated,false);
    reconstructed+=result.details.result;
  }
  assert.equal(reconstructed,body);
});

it("read arrays preserve returned images without sending base64 as model text", async t => {
  const f = await engineFixture(t);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  await f.write("pixel.png", image);
  await f.write("note.txt", "note");
  const result = await f.execute('return await read(["pixel.png", "note.txt"]);');
  assert.equal(result.content.filter(block => block.type === "image").length, 1);
  assert.ok(!modelText(result).includes(image.toString("base64")));
  const discarded = await f.execute('await read("pixel.png"); return "only this";');
  assert.equal(discarded.content.filter(block => block.type === "image").length, 0);
});

it("patches preserve empty-file and newline boundaries and reject mismatched context", async t => {
  const f = await engineFixture(t);

  for (const [before, patch, after] of [
    ["", "@@ -0,0 +1,1 @@\n+created\n", "created\n"],
    ["before\r\n", "@@ -1 +1 @@\n-before\n+after\n", "after\r\n"],
    ["before\n", "@@ -1 +1 @@\r\n-before\r\n+after\r\n", "after\n"],
    ["before\n", "@@ -1 +1 @@\n-before\n+after\n\\ No newline at end of file\n", "after"],
  ]) {
    await f.write("patch.txt", before);
    await f.execute(`await edit({path:"patch.txt",patch:${JSON.stringify(patch)}});`);
    assert.equal(await fs.readFile(path.join(f.root,"patch.txt"),"utf8"), after);
    await assert.rejects(f.execute('await edit({path:"patch.txt",patch:"@@ -1 +1 @@\\n-missing\\n+bad\\n"});'), /context did not match/);
    assert.equal(await fs.readFile(path.join(f.root,"patch.txt"),"utf8"), after);
  }
});

it("corrupt PNGs fail before shell/commit or model delivery and leave the host usable", async t => {
  const f = await engineFixture(t);
  // Exact attachment that made Codex reject every subsequent request in the session.
  const corrupt = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await f.write("corrupt.png", Buffer.from(corrupt,"base64"));
  const noImages = error => {
    assert.match(error.message,/invalid PNG.*IDAT.*checksum/);
    assert.match(error.message,/no image attached/);
    assert.equal(error.supernovaResult.content.some(block=>block.type==="image"),false);
    assert.equal(error.supernovaResult.details.mutations.committed,0);
    assert.equal(error.supernovaResult.details.mutations.rolledBack,1);
    return true;
  };
  await assert.rejects(f.execute('await write("pending.txt","not committed"); await read("corrupt.png"); await bash("printf should-not-run");'),noImages);
  await assert.rejects(f.tool.execute("corrupt-return",{
    code:'await write("pending.txt","not committed"); return {nested:data};',
    data:{type:"image",mimeType:"image/png",data:corrupt},
  },undefined,undefined,{cwd:f.root}),noImages);
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
  assert.equal((await fs.readFile(path.join(f.root,"corrupt.png"))).toString("base64"),corrupt);
  assert.equal((await f.execute('return "still usable";')).details.result,"still usable");
});

for (const [extension,mimeType,base64] of [
  ["png","image/png","iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQA2mP8/x8AAwMCAKtDFO0AAAAASUVORK5CYII="],
  ["jpg","image/jpeg",Buffer.from("not an image").toString("base64")],
  ["gif","image/gif",Buffer.from("not an image").toString("base64")],
  ["webp","image/webp",Buffer.from("not an image").toString("base64")],
]) {
  it(`undecodable ${extension} data cannot cross a shell boundary or become an attachment`, async t => {
    const f = await engineFixture(t);
    // The PNG has correct chunk CRCs but an invalid compressed pixel stream.
    await f.write("invalid."+extension,Buffer.from(base64,"base64"));
    const noImages = error => {
      assert.match(error.message,/image|PNG|JPEG|GIF|WebP/);
      assert.equal(error.supernovaResult.content.some(block=>block.type==="image"),false);
      assert.equal(error.supernovaResult.details.mutations.committed,0);
      assert.equal(error.supernovaResult.details.mutations.rolledBack,1);
      return true;
    };
    await assert.rejects(f.execute(`await write("pending.txt","discard"); await read("invalid.${extension}"); await bash("printf should-not-run");`),noImages);
    await assert.rejects(f.tool.execute("undecodable-return",{
      code:'await write("pending.txt","discard"); return data;',data:{type:"image",mimeType,data:base64},
    },undefined,undefined,{cwd:f.root}),noImages);
    await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
  });
}

it("returned image base64 rejects invalid characters instead of decoding them permissively", async t => {
  const f = await engineFixture(t);
  const data = "!iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  await assert.rejects(f.tool.execute("invalid-base64",{
    code:'await write("pending.txt","discard"); return data;',data:{type:"image",mimeType:"image/png",data},
  },undefined,undefined,{cwd:f.root}),error=>{
    assert.match(error.message,/base64/i);
    assert.equal(error.supernovaResult.content.some(block=>block.type==="image"),false);
    return true;
  });
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
});

it("image validation preserves valid static and animated bytes in every supported format", async t => {
  const f = await engineFixture(t);
  const {default:sharp} = await import("sharp");
  for (const format of ["png","jpeg","gif","webp"]) {
    const image = await sharp({create:{width:2,height:2,channels:4,background:"red"}}).toFormat(format).toBuffer();
    await f.write("valid."+format,image);
    const result = await f.execute(`return await read("valid.${format}");`);
    assert.equal(result.content.find(block=>block.type==="image")?.data,image.toString("base64"));
  }
  for (const format of ["gif","webp"]) {
    const frames = Buffer.from([...Array(4).fill([255,0,0]).flat(),...Array(4).fill([0,0,255]).flat()]);
    const image = await sharp(frames,{raw:{width:2,height:4,pageHeight:2,channels:3}}).toFormat(format,{delay:[100,100]}).toBuffer();
    assert.equal((await sharp(image,{animated:true}).metadata()).pages,2);
    await f.write("animated."+format,image);
    const result = await f.execute(`return await read("animated.${format}");`);
    assert.equal(result.content.find(block=>block.type==="image")?.data,image.toString("base64"));
  }
});

it("declared image MIME cannot disagree with the encoded format", async t => {
  const f = await engineFixture(t);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=","base64");
  await f.write("mislabelled.jpg",bytes);
  await assert.rejects(f.execute('return await read("mislabelled.jpg");'),/image.*(signature|format|match)/i);
});

it("decoded pixel budget rejects oversized images before allocating a full raster", async t => {
  const f = await engineFixture(t);
  const {default:sharp} = await import("sharp");
  const bytes = await sharp({create:{width:8001,height:4000,channels:3,background:"red"}}).png().toBuffer();
  await f.write("oversized.png",bytes);
  await assert.rejects(f.execute('await write("pending.txt","discard"); return await read("oversized.png");'),/pixel limit|32000000|32 MP/i);
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
});

it("truncated non-PNG pixel streams are rejected even when their signatures survive", async t => {
  const f = await engineFixture(t);
  const {default:sharp} = await import("sharp");
  for (const format of ["jpeg","gif","webp"]) {
    const bytes = await sharp({create:{width:16,height:16,channels:3,background:"red"}}).toFormat(format).toBuffer();
    await f.write("truncated."+format,bytes.subarray(0,Math.floor(bytes.length/2)));
    await assert.rejects(f.execute(`return await read("truncated.${format}");`),/invalid image/i);
  }
});

it("image validation reuses only decoded content and never a stale file path", async t => {
  const f = await engineFixture(t);
  const {default:sharp} = await import("sharp");
  const bytes = await sharp({create:{width:7,height:3,channels:3,background:"#092143"}}).png().toBuffer();
  await f.write("changing.png",bytes);
  const {default:childProcess} = await import("node:child_process");
  let decodes = 0;
  const original = childProcess.spawn;
  t.mock.method(childProcess,"spawn",function(...args){
    if (args[1]?.[0]?.endsWith("image-worker.js")) decodes++;
    return original.apply(this,args);
  });
  await f.execute('return "text-only";');
  assert.equal(decodes,0);
  await f.execute('return await read("changing.png");');
  await f.execute('return await read("changing.png");');
  assert.equal(decodes,1,"read and final delivery should share exact-content validation");
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length-1] ^= 1;
  await f.write("changing.png",corrupt);
  await assert.rejects(f.execute('return await read("changing.png");'),/checksum/);
  assert.equal(decodes,1,"changed bytes must fail preflight rather than reuse the path's prior success");
});

it("cancellation kills an image decoder and releases its queue slot", async t => {
  const {default:sharp} = await import("sharp");
  const {validateImageBytes} = await import("../../src/shared/image.js");
  const bytes = await sharp({create:{width:9,height:3,channels:3,background:"#315279"}}).png().toBuffer();
  const controller = new AbortController();
  const {default:childProcess} = await import("node:child_process");
  const original = childProcess.spawn;
  const mocked = t.mock.method(childProcess,"spawn",function(...args){
    const child = original.apply(this,args);
    if (args[1]?.[0]?.endsWith("image-worker.js")) setImmediate(()=>controller.abort());
    return child;
  });
  await assert.rejects(validateImageBytes(bytes,"image/png","cancel.png",controller.signal),{name:"AbortError"});
  mocked.mock.restore();
  await validateImageBytes(bytes,"image/png","retry.png");
});

it("image decoder watchdog fails closed and permits a subsequent decode", async t => {
  const f = await engineFixture(t);
  const {default:sharp} = await import("sharp");
  const {default:childProcess} = await import("node:child_process");
  const bytes = await sharp({create:{width:11,height:3,channels:3,background:"#142538"}}).png().toBuffer();
  await f.write("watchdog.png",bytes);
  const original = childProcess.spawn;
  const spawn = t.mock.method(childProcess,"spawn",function(command,args,options){
    return original.call(this,command,args[0]?.endsWith("image-worker.js") ? ["-e","setInterval(()=>{},1000)"] : args,options);
  });
  const schedule = globalThis.setTimeout;
  let watchdog = false;
  const timer = t.mock.method(globalThis,"setTimeout",(fn,ms,...args)=>{
    if (ms === 5000) { watchdog=true; ms=20; }
    return schedule(fn,ms,...args);
  });
  await assert.rejects(f.execute('await write("pending.txt","discard"); return await read("watchdog.png");'),/image decoding exceeded 5000 ms/);
  assert.equal(watchdog,true);
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
  spawn.mock.restore(); timer.mock.restore();
  assert.equal((await f.execute('return await read("watchdog.png");')).details.ok,true);
});
