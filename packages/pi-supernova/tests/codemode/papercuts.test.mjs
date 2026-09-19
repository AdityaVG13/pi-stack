import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";
import { quickCheck } from "../../src/fs/check.js";

it("raw-read failures state both limits and executable recovery forms", async t => {
  const f = await engineFixture(t);
  const body = ("x".repeat(89) + "\n").repeat(133);
  await f.write("NORTHSTAR.md", body);
  await assert.rejects(f.execute('return await read("NORTHSTAR.md");'), error => {
    assert.match(error.message, /133 lines.*11970 characters/);
    assert.match(error.message, /160 lines.*8192 characters/);
    assert.ok(error.message.includes('read("NORTHSTAR.md", {offset:1, limit:80})'));
    assert.ok(error.message.includes('read("NORTHSTAR.md", {complete:true})'));
    return true;
  });
  assert.match(f.tool.description, /160 lines.*8192 characters/);
  assert.ok(f.tool.description.includes('read(path,{offset:1,limit:80})'));
  assert.equal((await f.execute('return await read("NORTHSTAR.md",{offset:1,limit:80});')).details.result, body.slice(0, 7200));
  assert.equal((await f.execute('return await read("NORTHSTAR.md",{complete:true});')).details.result, body);
  await f.write("history.jsonl", "{\"text\":\"message\"}\n".repeat(8000));
  await assert.rejects(f.execute('return await read("history.jsonl",{complete:true});'), /31744 characters.*bash/s);
});

it("an ignored failed checkpoint fails the program with its original cause", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "original");
  await assert.rejects(f.execute(`
    await write("outer.txt", "pending");
    await edit(async () => {
      await write("state.txt", "candidate");
      throw Error("required document missing");
    });
    return {updated_documents:["state.txt"]};
  `), error => {
    assert.match(error.message, /required document missing/);
    assert.equal(error.supernovaResult.details.ok, false);
    assert.equal(error.supernovaResult.details.mutations.rolledBack, 2);
    assert.doesNotMatch(error.message, /updated_documents/);
    return true;
  });
  assert.equal(await fs.readFile(path.join(f.root, "state.txt"), "utf8"), "original");
  await assert.rejects(fs.stat(path.join(f.root, "outer.txt")), {code:"ENOENT"});
});

it("a caller can explicitly catch checkpoint failure and continue after rollback", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "original");
  const result = await f.execute(`
    let caught;
    try { await edit(async () => { await write("state.txt", "lost"); throw Error("rejected candidate"); }); }
    catch (error) { caught = error.message; }
    const restored = await read("state.txt");
    await edit("state.txt", "original", "accepted");
    return {caught, restored};
  `);
  assert.deepEqual(result.details.result, {caught:"rejected candidate", restored:"original"});
  assert.equal(await fs.readFile(path.join(f.root, "state.txt"), "utf8"), "accepted");
});

it("Markdown and prose edits do not search references for fenced code or capital labels", async t => {
  const f = await engineFixture(t);
  const before = "# Runbook\n```python\nA = 1\nX = 2\nPY = 3\n```\n";
  await f.write("notes.md", before);
  await f.write("caller.js", "A(); X(); PY();\n");
  const result = await f.execute('return await edit("notes.md", "A = 1", "A = 4");');
  assert.doesNotMatch(modelText(result), /also referenced|references unavailable|references incomplete/);
  assert.match(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), /A = 4/);
});

it("exact-symbol usage evidence excludes generic calls, definitions and prefix matches", async t => {
  const f = await engineFixture(t);
  await f.write("fit.py", "def fit_whole_experts():\n    return 1\n");
  await f.write("calls.py", "def call():\n    return call_again()\n\ndef call_again():\n    return 1\n");
  await f.write("wrong.py", "def wrong_caller():\n    return fit_whole_experts_extra()\n");
  const absent = await f.execute('return await read({query:"Where is fit_whole_experts called?",evidence:true});');
  assert.deepEqual(absent.details.result.spans, []);
  const caller = "def build_plan():\n" + "    # preparation\n".repeat(75) + "    return fit_whole_experts()\n";
  const found = await f.execute(`await write("use.py", ${JSON.stringify(caller)}); return await read({query:"Where is fit_whole_experts called?",evidence:true});`);
  assert.ok(found.details.result.spans.length > 0);
  for (const span of found.details.result.spans) {
    assert.equal(span.path, "use.py");
    assert.match(span.text, /return fit_whole_experts\(\)/);
  }
});

