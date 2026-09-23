import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../src/fs/workspace.js";
import { engineFixture, modelText } from "../helpers/engine.mjs";
import { quickCheck } from "../../src/fs/check.js";
import { jsonErrorContext, parsePosition } from "../../src/shared/syntax-context.js";

it("read guidance separates data limits from display limits and supports executable windows", async t => {
  const f=await engineFixture(t);
  const body=("x".repeat(89)+"\n").repeat(133);
  await f.write("NORTHSTAR.md",body);
  assert.equal((await f.execute('return await read("NORTHSTAR.md");')).details.result,body);
  assert.match(f.tool.description,/64 MiB internally/);
  assert.ok(f.tool.description.includes('read(path,{offset:1,limit:80})'));
  assert.equal((await f.execute('return await read("NORTHSTAR.md",{offset:1,limit:80});')).details.result,body.slice(0,7200));
  assert.equal((await f.execute('return await read("NORTHSTAR.md",{complete:true});')).details.result,body);
  await f.write("history.jsonl",'{"text":"message"}\n'.repeat(8000));
  assert.equal((await f.execute('return (await read("history.jsonl",{complete:true})).trimEnd().split("\\n").length;')).details.result,8000);
});

it("explicit extensionless reads stay file operations across scalar, batch and optional paths", async t => {
  const f = await engineFixture(t);
  await f.write("TOKEN","present");

  const result = await f.execute(`
    const results = await Promise.allSettled([
      read({path:"missingToken"}), read({target:"missingToken"}),
      read("missingToken",{resolve:false}), read("missingToken",{complete:true}),
      read("missingToken",{offset:1,limit:2}), read(["TOKEN","missingToken"])
    ]);
    return results.map(result=>({status:result.status,error:result.reason?.message}));
  `);

  for (const entry of result.details.result) {
    assert.equal(entry.status,"rejected");
    assert.match(entry.error,/no such file/);
  }

  assert.equal((await f.execute('return await read({path:"TOKEN"});')).details.result,"present");
  assert.deepEqual((await f.execute('return await read(["TOKEN"]);')).details.result,["present"]);
  await assert.rejects(f.execute('await read({path:"TOKEN"});await write("TOKEN","unintended");'),/already read/);
  assert.equal(await fs.readFile(path.join(f.root,"TOKEN"),"utf8"),"present");
  assert.equal((await f.execute('return await read("nonexistentSymbolQuery");')).details.result.status,"not_found");
  assert.equal((await f.execute('return await read({query:"nonexistentSymbolQuery"});')).details.result.status,"not_found");
});

for (const mode of ["bare","inline batch","streamed batch","text query"]) it(`write guard uses source-read provenance (${mode})`, async t => {
  const f = await engineFixture(t);
  const target = mode === "text query" ? "guarded.js" : "TOKEN";
  const body = mode === "text query" ? "export function guardedSymbol() { return 1; }\n" : "x".repeat(mode === "streamed batch" ? 40000 : 20);
  const targets = mode.includes("batch") ? [target,"SECOND"] : [target];

  for (const file of targets) await f.write(file,body);

  const reading = mode === "bare" ? 'await read("TOKEN");'
    : mode === "text query" ? 'await read({query:"guardedSymbol",resolve:false});'
      : 'await Promise.all([read("TOKEN"),read("SECOND")]);';

  // Distinct targets and one invocation make lost first/final item metadata
  // observable regardless of completion order; one successful read cannot mask another.
  const outcomes = await f.execute(reading+'return (await Promise.allSettled('+JSON.stringify(targets)+'.map(path=>write(path,"unintended")))).map(r=>({status:r.status,error:r.reason?.message}));');

  for (const result of outcomes.details.result) {
    assert.equal(result.status,"rejected");
    assert.match(result.error,/already read/);
  }

  for (const file of targets) assert.equal(await fs.readFile(path.join(f.root,file),"utf8"),body);
  await f.execute(reading+'await Promise.all('+JSON.stringify(targets)+'.map(path=>write({path,content:"intentional",replace:true})));');

  for (const file of targets) assert.equal(await fs.readFile(path.join(f.root,file),"utf8"),"intentional");
});

