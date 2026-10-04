import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText, limits } from "../helpers/engine.mjs";

async function rejection(execute) {
  try {
    await execute;
    assert.fail("program must reject");
  } catch (error) {
    if (error.message === "program must reject") throw error;

    return error.message;
  }
}

function listed(dir) {
  return fs.readdir(dir).then(names => names.filter(name => name !== ".DS_Store").sort());
}

it("literal argv is owned spawn: host bash is never called and shell metacharacters stay literal", async t => {
  const f = await engineFixture(t);
  let hostCalls = 0;
  f.pi.registerTool({ name: "bash", async execute() {
    hostCalls++;

    return { content: [{ type: "text", text: "HOST-BASH" }] };
  } });
  const literal = "$(echo pwned); $HOME; `id`; a b";
  const result = await f.execute("return await bash({command:process.execPath,args:[\"-e\",\"process.stdout.write(process.argv[1])\"," + JSON.stringify(literal) + "]});");
  assert.equal(hostCalls, 0, "argv must not delegate to a host bash that ignores args");
  assert.equal(result.details.result, literal);
  assert.equal(result.details.ok, true);
  const joined = await f.execute("return await bash({command:process.execPath,args:[\"-e\",\"process.stdout.write(process.argv.slice(1).join('-'))\",\"left\",\"right\"]});");
  assert.equal(joined.details.result, "left-right");
  assert.equal(hostCalls, 0);
});

it("argv rejects malformed args before any process starts", async t => {
  const f = await engineFixture(t);
  const text = await rejection(f.execute("return await bash({command:\"printf\",args:\"%s\"});"));
  assert.match(text, /bash argv requires a command string and an array of string args/);
  assert.doesNotMatch(text, /external calls attempted/);
  const sparse = await rejection(f.execute("return await bash({command:\"printf\",args:Array(2)});"));
  assert.match(sparse, /bash argv requires a command string and an array of string args/);
  assert.doesNotMatch(sparse, /command failed|external calls attempted/);
});

it("write, edit, read and bash cwd reject URI paths and never create scheme directories", async t => {
  const f = await engineFixture(t);
  const uris = ["local://notes.md", "local:/notes.md", "file://notes.md", "file:/notes.md", "http://example.test/a", "https://example.test/a", "s3://bucket/key", "git://host/repo"];

  for (const target of uris) {
    const writeMsg = await rejection(f.execute("await write(" + JSON.stringify(target) + ",\"payload\");"));
    assert.match(writeMsg, /write does not accept [A-Za-z][A-Za-z0-9+.-]*: URI paths; use a workspace filesystem path/);
    const editMsg = await rejection(f.execute("await edit(" + JSON.stringify(target) + ",\"a\",\"b\");"));
    assert.match(editMsg, /edit does not accept [A-Za-z][A-Za-z0-9+.-]*: URI paths; use a workspace filesystem path/);
  }

  const readMsg = await rejection(f.execute("return await read(\"s3://bucket/key\");"));
  assert.match(readMsg, /read does not accept s3: URI paths; use a workspace filesystem path/);
  const cwdMsg = await rejection(f.execute("return await bash({command:\"pwd\",cwd:\"http://example.test/tmp\"});"));
  assert.match(cwdMsg, /bash cwd does not accept http: URI paths; use a workspace filesystem path/);
  const objectWrite = await rejection(f.execute("await write({path:\"local://x.md\",content:\"x\"});"));
  assert.match(objectWrite, /write does not accept local: URI paths; use a workspace filesystem path/);
  assert.deepEqual(await listed(f.root), []);
  await f.execute('await write("notes.md","ok");');
  assert.equal(await fs.readFile(path.join(f.root, "notes.md"), "utf8"), "ok");
  assert.deepEqual(await listed(f.root), ["notes.md"]);
});