it("missing argv data identifies the offending argument without running or committing", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.tool.execute("missing-data", {
    code:'await write("report.md",data.report); return await bash({command:process.execPath,args:["-e",data.records]});',
    data:{report:"pending report"},
  }, undefined, undefined, {cwd:f.root}), /args\[1\].*undefined.*data/s);
  await assert.rejects(fs.stat(path.join(f.root, "report.md")), {code:"ENOENT"});
  const ok = await f.tool.execute("nested-data", {
    code:'await write("report.md",data.report); return await bash({command:process.execPath,args:["-e",data.records]});',
    data:{report:"saved report", records:'process.stdout.write("nested data works")'},
  }, undefined, undefined, {cwd:f.root});
  assert.equal(ok.details.result, "nested data works");
});

it("oversized returned image sets fail with aggregate sizes instead of losing attachments", async t => {
  const f = await engineFixture(t);
  await f.write("small.png", "image");
  const fits = await f.execute('return await read(Array(16).fill("small.png"));');
  assert.equal(fits.content.filter(x => x.type === "image").length, 16);
  await assert.rejects(f.execute('await write("receipt.txt","pending"); return await read(Array(17).fill("small.png"));'), /17 images.*85 bytes.*16.*20 MiB/s);
  await assert.rejects(fs.stat(path.join(f.root, "receipt.txt")), {code:"ENOENT"});
  await f.write("large.png", Buffer.alloc(4 * 1024 * 1024));
  await assert.rejects(f.execute('return await read(Array(6).fill("large.png"));'), error => {
    assert.match(error.message, /6 images.*25165824 bytes.*20 MiB/s);
    assert.equal(error.supernovaResult.content.filter(x => x.type === "image").length, 0);
    return true;
  });
});

it("Rust lifetime and character syntax do not produce false edit/write warnings", async t => {
  const f = await engineFixture(t);
  const snippets = [
    "fn query<F: FnOnce(&rusqlite::Row<'_>)>(f: F) {}\n",
    "fn commands() -> Result<&'static [&'static str], String> { Ok(&[]) }\n",
    "fn sql_literal(s: &str) -> String { s.replace('\\\'', \"''\") }\nfn rows(r: &mut Rows<'_>) {}\n",
    "fn borrow<'scope>(x: &'scope str) -> &'scope str { x }\n",
    "fn label() { 'outer: loop { break 'outer; } let c = '🦀'; let q = '\\''; }\n",
  ];
  for (const [i, source] of snippets.entries()) {
    assert.equal(quickCheck(source, ".rs").ok, true, source);
    const result = await f.tool.execute("rust-write", {code:'return await write(data.path,data.source);', data:{path:`case${i}.rs`,source}}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(modelText(result), /check:/);
  }
  const edited = await f.execute('return await edit("case0.rs", "f: F", "_f: F");');
  assert.doesNotMatch(modelText(edited), /check:/);
  for (const source of ['fn bad() { let x = [1, 2); }', 'fn bad() { let x = "unterminated; }', "fn bad() { let x = '\\n; }"]) {
    assert.equal(quickCheck(source, ".rs").ok, false, "real broken literals/brackets must still be reported");
  }
});

it("shell commands inherit the program timeout while explicit command limits still win", async t => {
  const f = await engineFixture(t);
  const schedule = globalThis.setTimeout;
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => { delays.push(delay); return schedule(fn, delay, ...args); });
  const code = 'return await bash({command:process.execPath,args:["-e", "process.stdout.write(\\\"ok\\\")"],...data});';
  const result = await f.tool.execute("long-command", {code, data:{}, timeoutMs:300000}, undefined, undefined, {cwd:f.root});
  assert.equal(result.details.result, "ok");
  assert.equal(delays.filter(ms => ms === 300000).length, 2, "both the guest and its shell command must receive 300 seconds");
  assert.equal(delays.includes(60000), false, "no hidden 60-second shell cap");
  delays.length = 0;
  await f.tool.execute("short-command", {code, data:{timeoutMs:1200}, timeoutMs:300000}, undefined, undefined, {cwd:f.root});
  assert.equal(delays.filter(ms => ms === 300000).length, 1);
  assert.ok(delays.includes(1200), "an explicit per-command deadline must remain authoritative");
});