it("source views and evidence use portable nested paths", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root,"nested"));
  await f.write("nested/api.js","export function portablePathSymbol() { return 1; }\n");
  const source = await f.execute('return await read({query:"portablePathSymbol",resolve:true});');
  assert.equal(source.details.result.path,"nested/api.js");
  const evidence = await f.execute('return await read({query:"portablePathSymbol",evidence:true});');
  assert.equal(evidence.details.result.spans[0].path,"nested/api.js");
  await f.write("nested/other.js","export function portablePathSymbol() { return 2; }\n");
  const ambiguous = await f.execute('return await read({query:"portablePathSymbol",resolve:true});');
  assert.equal(ambiguous.details.result.status,"ambiguous");
  assert.deepEqual(ambiguous.details.result.candidates.map(c=>c.path).sort(),["nested/api.js","nested/other.js"]);
});

it("JSON document path fields never masquerade as read provenance", async t => {
  const f = await engineFixture(t);
  await f.write("record.json",JSON.stringify({status:"found",path:"result.txt",text:"document content"}));
  await f.execute('await Promise.all([read({path:"record.json",json:true}),read({path:"record.json",json:"."})]);await write("result.txt","new file");');
  assert.equal(await fs.readFile(path.join(f.root,"result.txt"),"utf8"),"new file");
  await assert.rejects(f.execute('await read({path:"record.json",json:true});await write("record.json","unintended");'),/already read/);
});

it("Unicode syntax carets use display columns for JavaScript and JSON", async t => {
  const f = await engineFixture(t);

  const check = (error,column) => {
    const caret = error.message.split("\n").find(line=>line.trim() === "^");
    assert.equal(caret?.indexOf("^"),column,error.message);

    return true;
  };

  // Two wide CJK characters add two columns; one combining mark removes one.
  await assert.rejects(f.execute('const 名字 = "e\u0301"; return (1 + );'),error=>check(error,32));
  await f.write("unicode.json",'{"名字":"e\u0301",BAD}');
  await assert.rejects(f.execute('return await read({path:"unicode.json",json:true});'),error=>check(error,14));
});

