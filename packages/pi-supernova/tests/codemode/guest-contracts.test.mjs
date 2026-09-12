import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";

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

it("literal argv is owned spawn: host bash is never called and shell metacharacters stay literal", { skip: process.platform === "win32" }, async t => {
  const f = await engineFixture(t);
  let hostCalls = 0;
  f.pi.registerTool({ name: "bash", async execute() {
    hostCalls++;

    return { content: [{ type: "text", text: "HOST-BASH" }] };
  } });
  const literal = "$(echo pwned); $HOME; `id`; a b";
  const result = await f.execute("return await bash({command:\"printf\",args:[\"%s\"," + JSON.stringify(literal) + "]});");
  assert.equal(hostCalls, 0, "argv must not delegate to a host bash that ignores args");
  assert.equal(result.details.result, literal);
  assert.equal(result.details.ok, true);
  const joined = await f.execute("return await bash({command:\"printf\",args:[\"%s-%s\",\"left\",\"right\"]});");
  assert.equal(joined.details.result, "left-right");
  assert.equal(hostCalls, 0);
});

it("argv rejects malformed args before any process starts", { skip: process.platform === "win32" }, async t => {
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
    { status: "rejected", error: "JSON field not found: \"method\"; available keys: \"pitch\", \"amplitude\"" },
    { status: "fulfilled", value: "acf" },
    { status: "rejected", error: "JSON field not found: \"method\"" },
  ]);
  const all = await rejection(f.execute('return await Promise.all([read({path:"plots.json",json:".method"}),read({path:"ok.json",json:".method"})]);'));
  assert.match(all, /JSON field not found: "method"; available keys: "pitch", "amplitude"/);
  assert.doesNotMatch(all, /"acf"/);
});

it("a JSON miss after edits rolls the edits back; a settled miss does not", async t => {
  const f = await engineFixture(t);
  await f.write("doc.md", "keep\n");
  await f.write("meta.json", JSON.stringify({ title: "ok" }));
  const thrown = await rejection(f.execute('await edit("doc.md","keep","gone"); return await read({path:"meta.json",json:".schema"});'));
  assert.match(thrown, /JSON field not found: "schema"; available keys: "title"/);
  assert.equal(await fs.readFile(path.join(f.root, "doc.md"), "utf8"), "keep\n");
  const settled = await f.execute(`
    await edit("doc.md","keep","gone");
    const miss = await Promise.allSettled([read({path:"meta.json",json:".schema"})]);
    return {status:miss[0].status,error:String(miss[0].reason?.message ?? miss[0].reason)};
  `);
  assert.equal(settled.details.ok, true);
  assert.equal(settled.details.result.status, "rejected");
  assert.equal(settled.details.result.error, "JSON field not found: \"schema\"; available keys: \"title\"");
  assert.equal(await fs.readFile(path.join(f.root, "doc.md"), "utf8"), "gone\n");
});

it("oversized multi-file returns keep every sentinel in its own framed slot", async t => {
  const f = await engineFixture(t);
  const names = ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt", "six.txt"];
  const sentinels = ["SENTINEL_ONE", "SENTINEL_TWO", "SENTINEL_THREE", "SENTINEL_FOUR", "SENTINEL_FIVE", "SENTINEL_SIX"];

  for (let i = 0; i < names.length; i++) await f.write(names[i], sentinels[i] + "\n" + "x".repeat(12000) + "\n");
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

it("sixteen returned images stay attached; the seventeenth is omitted without rolling back writes", async t => {
  const f = await engineFixture(t);
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzkAAAAASUVORK5CYII=", "base64");
  await f.write("pixel.png", pixel);
  const atCap = await f.execute(`
    await write("ledger.md", "kept-16");
    return await Promise.all(Array.from({length:16}, () => read("pixel.png")));
  `);
  assert.equal(atCap.details.ok, true);
  assert.equal(atCap.content.filter(block => block.type === "image").length, 16);
  assert.doesNotMatch(modelText(atCap), /image omitted/);
  assert.equal(await fs.readFile(path.join(f.root, "ledger.md"), "utf8"), "kept-16");
  const overflow = await f.execute(`
    await write("ledger.md", "kept-17");
    return await Promise.all(Array.from({length:17}, () => read("pixel.png")));
  `);
  assert.equal(overflow.details.ok, true);
  assert.equal(overflow.details.mutations.committed, 1);
  assert.equal(overflow.details.mutations.rolledBack, 0);
  assert.equal(overflow.content.filter(block => block.type === "image").length, 16);
  assert.match(modelText(overflow), /\[image omitted: exceeds 16 attachments or 20 MiB\]/);
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
