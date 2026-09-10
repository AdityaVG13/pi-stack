import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { engineFixture } from "../helpers/engine.mjs";

const run = (f, args, signal, cwd = f.root) => f.tool.execute("program-file", args, signal, undefined, { cwd });

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
  await assert.rejects(run(f,{code:'await write("never.txt","bad"); )'}),error=>{
    assert.match(error.message,/syntax error.*no commands ran/s);
    assert.match(error.message,/data/);

 return true;
  });
  await f.write("empty.js","async () => 42");
  assert.equal((await run(f,{file:"empty.js"})).details.result,42);
  await assert.rejects(run(f,{file:"empty.js"},AbortSignal.abort()),/aborted/);
  await f.write("empty.js",'await new Promise(()=>{}); await write("never.txt","bad");');
  await assert.rejects(run(f,{file:"empty.js",timeoutMs:100}),/timed out or aborted/);
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