it("syntax context follows each parser's line endings and expands tabs consistently", async t => {
  const f = await engineFixture(t);

  for (const separator of ["\r","\r\n","\u2028","\u2029"]) {
    await assert.rejects(f.execute('const ok = 1;'+separator+'return (1 + );'),error=>{
      assert.match(error.message,/\n  return \(1 \+ \);\n +\^/);

      return true;
    });
  }

  for (const text of ['{\rBAD}', '{\r\nBAD}', '{"x":"a\u2028b",BAD}', '[\tBAD]']) {
    await f.write("invalid.json",text);
    await assert.rejects(f.execute('return await read({path:"invalid.json",json:true});'),error=>{
      const lines = error.message.split("\n");
      const caretLine = lines.findIndex(line=>line.trim() === "^");
      const shown = lines[caretLine-1];
      assert.ok(shown?.includes("BAD"),error.message);
      assert.ok(!shown.includes("\t"),"tabs must not shift the visible caret");
      assert.equal(shown[lines[caretLine].indexOf("^")],"B");

      return true;
    });
  }
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
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=","base64");
  await f.write("small.png", pixel);
  const fits = await f.execute('return await read(Array(16).fill("small.png"));');
  assert.equal(fits.content.filter(x => x.type === "image").length, 16);
  await assert.rejects(f.execute('await write("receipt.txt","pending"); return await read(Array(17).fill("small.png"));'), /17 images.*1156 bytes.*16.*20 MiB/s);
  await assert.rejects(fs.stat(path.join(f.root, "receipt.txt")), {code:"ENOENT"});
  // Valid 4 MiB PNG: insert a checksummed ancillary text chunk before IEND.
  const padding = Buffer.alloc(4 * 1024 * 1024 - pixel.length,32);
  padding.writeUInt32BE(padding.length-12); padding.write("tEXt",4); padding.write("Comment\0",8);
  padding.writeUInt32BE(0x01de4622,padding.length-4);
  await f.write("large.png", Buffer.concat([pixel.subarray(0,-12),padding,pixel.subarray(-12)]));
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
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => { delays.push(delay);

 return schedule(fn, delay, ...args); });
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
    {type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="},
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

it("unknown read options fail loudly instead of silently reading the whole file", async t => {
  const f = await engineFixture(t);
  await f.write("notes.txt","one\ntwo\nthree\n");
  // Real-session shape: the caller reused another tool's {start,end} window on nova.
  const error = await f.execute('return await read("notes.txt", { start: 2, end: 3 });').then(() => assert.fail("unknown read options must reject"), reason => reason);
  assert.match(error.message,/read does not accept option "start"/);
  assert.match(error.message,/offset:1, limit:80/);
  // Supported window forms still return exactly the requested lines.
  assert.equal((await f.execute('return await read("notes.txt", { offset: 2, limit: 1 });')).details.result,"two\n");
  assert.equal((await f.execute('return await read("notes.txt", 3, 1);')).details.result,"three\n");
});

it("edit accepts a path plus an options object and keeps literal replacements exact", async t => {
  const f = await engineFixture(t);
  await f.write("pair.js","alpha\nbeta\ngamma\n");
  await f.execute('return await edit("pair.js", {edits:[{oldText:"alpha",newText:"ALPHA"},{oldText:"gamma",newText:"GAMMA"}]});');
  await f.execute('return await edit("pair.js", {oldText:"beta",newText:"BETA"});');
  assert.equal(await fs.readFile(path.join(f.root,"pair.js"),"utf8"),"ALPHA\nBETA\nGAMMA\n");
  await assert.rejects(f.execute('return await edit("pair.js", {path:"other.js",oldText:"ALPHA",newText:"x"});'), /invalid edit signature/);
  await f.write("crlf.txt","one\r\ntwo\r\n");
  const literal = await f.tool.execute("edit-object-literal",{code:'return await edit("crlf.txt", data.edit);',data:{edit:{oldText:"one\r\n",newText:"ONE\r\n"}},timeoutMs:2000},undefined,undefined,{cwd:f.root});
  assert.match(String(literal.details.result),/edited/);
  assert.equal(await fs.readFile(path.join(f.root,"crlf.txt"),"utf8"),"ONE\r\ntwo\r\n");
});

it("edit misses report the closest exact bytes instead of only the file head", async t => {
  const f = await engineFixture(t);
  await f.write("deep.js","const a = 1;\n".repeat(40) + "\tif (ready) {\n\t\treturn top();\n\t}\n");
  await assert.rejects(f.tool.execute("edit-miss",{code:'return await edit("deep.js", data.oldText, data.newText);',data:{oldText:"    if (ready) {\n        return top();\n    }",newText:"    if (ready) {\n        return bottom();\n    }"},timeoutMs:2000},undefined,undefined,{cwd:f.root}), error => {
    assert.match(error.message,/edit target not found/);
    assert.match(error.message,/line 41/);
    assert.ok(error.message.includes("\tif (ready) {"),error.message);

    return true;
  });
  await assert.rejects(f.execute('return await edit("deep.js","no such text anywhere","x");'),/lines total/);
});

it("syntax errors show the offending source line and column", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.execute('return "unterminated'), error => {
    assert.match(error.message,/JavaScript syntax error/);
    assert.ok(error.message.includes('return "unterminated'),error.message);
    assert.match(error.message,/\n\s+\^/);

    return true;
  });
});