it("directory reads return typed entries to programs and text to hosts", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "assets", "sub"), { recursive: true });
  await f.write("assets/a.txt", "x");
  const result = await f.execute('return await read("assets");');
  assert.deepEqual([...result.details.result].sort(), ["a.txt (file, 1 bytes)", "sub/ (dir)"]);
  assert.equal(result.details.ok, true);
  const resolved = await f.execute('return await read({path:"assets",resolve:true});');
  assert.deepEqual([...resolved.details.result].sort(), ["a.txt (file, 1 bytes)", "sub/ (dir)"]);
  const batch = await f.execute('return await read(["assets","assets/a.txt"],{resolve:true});');
  assert.deepEqual([...batch.details.result[0]].sort(), ["a.txt (file, 1 bytes)", "sub/ (dir)"]);
  assert.equal(batch.details.result[1].status, "found");
  assert.equal(batch.details.result[1].text, "x");
  const mixed = await f.execute('return await read(["assets","assets/a.txt"]);');
  assert.deepEqual([...mixed.details.result[0]].sort(), ["a.txt (file, 1 bytes)", "sub/ (dir)"]);
  assert.equal(mixed.details.result[1], "x");
  const targetBatch = await f.execute('return await read({target:["assets/a.txt"]});');
  assert.equal(targetBatch.details.result[0], "x");
});

it("explicit line windows stay bounded when the start line is beyond a read chunk", async t => {
  const f = await engineFixture(t);
  await f.write("wide.txt", "x".repeat(100000) + "\r\nTARGET\r\n" + "tail".repeat(10000));
  const result = await f.execute('return await read({path:"wide.txt", offset:2, limit:1});');
  assert.equal(result.details.result, "TARGET\r\n");
});

it("session resource writes stay read-only and do not look like generic URI rejection", async t => {
  const f = await engineFixture(t);
  const text = await rejection(f.execute('await write("agent://ResearchDigest","bad");'));
  assert.match(text, /write requires a filesystem path; session resource URIs are read-only/);
  assert.doesNotMatch(text, /does not accept agent: URI/);
  assert.deepEqual(await listed(f.root), []);
});

it("a missing JSON field isolates siblings, lists exact keys, and does not invent fields", async t => {
  const f = await engineFixture(t);
  await f.write("plots.json", JSON.stringify({ pitch: 1, amplitude: 2 }));
  await f.write("ok.json", JSON.stringify({ method: "acf", pitch: 3 }));
  await f.write("empty.json", "{}");

  const settled = await f.execute(`
    return (await Promise.allSettled([
      read({path:"plots.json",json:".method"}),
      read({path:"ok.json",json:".method"}),
      read({path:"empty.json",json:".method"}),
    ])).map(entry => entry.status === "fulfilled"
      ? {status:entry.status,value:entry.value}
      : {status:entry.status,error:String(entry.reason?.message ?? entry.reason)});
  `);

  assert.deepEqual(settled.details.result, [
    { status: "rejected", error: "JSON selection failed for plots.json (.method): JSON field not found: \"method\"; available keys: \"pitch\", \"amplitude\"; for optional fields, select the parent object (json:true for the root) and apply ?? defaults in guest code" },
    { status: "fulfilled", value: "acf" },
    { status: "rejected", error: "JSON selection failed for empty.json (.method): JSON field not found: \"method\"; for optional fields, select the parent object (json:true for the root) and apply ?? defaults in guest code" },
  ]);
  const all = await rejection(f.execute('return await Promise.all([read({path:"plots.json",json:".method"}),read({path:"ok.json",json:".method"})]);'));
  assert.ok(all.includes('JSON selection failed for plots.json (.method): JSON field not found: "method"; available keys: "pitch", "amplitude"'));
  assert.doesNotMatch(all, /"acf"/);
});