it("oversized data reports serialized size and a lossless chunked-write recovery", async t => {
  const f = await engineFixture(t);
  const payload = {path:"large.log",content:'"\\\n'.repeat(18000)};
  const size = JSON.stringify(payload).length;
  await assert.rejects(f.tool.execute("data-budget", {code:'return await write(data.path,data.content);',data:payload}, undefined, undefined, {cwd:f.root}), error => {
    assert.match(error.message, /data exceeds 48000 characters/);
    assert.ok(error.message.includes(String(size)), "report actual serialized size, not only raw content length");
    assert.match(error.message, /append:true/);
    return true;
  });
  await assert.rejects(fs.stat(path.join(f.root, payload.path)), {code:"ENOENT"});
  for (let start=0; start<payload.content.length; start+=10000) {
    const chunk = {path:payload.path,content:payload.content.slice(start,start+10000),append:true};
    await f.tool.execute("chunk", {code:'return await write(data);',data:chunk}, undefined, undefined, {cwd:f.root});
  }
  assert.equal(await fs.readFile(path.join(f.root,payload.path),"utf8"),payload.content);
});

it("outside-workspace writes identify the rejected path and preserve confinement", async t => {
  const f = await engineFixture(t);
  const outside = path.join(path.dirname(f.root),path.basename(f.root)+"-outside.log");
  await assert.rejects(f.tool.execute("external-path", {code:'return await write(data.path,"no");',data:{path:outside}}, undefined, undefined, {cwd:f.root}), error => {
    assert.match(error.message, /path escapes workspace/);
    assert.ok(error.message.includes(outside));
    assert.match(error.message, /workspace-relative/);
    return true;
  });
  await assert.rejects(fs.stat(outside),{code:"ENOENT"});
  await f.execute('return await write("artifacts/result.log","kept");');
  assert.equal(await fs.readFile(path.join(f.root,"artifacts/result.log"),"utf8"),"kept");
});

it("unsupported image formats fail before model delivery and roll back pending writes", async t => {
  const f = await engineFixture(t);
  // A valid uncompressed 1x1, 24-bit BMP, not a corrupt-image test.
  const bmp = Buffer.alloc(58);
  bmp.write("BM"); bmp.writeUInt32LE(58,2); bmp.writeUInt32LE(54,10);
  bmp.writeUInt32LE(40,14); bmp.writeInt32LE(1,18); bmp.writeInt32LE(1,22);
  bmp.writeUInt16LE(1,26); bmp.writeUInt16LE(24,28); bmp.writeUInt32LE(4,34);
  bmp[56] = 255;
  await fs.writeFile(path.join(f.root,"screen.bmp"),bmp);
  const noImages = error => {
    assert.match(error.message,/unsupported image.*image\/bmp/);
    assert.match(error.message,/convert.*PNG/i);
    assert.equal(error.supernovaResult.content.some(part => part.type === "image"),false);
    return true;
  };
  await assert.rejects(f.execute('await write("pending.txt","not committed"); return await read("screen.bmp");'), noImages);
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
  const images = [
    {type:"image",mimeType:"image/png",data:"iVBORw0KGgo="},
    {type:"image",mimeType:"image/bmp",data:bmp.toString("base64")},
  ];
  await assert.rejects(f.tool.execute("returned-bmp", {code:'await write("pending.txt","not committed"); return data;',data:images}, undefined, undefined, {cwd:f.root}), noImages);
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
  assert.deepEqual(await fs.readFile(path.join(f.root,"screen.bmp")),bmp,"source image must remain unchanged");
  assert.doesNotMatch(f.tool.description,/PNG\/JPEG\/GIF\/WebP\/BMP/);
});

it("optional reads retain successful siblings explicitly, without weakening uncaught-error rollback", async t => {
  const f = await engineFixture(t);
  await f.write("small.txt","complete sibling\n");
  await assert.rejects(f.execute('await write("pending.txt","not committed"); return {ok:await read("small.txt"),missing:await read("missing.txt")};'), /Promise\.allSettled/);
  await assert.rejects(fs.stat(path.join(f.root,"pending.txt")),{code:"ENOENT"});
  const result = await f.execute('return await Promise.allSettled(["small.txt","missing.txt"].map(path=>read(path)));');
  assert.deepEqual(result.details.result[0],{status:"fulfilled",value:"complete sibling\n"});
  assert.equal(result.details.result[1].status,"rejected");
  assert.match(result.details.result[1].reason.message,/no such file/);
  assert.equal(result.details.returnTruncated,false);
});