it("long syntax diagnostics show the failing token rather than the line prefix", async t => {
  const f = await engineFixture(t);

  const check = (error, token) => {
    const lines = error.message.split("\n");
    const caret = lines.findIndex(line=>line.trim() === "^");
    const shown = lines[caret-1];
    assert.ok(shown?.includes("…"), "clipped context must disclose its horizontal window");
    assert.ok(shown.includes(token), "offending token must be visible in the source excerpt");
    assert.equal(shown[lines[caret].indexOf("^")], token[0]);
    assert.ok(shown.length <= 164, "diagnostics remain bounded");

    return true;
  };

  await t.test("JavaScript", async()=>{
    await assert.rejects(f.execute("/*"+"x".repeat(4000)+"*/ return (1 + );"),error=>check(error,");"));
  });
  await t.test("JSON", async()=>{
    await f.write("wide-invalid.json", '["'+"x".repeat(4000)+'",BAD]');
    await assert.rejects(f.execute('return await read({path:"wide-invalid.json",json:true});'),error=>check(error,"BAD"));
  });
});

it("timeout failures report elapsed time against the program limit", async t => {
  const f = await engineFixture(t);
  await assert.rejects(f.tool.execute("slow",{code:"await new Promise(()=>{});",timeoutMs:1200},undefined,undefined,{cwd:f.root}), error => {
    assert.match(error.message,/supernova timed out:/);
    assert.match(error.message,/ran \d+ms of 1200ms/);

    return true;
  });
});

it("path errors name the path, not the caller, and explain unusable parents", async t => {
  const f = await engineFixture(t);
  await f.write("afile","x");
  await fs.mkdir(path.join(f.root,"adir"));
  await assert.rejects(f.execute('return await write("adir","x");'), error => {
    assert.match(error.message,/path is a directory, not a file/);
    assert.doesNotMatch(error.message,/read path is a directory/);

    return true;
  });
  await assert.rejects(f.execute('return await edit("adir","a","b");'), /path is a directory, not a file/);

  for (const code of ['read("afile/child.txt")','read("afile/child.txt",1,1)','edit("afile/child.txt","a","b")','write("afile/child.txt","x")']) {
    await assert.rejects(f.execute('return await '+code+';'), /a parent component .* is a file, not a directory/);
  }
});

it("non-UTF-8 files fail closed on read, window, edit and append without touching bytes", async t => {
  const f = await engineFixture(t);
  const latin1 = Buffer.from("caf\xe9 na\xefve\n","latin1");
  await fs.writeFile(path.join(f.root,"latin1.txt"),latin1);
  await assert.rejects(f.execute('return await read("latin1.txt",{complete:true});'), /not valid UTF-8/);
  await assert.rejects(f.execute('return await read("latin1.txt",1,1);'), /not valid UTF-8/);
  await assert.rejects(f.execute('return await edit("latin1.txt","caf","COF");'), /not valid UTF-8/);
  await assert.rejects(f.execute('return await write({path:"latin1.txt",content:"more",append:true});'), /not valid UTF-8/);
  assert.equal((await fs.readFile(path.join(f.root,"latin1.txt"))).toString("hex"),latin1.toString("hex"));
  const replaced = await f.execute('return await write({path:"latin1.txt",content:"plain\\n",replace:true});');
  assert.match(String(replaced.details.result),/wrote latin1\.txt/);
  assert.equal(await fs.readFile(path.join(f.root,"latin1.txt"),"utf8"),"plain\n");
});

it("failing window reads do not leak unhandled rejections", async t => {
  const f = await engineFixture(t);
  await fs.writeFile(path.join(f.root,"latin1.txt"),Buffer.from("caf\xe9\n","latin1"));
  const leaks = [];
  const onLeak = (reason) => leaks.push(reason);

  process.on("unhandledRejection",onLeak);

  try {
    await assert.rejects(f.execute('return await read("latin1.txt",1,1);'), /not valid UTF-8/);
    await assert.rejects(f.execute('return await read("latin1.txt",{complete:true});'), /not valid UTF-8/);
    await new Promise(resolve => setTimeout(resolve,50));
  } finally { process.off("unhandledRejection",onLeak); }

  assert.deepEqual(leaks.map(reason => String(reason?.message ?? reason).slice(0,40)),[]);
});