it("a JSON miss in an explicit checkpoint rolls edits back; a settled miss does not", async t => {
  const f = await engineFixture(t);
  await f.write("doc.md", "keep\n");
  await f.write("meta.json", JSON.stringify({ title: "ok" }));
  const thrown = await rejection(f.execute('return await edit(async()=>{await edit("doc.md","keep","gone"); return await read({path:"meta.json",json:".schema"});});'));
  assert.ok(thrown.includes('JSON selection failed for meta.json (.schema): JSON field not found: "schema"; available keys: "title"'));
  assert.equal(await fs.readFile(path.join(f.root, "doc.md"), "utf8"), "keep\n");

  const settled = await f.execute(`
    await edit("doc.md","keep","gone");
    const miss = await Promise.allSettled([read({path:"meta.json",json:".schema"})]);
    return {status:miss[0].status,error:String(miss[0].reason?.message ?? miss[0].reason)};
  `);

  assert.equal(settled.details.ok, true);
  assert.equal(settled.details.result.status, "rejected");
  assert.equal(settled.details.result.error, "JSON selection failed for meta.json (.schema): JSON field not found: \"schema\"; available keys: \"title\"; for optional fields, select the parent object (json:true for the root) and apply ?? defaults in guest code");
  assert.equal(await fs.readFile(path.join(f.root, "doc.md"), "utf8"), "gone\n");
});

it("oversized multi-file returns keep every sentinel in its own framed slot", async t => {
  const f = await engineFixture(t);
  const names = ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt", "six.txt"];
  const sentinels = ["SENTINEL_ONE", "SENTINEL_TWO", "SENTINEL_THREE", "SENTINEL_FOUR", "SENTINEL_FIVE", "SENTINEL_SIX"];

  for (let i = 0; i < names.length; i++) await f.write(names[i], sentinels[i] + "\n" + "x".repeat(7000) + "\n");
  const result = await f.execute("return await read(" + JSON.stringify(names) + ");");
  const text = modelText(result);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.returnTruncated, true);
  assert.ok(text.length <= 32000, text.length);
  assert.match(text, /^ok #\d+ \d+ms \[return truncated\]\nstrings\[6\]\n/);

  for (let i = 0; i < names.length; i++) {
    assert.match(text, new RegExp("\\[" + i + "\\] \\d+ UTF-16 units\\n" + sentinels[i]));
  }
});

it("sixteen returned images stay attached; overflow fails without undoing saved writes", async t => {
  const f = await engineFixture(t);
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  await f.write("pixel.png", pixel);

  const atCap = await f.execute(`
    await write("ledger.md", "kept-16");
    return await Promise.all(Array.from({length:16}, () => read("pixel.png")));
  `);

  assert.equal(atCap.details.ok, true);
  assert.equal(atCap.content.filter(block => block.type === "image").length, 16);
  assert.doesNotMatch(modelText(atCap), /image omitted/);
  assert.equal(await fs.readFile(path.join(f.root, "ledger.md"), "utf8"), "kept-16");
  await assert.rejects(f.execute(`
    await write("ledger.md", "kept-17");
    return await Promise.all(Array.from({length:17}, () => read("pixel.png")));
  `), error => {
    const overflow = error.supernovaResult;
    assert.equal(overflow.details.ok, false);
    assert.equal(overflow.details.mutations.committed, 1);
    assert.equal(overflow.details.mutations.rolledBack, 0);
    assert.equal(overflow.content.filter(block => block.type === "image").length, 0);
    assert.match(error.message, /17 images.*20 MiB/);

    return true;
  });
  assert.equal(await fs.readFile(path.join(f.root, "ledger.md"), "utf8"), "kept-17");
});

it("JavaScript syntax errors run no commands and name the data parameter", async t => {
  const f = await engineFixture(t);
  const text = await rejection(f.execute('await write("never.py", """old""");'));
  assert.match(text, /JavaScript syntax error:/);
  assert.match(text, /no commands ran/);
  assert.match(text, /data parameter/);
  await assert.rejects(fs.stat(path.join(f.root, "never.py")), { code: "ENOENT" });
  assert.deepEqual(await listed(f.root), []);
});

