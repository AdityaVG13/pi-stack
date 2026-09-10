import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { engineFixture } from "../helpers/engine.mjs";

const run = (f, args, signal, cwd = f.root) => f.tool.execute("program-file", args, signal, undefined, { cwd });

it("file programs reuse exact source and data with fresh guests, not cached code", async t => {
  const f = await engineFixture(t);
  const code = 'globalThis.count = (globalThis.count || 0) + 1; return {count:globalThis.count, data};';
  // Creation uses Nova's existing literal-input and transaction path.
  await run(f, { code: 'await write(data.path,data.content);', data: {path:"audit.js",content:code} });
  for (const data of [false, 0, null, "", {text:'quotes " backtick \u0060 \u0024{literal} λ😀\r\n'}]) {
    assert.deepEqual((await run(f, {file:"audit.js",data})).details.result, {count:1,data});
  }
  await f.write("audit.js", "async () => 42");
  assert.equal((await run(f, {file:"audit.js"})).details.result, 42);
  assert.equal((await run(f, {code:"return 42;"})).details.result, 42);
});

it("file programs use the calling workspace even when script directories and calls differ", async t => {
  const f = await engineFixture(t);
  const roots = [f.root, path.join(f.root,"second")];
  for (const [i, root] of roots.entries()) {
    await fs.mkdir(path.join(root,"scripts"), {recursive:true});
    await fs.writeFile(path.join(root,"value.txt"), String(i));
    await fs.writeFile(path.join(root,"scripts/audit.js"), 'return await read("value.txt");');
  }
  const results = await Promise.all(roots.map(cwd => run(f,{file:"scripts/audit.js"},undefined,cwd)));
  assert.deepEqual(results.map(result => result.details.result), ["0","1"]);
});

it("file admission rejects ambiguity, non-files, invalid UTF-8 and invalid syntax before commands", async t => {
  const f = await engineFixture(t);
  await f.write("audit.js", 'await write("never.txt","bad"); return 1;');
  for (const args of [{}, {file:"audit.js",code:"return 2;"}, {file:""}, {file:42}, {file:null}, {file:"missing.js"}, {file:"."}, {file:"agent://code"}, {file:"../outside.js"}]) {
    await assert.rejects(run(f,args), /exactly one|requires path|no such file|ENOENT|root directory|filesystem path|escapes workspace/);
  }
  await fs.mkdir(path.join(f.root,"directory"));
  await assert.rejects(run(f,{file:"directory"}), /regular file/);
  await fs.writeFile(path.join(f.root,"broken.js"), Buffer.concat([Buffer.from('await write("never.txt","bad");'), Buffer.from([255])]));
  await assert.rejects(run(f,{file:"broken.js"}), /encoded data|encoding/i);
  await f.write("broken.js", 'await write("never.txt","bad"); )');
  await assert.rejects(run(f,{file:"broken.js"}), /syntax error.*no commands ran/);
  await f.write("empty.js", "  ");
  await assert.rejects(run(f,{file:"empty.js"}), /non-empty/);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")), {code:"ENOENT"});
});

it("file programs enforce complete-source UTF-16 caps including multibyte input", async t => {
  const f = await engineFixture(t);
  const limit = f.tool.parameters.properties.code.maxLength;
  const prefix = "/*", suffix = "*/return 42;";
  const exact = prefix + "界".repeat(limit - prefix.length - suffix.length) + suffix;
  assert.equal(exact.length, limit);
  assert.ok(Buffer.byteLength(exact) > 65536);
  await f.write("audit.js", exact);
  assert.equal((await run(f,{file:"audit.js"})).details.result, 42);
  for (const code of [exact + " ", 'await write("never.txt","bad");' + " ".repeat(limit * 3)]) {
    await f.write("audit.js", code);
    await assert.rejects(run(f,{file:"audit.js"}), /code exceeds/);
  }
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")), {code:"ENOENT"});
});

it("file programs retain rollback, external commit and cancellation semantics", async t => {
  const f = await engineFixture(t);
  await f.write("audit.js", 'await write("state.txt","staged"); throw Error("stop");');
  await assert.rejects(run(f,{file:"audit.js"}), /committed=0 rolledBack=1/);
  await assert.rejects(fs.stat(path.join(f.root,"state.txt")), {code:"ENOENT"});
  await f.write("audit.js", 'await write("state.txt","committed"); await bash("printf smoke"); throw Error("stop");');
  await assert.rejects(run(f,{file:"audit.js"}), /committed=1 rolledBack=0.*external calls attempted=1/);
  assert.equal(await fs.readFile(path.join(f.root,"state.txt"),"utf8"), "committed");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(f,{file:"audit.js"},controller.signal), /aborted/);
  await f.write("audit.js", 'await new Promise(() => {}); await write("never.txt","bad");');
  await assert.rejects(run(f,{file:"audit.js",timeoutMs:100}), /timed out or aborted/);
  await assert.rejects(fs.stat(path.join(f.root,"never.txt")), {code:"ENOENT"});
});

it("file program admission rechecks symlinks and rejects FIFOs without a writer", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  await f.write("audit.js", "return 42;");
  await fs.symlink("audit.js",path.join(f.root,"alias.js"));
  assert.equal((await run(f,{file:"alias.js"})).details.result, 42);
  await fs.rename(path.join(f.root,"alias.js"),path.join(f.root,"old-alias.js"));
  await fs.symlink(path.dirname(f.root),path.join(f.root,"alias.js"));
  await assert.rejects(run(f,{file:"alias.js"}), /escapes workspace/);
  await fs.symlink(path.dirname(f.root),path.join(f.root,"escape"));
  await assert.rejects(run(f,{file:"escape/" + path.basename(f.root) + "/../outside.js"}), /escapes workspace/);
  const fifo = path.join(f.root,"pipe.js");
  await promisify(execFile)("mkfifo",[fifo]);
  const release = new Promise(resolve => setTimeout(resolve,200)).then(async () => {
    const handle = await fs.open(fifo,fs.constants.O_WRONLY | fs.constants.O_NONBLOCK).catch(error => { if (error.code !== "ENXIO") throw error; });
    await handle?.close();
  });
  try { await assert.rejects(run(f,{file:"pipe.js",timeoutMs:1000}), /regular file/); }
  finally { await release; }
});
