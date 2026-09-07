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
  await f.execute('await write({path:"new.txt",content:"a",append:true}); await write({path:"new.txt",content:"b",append:true});');
  assert.equal(await fs.readFile(path.join(f.root,"new.txt"),"utf8"), "ab");
  let called = false;
  f.pi.registerTool({name:"write",execute:async () => {called = true; return {};}});
  await assert.rejects(f.execute('await write({path:"chunks.txt",content:"unsafe",append:true});'), /append.*owned/);
  assert.equal(called, false);
  const budget = f.tool.parameters.properties.code.maxLength;
  assert.ok(Number.isInteger(budget) && budget > 0, "the program cap must be exposed");
  await assert.rejects(f.execute('await write("chunks.txt", "overwritten");' + " ".repeat(budget)), /code exceeds/);
  assert.equal(await fs.readFile(path.join(f.root,"chunks.txt"),"utf8"), first + "tail\n");
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
});

it("read-modify-write refuses truncated source instead of persisting a hole", async t => {
  const f=await engineFixture(t);
  const body="unique_value = 1\n"+"safe_value = 1\n".repeat(6000);
  await f.write("large.py",body);
  await assert.rejects(f.execute('await write("large.py",(await read("large.py")).replace("safe_value", "new_value"));'),/refusing.*truncat/i);
  assert.equal(await fs.readFile(path.join(f.root,"large.py"),"utf8"),body);
  await assert.rejects(f.execute('await read({path:"large.py",complete:true});'),/incomplete read/i);
  await assert.rejects(f.execute('await write("large.py","…[host-result truncated 11669 chars]…");'),/refusing.*truncat/i);
  assert.equal(await fs.readFile(path.join(f.root,"large.py"),"utf8"),body);
  await f.execute('await edit("large.py", "unique_value = 1", "unique_value = 2");');
  assert.equal(await fs.readFile(path.join(f.root,"large.py"),"utf8"),body.replace("unique_value = 1","unique_value = 2"));
});

it("complete reads reject aggregate clipping and intentional literal markers need opt-in", async t => {
  const f=await engineFixture(t);
  const body="payload\n".repeat(2500);
  for(const file of ["a.txt","b.txt","c.txt","d.txt"])await f.write(file,body);
  assert.equal((await f.execute('return await read({path:"a.txt",complete:true});')).details.result,body);
  await assert.rejects(f.execute('return await read(["a.txt","b.txt","c.txt","d.txt"],{complete:true});'),/incomplete read/);
  await assert.rejects(f.execute('return await read({path:"a.txt",offset:2,complete:true});'),/incomplete read/);
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
  assert.equal(source.path,"agent://ResearchDigest"); assert.equal(source.text," λ😀\r");
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

it("paged reads reconstruct CRLF and Unicode source without missing or duplicated lines", async t => {
  const f = await engineFixture(t);
  const body = Array.from({ length: 1400 }, (_, i) => `${i}: ${"λ😀 ".repeat(20)}\r\n`).join("");
  await f.write("pages.txt", body);
  let offset = 1;
  let reconstructed = "";
  for (let page = 0; page < 30; page++) {
    const result = await f.execute(`return await read({path:"pages.txt", offset:${offset}});`);
    const text = result.details.result;
    const marker = text.lastIndexOf("\n[read truncated;");
    if (marker < 0) { reconstructed += text; break; }
    reconstructed += text.slice(0, marker);
    const next = Number(/offset\s*[:=]\s*(\d+)/.exec(text.slice(marker))?.[1]);
    assert.ok(next > offset, "Continuation must make forward progress");
    offset = next;
  }
  assert.equal(reconstructed, body);
});

it("read arrays preserve returned images without sending base64 as model text", async t => {
  const f = await engineFixture(t);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
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
    ["before\n", "@@ -1 +1 @@\n-before\n+after\n\\ No newline at end of file\n", "after"],
  ]) {
    await f.write("patch.txt", before);
    await f.execute(`await edit({path:"patch.txt",patch:${JSON.stringify(patch)}});`);
    assert.equal(await fs.readFile(path.join(f.root,"patch.txt"),"utf8"), after);
    await assert.rejects(f.execute('await edit({path:"patch.txt",patch:"@@ -1 +1 @@\\n-missing\\n+bad\\n"});'), /context did not match/);
    assert.equal(await fs.readFile(path.join(f.root,"patch.txt"),"utf8"), after);
  }
});