it("an unmatched edit keeps the file and includes a numbered window of the actual source", async t => {
  const f = await engineFixture(t);
  const original = "alpha\nbeta-SENTINEL\ngamma\n";
  await f.write("note.txt", original);
  const text = await rejection(f.execute('return await edit("note.txt","MISSING_OLD_TEXT_SENTINEL","x");'));
  assert.match(text, /edit target not found in /);
  assert.match(text, /    1 alpha\n    2 beta-SENTINEL\n    3 gamma\n3 lines/);
  assert.doesNotMatch(text, /MISSING_OLD_TEXT_SENTINEL/);
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), original);
  const lines = Array.from({ length: 40 }, (_, i) => "row-" + (i + 1));
  lines[39] = "TAIL-SENTINEL";
  await f.write("wide.txt", lines.join("\n") + "\n");
  const wide = await rejection(f.execute('return await edit("wide.txt","MISSING_OLD_TEXT_SENTINEL","x");'));
  assert.match(wide, /    1 row-1\n    2 row-2/);
  assert.match(wide, /   16 row-16\n40 lines total/);
  assert.doesNotMatch(wide, /TAIL-SENTINEL|row-17/);
});

it("a non-unique edit names both match lines and does not dump the rest of the file", async t => {
  const f = await engineFixture(t);
  const original = "keep-A\ndup-SENTINEL\nkeep-B\ndup-SENTINEL\nkeep-C\n";
  await f.write("note.txt", original);
  const text = await rejection(f.execute('return await edit("note.txt","dup-SENTINEL","x");'));
  assert.match(text, /edit target is not unique in /);
  assert.match(text, /lines 2 and 4/);
  assert.match(text, /    2 dup-SENTINEL\n    4 dup-SENTINEL/);
  assert.doesNotMatch(text, /keep-A|keep-B|keep-C/);
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), original);
});

it("a program that mutates without returning still delivers the write and edit receipts", async t => {
  const f = await engineFixture(t);
  await f.write("note.txt", "alpha-SENTINEL\n");
  const edited = await f.execute('await edit("note.txt","alpha-SENTINEL","beta-SENTINEL");');
  const editedText = modelText(edited);
  assert.equal(edited.details.ok, true);
  assert.match(editedText, /edited note\.txt:1-/);
  assert.match(editedText, /beta-SENTINEL/);
  assert.doesNotMatch(editedText, /no return statement/);
  assert.doesNotMatch(editedText, /\bundefined\b/);
  assert.equal(await fs.readFile(path.join(f.root, "note.txt"), "utf8"), "beta-SENTINEL\n");

  const written = await f.execute('await write("fresh.txt","payload-SENTINEL");');
  const writtenText = modelText(written);
  assert.match(writtenText, /wrote /);
  assert.match(writtenText, /fresh\.txt/);
  assert.doesNotMatch(writtenText, /payload-SENTINEL/);
  assert.doesNotMatch(writtenText, /no return statement/);
  assert.equal(await fs.readFile(path.join(f.root, "fresh.txt"), "utf8"), "payload-SENTINEL");

  await f.write("left.txt", "LEFT-OLD\n");
  await f.write("right.txt", "RIGHT-OLD\n");
  const both = await f.execute('await edit("left.txt","LEFT-OLD","LEFT-NEW"); await edit("right.txt","RIGHT-OLD","RIGHT-NEW");');
  const bothText = modelText(both);
  assert.match(bothText, /LEFT-NEW/);
  assert.match(bothText, /RIGHT-NEW/);

  const returned = await f.execute('return await edit("note.txt","beta-SENTINEL","gamma-SENTINEL");');
  const returnedText = modelText(returned);
  assert.equal((returnedText.match(/edited note\.txt:/g) || []).length, 1);
  assert.match(returnedText, /gamma-SENTINEL/);

  const silentRead = await f.execute('await read("note.txt");');
  const silentText = modelText(silentRead);
  assert.match(silentText, /no return statement/);
  assert.doesNotMatch(silentText, /gamma-SENTINEL/);
});