it("filesystem permission failures name the path or command with guidance", async t => {
  const f = await engineFixture(t);
  const windows = process.platform === "win32";
  const principal = windows ? (await runCommand([path.join(process.env.SystemRoot,"System32","whoami.exe")],{cwd:f.root})).stdout.trim() : null;

  const deny = async (name, rights, mode, restoredMode) => {
    const target = path.join(f.root,name);

    const change = async args => {
      const result = await runCommand(["icacls.exe",target,...args],{cwd:f.root});
      assert.equal(result.exitCode,0,result.stdout+result.stderr);
    };

    const restore = windows ? ()=>change(["/remove:d",principal]) : ()=>fs.chmod(target,restoredMode);
    t.after(restore);

    if (windows) await change(["/deny",`${principal}:(${rights})`]);
    else await fs.chmod(target,mode);

    return restore;
  };

  await f.write("locked.txt","secret\n");
  const restoreRead = await deny("locked.txt","R",0o000,0o644);
  await assert.rejects(f.execute('return await read("locked.txt",{complete:true});'), error => {
    assert.match(error.message,/permission denied reading/);
    assert.match(error.message,/locked\.txt/);
    assert.doesNotMatch(error.message,/EACCES:/);

    return true;
  });
  await assert.rejects(f.execute('return await edit("locked.txt","secret","x");'), /permission denied reading/);
  await restoreRead();
  const executable = windows ? "noexec.exe" : "noexec.sh";

  if (windows) await fs.copyFile(path.join(process.env.SystemRoot,"System32","whoami.exe"),path.join(f.root,executable));
  else await f.write(executable,"#!/bin/sh\necho hi\n");
  const restoreExec = await deny(executable,"X",0o644,0o755);

  for (const background of [false,true]) {
    await assert.rejects(f.execute(`return await bash({command:${JSON.stringify('./'+executable)},args:[],background:${background}});`), error => {
      assert.ok(error.message.includes("cannot execute ./"+executable),error.message);
      assert.doesNotMatch(error.message,/spawn .*(EACCES|EPERM)/);

      return true;
    });
  }

  assert.deepEqual((await f.execute('return await bash({action:"list"});')).details.result,[]);
  await restoreExec();
  await fs.mkdir(path.join(f.root,"ro-dir"));
  // An existing readable target isolates write denial. Windows can reject the
  // initial open of a missing child under a deny-create ACL as a read denial.
  await f.write("ro-dir/new.txt","original");
  const restoreDir = await deny("ro-dir","W",0o555,0o755);
  await assert.rejects(f.execute('return await write("ro-dir/new.txt","x");'), error => {
    assert.match(error.message,/permission denied writing/);
    assert.match(error.message,/ro-dir/);
    assert.doesNotMatch(error.message,/\.supernova-/);

    return true;
  });
  assert.equal(await fs.readFile(path.join(f.root,"ro-dir/new.txt"),"utf8"),"original");
  await restoreDir();
});

it("bash cwd must be a directory and never leaks spawn codes", async t => {
  const f = await engineFixture(t);
  await f.write("afile.txt","x\n");
  await fs.mkdir(path.join(f.root,"adir"));
  await assert.rejects(f.execute('return await bash({command:"pwd",cwd:"afile.txt"});'), error => {
    assert.match(error.message,/bash cwd is not a directory: afile\.txt/);
    assert.doesNotMatch(error.message,/spawn ENOTDIR/);

    return true;
  });
  await assert.rejects(f.execute('return await bash({command:"pwd",cwd:"missing-dir"});'), /bash cwd is not a directory: missing-dir/);
  const ok = await f.execute('return await bash({command:"pwd",cwd:"adir"});');
  assert.ok(String(ok.details.result).trim().endsWith("adir"));
});

