import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CausalVfs } from "../../src/fs/vfs.js";
import { createNativeScheduler } from "../../src/runtime/parallel.js";
import { engineFixture } from "../helpers/engine.mjs";

test("independent native edits overlap, stay bounded, and respect shell barriers", async t => {
  const f = await engineFixture(t);
  for (const count of [7, 10]) {
    const files = Array.from({length:count}, (_, i) => `edit-${count}-${i}.txt`);
    await Promise.all(files.map(file => f.write(file, "before")));
    const targets = new Set(files.map(file => path.join(f.root, file)));
    const originalRead = CausalVfs.prototype.read;
    let release, active = 0, peak = 0;
    const gate = new Promise(resolve => { release = resolve; });
    CausalVfs.prototype.read = async function(target, options) {
      if (!targets.has(target)) return originalRead.call(this, target, options);
      peak = Math.max(peak, ++active);
      if (active === Math.min(count, 8)) release();
      try {
        // No timing threshold: these reads cannot finish unless the required
        // number of real native edits have entered concurrently.
        await gate;
        return await originalRead.call(this, target, options);
      } finally { active--; }
    };
    try {
      const check = `const fs=require("node:fs"); for(const file of ${JSON.stringify(files)}) { if(fs.readFileSync(file,"utf8")!=="after") throw Error("uncommitted edit"); } if(fs.existsSync("later-${count}.txt")) throw Error("write crossed shell barrier"); process.stdout.write("checked");`;
      const result = await f.tool.execute("parallel-edits", {
        code: `const edits = data.files.map((file,i) => edit(file,"before","after").then(() => i));
          const checked = bash({command:process.execPath,args:["-e",data.check]});
          const later = write(data.later,"later").then(() => "later");
          return await Promise.all([...edits,checked,later]);`,
        data: {files, check, later:`later-${count}.txt`}, timeoutMs:3000,
      }, undefined, undefined, {cwd:f.root});
      assert.equal(peak, Math.min(count, 8));
      assert.deepEqual(result.details.result, [...files.map((_, i) => i), "checked", "later"]);
      assert.equal(result.details.mutations.committed, count + 1);
      assert.equal(await fs.readFile(path.join(f.root, `later-${count}.txt`), "utf8"), "later");
    } finally {
      release();
      CausalVfs.prototype.read = originalRead;
    }
  }
});

test("same-file edits and appends retain submission order before a read", async t => {
  const f = await engineFixture(t);
  await f.write("state.txt", "zero");
  const result = await f.tool.execute("same-file", {
    code: `const work = [edit("state.txt","zero","one"), edit("./state.txt","one","two"),
      write({path:data.absolute,content:"+three",append:true}), read("state.txt")];
      return (await Promise.all(work)).at(-1);`,
    data: {absolute:path.join(f.root,"state.txt")},
  }, undefined, undefined, {cwd:f.root});
  assert.equal(result.details.result, "two+three");
  assert.equal(await fs.readFile(path.join(f.root, "state.txt"), "utf8"), "two+three");
});

test("parallel edits preserve alias-conflict protection", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  await f.write("real.txt", "before");
  await fs.symlink(path.join(f.root,"real.txt"), path.join(f.root,"alias.txt"));
  await assert.rejects(f.execute(`await Promise.all([
    edit("real.txt","before","real"), edit("alias.txt","before","alias")
  ]);`), /conflicting write aliases/);
  assert.equal(await fs.readFile(path.join(f.root, "real.txt"), "utf8"), "before");
});

test("checkpoint rollback waits for a failed edit's in-flight sibling", async t => {
  const f = await engineFixture(t);
  await Promise.all([f.write("slow.txt","before"), f.write("bad.txt","before")]);
  const originalRead = CausalVfs.prototype.read;
  let release;
  const failed = new Promise(resolve => { release = resolve; });
  CausalVfs.prototype.read = async function(target, options) {
    if (target === path.join(f.root,"slow.txt")) await failed;
    return originalRead.call(this, target, options);
  };
  try {
    const result = await f.tool.execute("checkpoint", {
      code: `const error = await edit(async () => Promise.all([
        edit("slow.txt","before","after"), edit("bad.txt","missing","bad")
      ])).catch(error => error.message);
      return {error, contents:await read(["slow.txt","bad.txt"])};`,
      timeoutMs:3000,
    }, undefined, update => {
      if (update.details?.trace?.some(record => record.args.path === "bad.txt" && record.ok === false)) release();
    }, {cwd:f.root});
    assert.match(result.details.result.error, /not found/);
    assert.deepEqual(result.details.result.contents, ["before","before"]);
    assert.equal(result.details.mutations.rolledBack, 1);
    assert.equal(await fs.readFile(path.join(f.root,"slow.txt"), "utf8"), "before");
  } finally {
    release();
    CausalVfs.prototype.read = originalRead;
  }
});

test("overridden edits remain global barriers even on different files", async t => {
  const f = await engineFixture(t);
  let active = 0, peak = 0;
  f.pi.registerTool({name:"edit", execute:async (_id, args) => {
    peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      await f.write(args.path, args.newText);
      return {content:[{type:"text",text:"external edit"}]};
    } finally { active--; }
  }});
  await f.execute(`await Promise.all([
    edit("a.txt","before","A"), edit("b.txt","before","B")
  ]);`);
  assert.equal(peak, 1);
  assert.equal(await fs.readFile(path.join(f.root,"a.txt"), "utf8"), "A");
  assert.equal(await fs.readFile(path.join(f.root,"b.txt"), "utf8"), "B");
});

test("queued file identities wait for shell barriers and cancelled jobs never start", async () => {
  const scheduler = createNativeScheduler();
  const events = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const shell = scheduler.schedule("bash", async () => {
    events.push("shell-start");
    await held;
    events.push("shell-end");
  });
  const controller = new AbortController();
  const cancelled = scheduler.schedule("write", () => events.push("cancelled-write"), controller.signal,
    () => { events.push("cancelled-key"); return "cancelled.txt"; });
  const rejected = assert.rejects(cancelled, /cancelled/);
  const written = scheduler.schedule("write", () => events.push("write"), undefined,
    () => { events.push("key"); return "current-target.txt"; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["shell-start"]);
    controller.abort(new Error("cancelled"));
    await rejected;
  } finally { release(); }
  await Promise.all([shell, written]);
  assert.deepEqual(events, ["shell-start", "shell-end", "key", "write"]);
});

test("a just-completed barrier does not strand the next file operation", {timeout:2000}, async () => {
  const scheduler = createNativeScheduler();
  await scheduler.schedule("bash", () => {});
  assert.equal(await scheduler.schedule("write", () => "ran", undefined, () => "file.txt"), "ran");
});