it("a 40-edit program applies every match but receipts only the first 32", async t => {
  const f = await engineFixture(t);
  const body = Array.from({ length: 40 }, (_, i) => `key-${i}=0`).join("\n") + "\n";
  await f.write("many.txt", body);
  const edits = Array.from({ length: 40 }, (_, i) => ({ oldText: `key-${i}=0`, newText: `key-${i}=1` }));
  const out = await f.execute(`return await edit({path:"many.txt", edits:${JSON.stringify(edits)}});`);
  assert.match(out.details.result, /…8 more matches \(receipt shows the first 32\)/);
  const after = await fs.readFile(path.join(f.root, "many.txt"), "utf8");
  assert.equal(after, body.replaceAll("=0", "=1"));
});


it("oversized named and record read batches retain every file preview", async t => {
  const f = await engineFixture(t);
  const names = Array.from({length:7}, (_, index) => "document-" + index + ".md");

  for (const [index, name] of names.entries()) await f.write(name, "DOCUMENT_" + index + "\n" + "line of source 🦀\n".repeat(5000));

  for (const body of [
    'return Object.fromEntries(await Promise.all(data.map(async path=>[path,await read(path)])));',
    'return await Promise.all(data.map(async path=>({text:await read(path),path})));',
  ]) {
    const result = await f.tool.execute("read-preview", {code:body,data:names}, undefined, undefined, {cwd:f.root});
    const text = modelText(result);

    assert.equal(result.details.ok, true);
    assert.equal(result.details.returnTruncated, true);
    assert.ok(text.length <= 32000);
    assert.equal(text.isWellFormed(), true);

    for (const [index, name] of names.entries()) {
      assert.ok(text.includes(name), "missing file label " + name);
      assert.ok(text.includes("DOCUMENT_" + index), "missing file preview " + name);
    }

    assert.match(text, /UTF-16 units/);
    assert.match(text, /truncated/);
  }

  const lengths = await f.tool.execute("read-lengths", {
    code:'return await Promise.all(data.map(async path=>(await read(path)).length));', data:names,
  }, undefined, undefined, {cwd:f.root});

  assert.deepEqual(lengths.details.result, names.map((_, index) => ("DOCUMENT_" + index + "\n" + "line of source 🦀\n".repeat(5000)).length));
});

it("error output escapes lone surrogate code units before budgeting without damaging valid Unicode", async t => {
  const f = await engineFixture(t);

  for (const [message,visible] of [["bad\ud800tail", "bad\\ud800tail"], ["bad\udfff\nnext", "bad\\udfff\nnext"], ["normal 😀 error", "normal 😀 error"]]) {
    await assert.rejects(f.tool.execute("unicode-error", {code:'throw new Error(data);',data:message}, undefined, undefined, {cwd:f.root}), error => {
      const text = error.supernovaResult.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      assert.ok(text.isWellFormed());
      const [headline, ...lines] = visible.split("\n");
      assert.ok(text.includes(headline));

      for (const line of lines) assert.ok(text.includes("\n" + line));

      return true;
    });
  }

  await assert.rejects(f.execute('throw new Error("\\ud800".repeat(10000));'), error => {
    const text = error.supernovaResult.content[0].text;
    assert.ok(text.isWellFormed());
    assert.ok(text.length <= limits.maxReturnChars);
    assert.equal(error.supernovaResult.details.returnTruncated, true);

    return true;
  });
});