it("bash, write and edit reject unknown options instead of ignoring them", async t => {
  const f = await engineFixture(t);
  await f.write("note.txt","one\n");
  await assert.rejects(f.execute('return await write({path:"m.txt",content:"x",mode:493});'), /write does not accept option "mode"/);
  await assert.rejects(f.execute('return await bash({command:"true",env:{A:"1"}});'), /bash does not accept option "env"/);
  await assert.rejects(f.execute('return await bash({command:"true",maxOutputChars:64});'), /bash does not accept option "maxOutputChars"/);
  await assert.rejects(f.execute('return await edit("note.txt",{oldText:"one",newText:"1",all:true});'), /edit does not accept option "all"/);
  // Supported options keep working.
  await f.execute('return await write({path:"m.txt",content:"x"});');
  assert.equal(await fs.readFile(path.join(f.root,"m.txt"),"utf8"),"x");
  const shell = await f.execute('return await bash({command:"printf",args:["ok"]});');
  assert.equal(shell.details.result,"ok");
  await f.execute('return await edit("note.txt",{oldText:"one",newText:"1"});');
  assert.equal(await fs.readFile(path.join(f.root,"note.txt"),"utf8"),"1\n");
});

it("multi-edit failures name the failing entry", async t => {
  const f = await engineFixture(t);
  await f.write("multi.txt","one\ntwo\nthree\n");
  await assert.rejects(f.execute('return await edit("multi.txt", {edits:[{oldText:"one",newText:"ONE"},{oldText:"missing",newText:"x"}]});'), /edit 2 of 2: .*edit target not found/s);
  assert.equal(await fs.readFile(path.join(f.root,"multi.txt"),"utf8"),"one\ntwo\nthree\n");
});

it("JSON projection localizes the parse failure and ignores one leading BOM", async t => {
  const f = await engineFixture(t);
  await f.write("bad.json",'{\n  "a": 1,\n  "b": ,\n}\n');
  await assert.rejects(f.execute('return await read({path:"bad.json",json:".a"});'), error => {
    assert.match(error.message,/invalid JSON in bad\.json/);
    // V8 reports only a snippet for some failures; those still name the tokens.
    assert.ok(error.message.includes('"b": ,'),error.message);

    return true;
  });
  await f.write("trail.json",'{"a":1,}');
  await assert.rejects(f.execute('return await read({path:"trail.json",json:".a"});'), error => {
    assert.match(error.message,/line 1 column 8/);
    assert.ok(error.message.includes('{"a":1,}'),error.message);
    assert.match(error.message,/\^/);

    return true;
  });
  await f.write("bom.json","\uFEFF" + JSON.stringify({ok:true,padding:"x".repeat(40)}));
  assert.equal((await f.execute('return await read({path:"bom.json",json:".ok"});')).details.result,true);
});

it("program files name the file in syntax and encoding failures", async t => {
  const f = await engineFixture(t);
  await f.write("broken.js",'await write("never.txt","bad"); )');
  await assert.rejects(f.tool.execute("file-syntax",{file:"broken.js"},undefined,undefined,{cwd:f.root}), error => {
    assert.match(error.message,/JavaScript syntax error in broken\.js/);
    assert.match(error.message,/Fix broken\.js and re-run/);
    assert.ok(error.message.includes('await write("never.txt","bad"); )'),error.message);

    return true;
  });
  await fs.writeFile(path.join(f.root,"bytes.js"),Buffer.concat([Buffer.from('await write("never.txt","bad");'),Buffer.from([255])]));
  await assert.rejects(f.tool.execute("file-bytes",{file:"bytes.js"},undefined,undefined,{cwd:f.root}),/bytes\.js is not valid UTF-8/);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")),{code:"ENOENT"});
});

it("batch deadlines report elapsed time against the limit", async t => {
  const f = await engineFixture(t);
  const started = Date.now();
  const result = await f.tool.execute("batch-deadline",{programs:[{code:'await new Promise(()=>{});'},{code:"return 2;"}],timeoutMs:900},undefined,undefined,{cwd:f.root});
  assert.equal(result.details.ok,false);
  assert.match(result.details.error,/deadline or cancellation/);
  assert.match(result.details.error,/ran \d+ms of 900ms/);
  assert.ok(Date.now() - started < 15000);
});

it("write checks accept a BOM-prefixed JSON document as valid", async t => {
  const f = await engineFixture(t);
  const receipt = await f.tool.execute("write-bom",{code:'return await write("bom-report.json", data.content);',data:{content:"\uFEFF{\"ok\":true}"},timeoutMs:2000},undefined,undefined,{cwd:f.root});
  assert.doesNotMatch(String(receipt.details.result),/check:/);
});

it("JSON context recovers failing tokens without native offsets or a second value tree", () => {
  const marked = [
    '{\n  "a": 1,\n  "b": |,\n}', '{"a":1,|}', '[1,|]', '{"a" |1}',
    '{"a":1 |"b":2}', '[1 |2]', '{"a":1}|false', '[|,1]',
    '{"a":[true,null,{"b":|}]}', '{"a":0|1}', '{"a":1|e}',
    '{"a":|-.2}', '{"a":|undefined}', '{"a":|NaN}',
    '{"a":|"bad\\x20"}', '\n |',
  ];

  for (const input of marked) {
    const offset = input.indexOf("|");
    const source = input.replace("|", "");
    assert.throws(() => JSON.parse(source), SyntaxError, source);
    const before = source.slice(0, offset).split("\n");
    const position = " (near line " + before.length + " column " + (before.at(-1).length + 1) + ")";
    const context = jsonErrorContext("JSON Parse error", source);
    assert.ok(context.startsWith(position), source + context);
    assert.ok(context.endsWith("^"), context);
  }

  const values = [null, true, false, 0, -1, 1.2, 1e27, [], {}, [1, "comma,]}", null],
    {quote:'"', escape:"\\", emoji:"😀", control:"\u0000", nested:{items:[false]}}];

  for (const value of values) assert.equal(jsonErrorContext("no offset", "\n" + JSON.stringify(value, null, 2)), "");
  assert.equal(jsonErrorContext("no offset", " ".repeat(64 * 1024) + "?"), "", "diagnostic fallback must remain bounded");
});

it("native JSON locations use zero-based caret columns", () => {
  const source = '{"a":1,}';

  for (const message of ["invalid JSON (line 1 column 8)", "invalid JSON at position 7"]) {
    assert.deepEqual(parsePosition(message, source), {line:1, column:7});
    assert.equal(jsonErrorContext(message, source), '\n  {"a":1,}\n         ^');
  }
});

it("guest failures identify the actual source await without moving direct throws", async t => {
  const f = await engineFixture(t);

  const cases = [
    ['const x = 1;\nreturn await bash("exit 4");', 2, 8],
    ['await Promise.resolve(); await bash("exit 4");', 1, 26],
    ['await (async () => {\n  await bash("exit 4");\n})();', 2, 3],
    ['async () => {\n  await bash("exit 4");\n}', 2, 3],
  ];

  for (const [code, line, column] of cases) {
    await assert.rejects(f.execute(code), error => {
      assert.match(error.message, /command failed \(exit 4\)/);
      assert.ok(error.message.includes("(line " + line + ":" + column + ")"), error.message);

      return true;
    });
  }

  await assert.rejects(f.execute('await (async () => {\n  throw Error("direct-throw");\n})();'), /direct-throw \(line 2:\d+\)/);
});