it("modern callable tools use the invocation executor and preserve bounded structured data", async t => {
  const f = await engineFixture(t);
  const tool = {name:"read",description:"Read a remote fixture",sourceInfo:{source:"local"},parameters:{type:"object",properties:{}},outputSchema:{type:"object"},exposure:"codemode",annotations:{readOnlyHint:true},async execute(){assert.fail("raw executor bypassed the invocation boundary");}};
  f.pi.registerTool(tool);
  f.pi.getActiveTools = () => ["supernova"];
  const controller = new AbortController();
  const seen = [];

  const ctx = {cwd:f.root,tools:[tool],async executeTool(name,args,options) {
    assert.equal(name,"read");
    assert.equal(options.signal.aborted,false);
    seen.push(args);
    const payload=args.path==="large"?{text:"x".repeat(100000)}:{answer:42};

    return {isError:false,result:{content:[{type:"text",text:"display-only"}],structuredContent:payload,details:{batch:true,items:["ui-only"]}}};
  }};

  // Shorthand queries normally decode JSON; clipped typed replies must not be reparsed.
  const result = await f.tool.execute("modern-data",{code:'const small=await read("small"); const large=await read("large"); return {small,largeType:typeof large,largeLength:large.length,truncated:large.includes("truncated")};'},controller.signal,undefined,ctx);
  assert.deepEqual(result.details.result.small,{answer:42});
  assert.equal(result.details.result.largeType,"string","oversized structured data must be visibly bounded, not silently reshaped");
  assert.equal(result.details.result.truncated,true);
  assert.ok(result.details.result.largeLength<=limits.maxCallResultChars);
  assert.deepEqual(seen.map(args=>args.path),["small","large"]);
  assert.equal(f.tool.exposure,"model-only","an orchestrator must not be recursively callable by native codemode");
});

it("modern invocation outcomes retain failure and cannot fall back to raw or withdrawn tools", async t => {
  const f = await engineFixture(t);
  const tool={name:"read",description:"Read remote",sourceInfo:{source:"local"},parameters:{type:"object",properties:{}},annotations:{readOnlyHint:true},exposure:"direct",async execute(){assert.fail("raw host executor must never run");}};
  f.pi.registerTool(tool);
  f.pi.getActiveTools = () => ["supernova","read"];
  const callable=[tool];

  const ctx={cwd:f.root,get tools(){return callable;},async executeTool(name) {
    assert.equal(name,"read");

    return {isError:true,result:{content:[{type:"text",text:"permission-denied-sentinel"}],details:undefined}};
  }};

  await assert.rejects(f.tool.execute("modern-denied",{code:'return await read({path:"remote"});'},undefined,undefined,ctx),/permission-denied-sentinel/);
  callable.length=0;

  for (const exposure of ["direct","hidden","model-only"]) {
    tool.exposure=exposure;
    await assert.rejects(f.tool.execute("modern-withdrawn",{code:'return await read({path:"remote"});'},undefined,undefined,ctx),/unknown tool "read"/);
  }
});

it("modern host delegation preserves owned filesystem rollback and host overrides", async t => {
  const f=await engineFixture(t);
  const originalGetAll=f.pi.getAllTools;
  const builtin={name:"write",description:"builtin write",parameters:{type:"object",properties:{}},sourceInfo:{source:"builtin"},async execute(){assert.fail("raw builtin must not bypass owned staging");}};
  f.pi.getAllTools=()=>[...originalGetAll(),builtin];
  const ctx={cwd:f.root,tools:[builtin],async executeTool(){assert.fail("owned filesystem writes must not delegate");}};
  await assert.rejects(f.tool.execute("modern-rollback",{code:'await edit(async()=>{await write("rolled-back.txt","staged"); throw Error("reject-owned");});'},undefined,undefined,ctx),/reject-owned/);
  await assert.rejects(fs.stat(path.join(f.root,"rolled-back.txt")),{code:"ENOENT"});

  const override={...builtin,sourceInfo:{source:"local"}};
  f.pi.getAllTools=()=>[...originalGetAll(),override];

  const accepted=await f.tool.execute("modern-override",{code:'return await write("remote.txt","kept");'},undefined,undefined,{cwd:f.root,tools:[override],async executeTool(name,args) {
    assert.equal(name,"write");
    assert.equal(args.content,"kept");

    return {isError:false,result:{content:[{type:"text",text:"host-override-kept"}],details:undefined}};
  }});

  assert.equal(accepted.details.result,"host-override-kept");
  await assert.rejects(fs.stat(path.join(f.root,"remote.txt")),{code:"ENOENT"});
});
