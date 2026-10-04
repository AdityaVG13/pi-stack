import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { engineFixture, limits } from "../helpers/engine.mjs";
import { createHostBridge } from "../../src/bridge/host-bridge.js";
import { listWithTools } from "../../src/context/search.js";

it("source discovery preserves newline-bearing filenames across indexed and fallback listings", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const file = "src/line\nbreak/entry\npoint.js";
  const body = "export function newlinePathToken() { return 57; }\n";
  await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
  await f.write(file, body);
  const evidence = (await f.execute('return await read({query:"newlinePathToken",evidence:true});')).details.result;
  assert.deepEqual(evidence.spans.map(span => ({path:span.path,text:span.text})), [{path:file,text:body.trimEnd()}]);

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(() => bridge.close());
  const indexed = await bridge.natives.glob({pattern:"*.js"});
  assert.equal(indexed.details.via, "index");
  assert.equal(indexed.content[0].text, file + "\n");
  const grep = await bridge.natives.grep({pattern:"newlinePathToken",literal:true});
  assert.equal(grep.details.via, "index");
  assert.ok(grep.content[0].text.startsWith(file + "\n"));
  assert.ok(grep.content[0].text.includes(body.trimEnd()));

  const pending = "pending\nfile.js";
  const expected = file + "\n" + pending + "\n";
  const pendingPaths = [file,pending].map(name => path.join(f.root,name));
  const fallback = await listWithTools(f.root,"*.js",f.root,undefined,pendingPaths);
  assert.equal(fallback.details.via, "rg");
  assert.equal(fallback.content[0].text, expected, "disk and staged filenames must merge without aliases or duplicates");

  const {stdout:findPath} = await promisify(execFile)("sh", ["-c", "command -v find"]);
  const bin = path.join(f.root, "find-only");
  await fs.mkdir(bin);
  await fs.symlink(findPath.trim(), path.join(bin, "find"));
  const previousPath = process.env.PATH;
  process.env.PATH = bin;

  try {
    const find = await listWithTools(f.root,"*.js",f.root,undefined,pendingPaths);
    assert.equal(find.details.via, "find");
    assert.equal(find.content[0].text, expected, "find fallback must preserve the same filenames");
  } finally { process.env.PATH = previousPath; }
});

it("native searches preserve escaped trailing directory separators in exclusion globs", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const disk = ["vendor/disk.txt", "nested/vendor/disk.txt", "keep/vendor", "vendor\\/disk.txt", "nested/vendor\\/disk.txt", "keep/vendor\\", "vendor\\\\/disk.txt", "keep/vendor\\\\", "keep.txt"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["vendor/pending.txt", "nested/vendor/pending.txt", "vendor\\/pending.txt", "nested/vendor\\/pending.txt", "vendor\\\\/pending.txt", "pending.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  for (const [pattern, directory, rooted] of [
    [String.raw`!ven?or\/`, "vendor", false],
    [String.raw`!/ven?or\/`, "vendor", true],
    ["!ven?or/", "vendor", false],
    [String.raw`!ven?or\\\/`, "vendor\\", false],
    [String.raw`!/ven?or\\\/`, "vendor\\", true],
    [String.raw`!ven?or\\\\\/`, "vendor\\\\", false],
    [String.raw`!ven?or\\/*`, "vendor\\", true],
  ]) {
    // A directory-only exclusion never removes a file with the same basename.
    const keep = file => rooted ? !file.startsWith(directory + "/") : !file.split("/").slice(0, -1).includes(directory);
    const expectedDisk = disk.filter(keep).sort();
    const expectedStaged = staged.filter(keep).sort();
    const {stdout} = await promisify(execFile)("rg", ["--files", "--null", "-g", pattern, "."], {cwd:f.root});
    const rgRows = stdout.split("\0").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort();
    assert.deepEqual(rgRows, expectedDisk, "real ripgrep escaped-separator semantics: " + pattern);

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expectedDisk, ...expectedStaged].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches match ripgrep globs across carriage returns in path components", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const disk = ["src/direct.txt", "src/build\r-cache/hit.txt", "src/build\r-cache/deep/hit.txt", "keep.js"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["src/pending\r-cache/hit.txt", "src/pending\r-cache/deep/hit.txt", "pending.js"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  for (const [pattern, expectedDisk, expectedStaged] of [
    ["src/**/*.txt", disk.slice(0, 3), staged.slice(0, 2)],
    ["src/**", disk.slice(0, 3), staged.slice(0, 2)],
    ["!*.txt", ["keep.js"], ["pending.js"]],
    ["src/*/hit.txt", [disk[1]], [staged[0]]],
  ]) {
    const {stdout} = await promisify(execFile)("rg", ["--files", "--null", "-g", pattern, "."], {cwd:f.root});
    const rgRows = stdout.split("\0").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort();
    assert.deepEqual(rgRows, [...expectedDisk].sort(), "real ripgrep carriage-return semantics");

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expectedDisk, ...expectedStaged].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches preserve ripgrep chained character-class ranges", async t => {
  const f = await engineFixture(t);
  const names = ["-", "a", "b", "c", "d", "e", "f", "g"];
  const disk = names.map(name => "disk/" + name + ".txt");
  const staged = names.map(name => "pending/" + name + ".txt");
  await fs.mkdir(path.join(f.root, "disk"));

  for (const file of disk) await f.write(file, "needle\n");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  for (const [pattern, selected] of [
    ["[a-c-e].txt", ["a", "b", "c", "d", "e"]],
    ["[a-c-e-g].txt", ["a", "b", "c", "d", "e", "f", "g"]],
    ["[a-c-b].txt", ["a", "b"]],
    ["[a-a-a].txt", ["a"]],
    ["[a-b-ef].txt", ["a", "b", "c", "d", "e", "f"]],
    ["[!a-c-e].txt", ["-", "f", "g"]],
    ["[a-c-].txt", ["-", "a", "b", "c"]],
    ["[-a-c].txt", ["-", "a", "b", "c"]],
  ]) {
    const expectedDisk = selected.map(name => "disk/" + name + ".txt");
    const expectedStaged = selected.map(name => "pending/" + name + ".txt");
    const {stdout} = await promisify(execFile)("rg", ["--files", "--null", "-g", pattern, "."], {cwd:f.root});
    assert.deepEqual(stdout.split("\0").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort(), expectedDisk, "real ripgrep: " + pattern);

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");
      const rows = results[i].content.map(block => block.text).join("\n").split("\n").filter(row => row && !row.startsWith("  ")).sort();
      assert.deepEqual(rows, [...expectedDisk, ...expectedStaged].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches match ripgrep globs over UTF-8 filename bytes", async t => {
  const f = await engineFixture(t);
  const disk = ["a.txt", "ab.txt", "é.txt", "中.txt", "😀.txt", "nested/😀.txt"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["pending/a.txt", "pending/é.txt", "pending/中.txt", "pending/😀.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  for (const [pattern, expectedDisk, expectedStaged] of [
    ["?.txt", ["a.txt"], ["pending/a.txt"]],
    ["??.txt", ["ab.txt", "é.txt"], ["pending/é.txt"]],
    ["???.txt", ["中.txt"], ["pending/中.txt"]],
    ["????.txt", ["😀.txt", "nested/😀.txt"], ["pending/😀.txt"]],
    ["!??.txt", ["a.txt", "中.txt", "😀.txt", "nested/😀.txt"], ["pending/a.txt", "pending/中.txt", "pending/😀.txt"]],
    ["[é].txt", [], []],
    ["[é]?.txt", ["é.txt"], ["pending/é.txt"]],
    ["[中]??.txt", ["中.txt"], ["pending/中.txt"]],
    ["[😀]???.txt", ["😀.txt", "nested/😀.txt"], ["pending/😀.txt"]],
    ["*.txt", disk, staged],
    ["{é,😀}.txt", ["é.txt", "😀.txt", "nested/😀.txt"], ["pending/é.txt", "pending/😀.txt"]],
  ]) {
    const reference = await promisify(execFile)("rg", ["--files", "-g", pattern, "."], {cwd:f.root})
      .catch(error => { if (error.code === 1) return {stdout:error.stdout}; throw error; });

    const rgRows = reference.stdout.split("\n").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort();

    assert.deepEqual(rgRows, [...expectedDisk].sort(), "real ripgrep UTF-8 byte semantics");

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expectedDisk, ...expectedStaged].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches retain recursion at slash-prefixed double-star brace endings", async t => {
  const f = await engineFixture(t);
  const disk = ["src/direct.txt", "src/deep/disk.txt", "src/deep/nested/disk.txt", "other.txt", "unrelated.txt"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["src/pending.txt", "src/deep/pending.txt", "src/deep/nested/pending.txt", "pending.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  const deepStaged = ["src/deep/pending.txt", "src/deep/nested/pending.txt"];

  for (const [pattern, expectedDisk, expectedStaged] of [
    ["{src/**,other*.txt}", disk.slice(0, 4), staged.slice(0, 3)],
    ["src/{deep/**,direct*.txt}", disk.slice(0, 3), deepStaged],
    ["src/{direct*.txt,deep/**}", disk.slice(0, 3), deepStaged],
    ["{src/{deep/**,direct*.txt},other*.txt}", disk.slice(0, 4), deepStaged],
    ["src/{**,other}.txt", ["src/direct.txt"], ["src/pending.txt"]],
    ["!{src/**,other*.txt}", ["unrelated.txt"], ["pending.txt"]],
  ]) {
    const {stdout} = await promisify(execFile)("rg", ["--files", "-g", pattern, "."], {cwd:f.root});
    const rgRows = stdout.split("\n").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort();
    assert.deepEqual(rgRows, [...expectedDisk].sort(), "real ripgrep double-star brace semantics");

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expectedDisk, ...expectedStaged].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches discard empty ripgrep brace alternatives", async t => {
  const f = await engineFixture(t);
  const disk = ["report", "report.txt", "report-old.txt", "nested/report", "nested/report.txt", "other.txt"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["pending/report", "report-new-old.txt", "pending/report-new-old.txt", "pending/other.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  const diskMatches = ["report.txt", "report-old.txt", "nested/report.txt"];
  const stagedMatches = ["report-new-old.txt", "pending/report-new-old.txt"];

  for (const [pattern, expectedDisk, expectedStaged] of [
    ["report{,*.txt}", diskMatches, stagedMatches],
    ["report{*.txt,}", diskMatches, stagedMatches],
    ["report{.txt,,*-old.txt}", diskMatches, stagedMatches],
    ["report{{,},*.txt}", diskMatches, stagedMatches],
    ["!report{,*.txt}", ["report", "nested/report", "other.txt"], ["pending/report", "pending/other.txt"]],
    ["report{,}", ["report", "nested/report"], ["pending/report"]],
  ]) {
    const {stdout} = await promisify(execFile)("rg", ["--files", "-g", pattern, "."], {cwd:f.root});
    const rgRows = stdout.split("\n").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort();
    assert.deepEqual(rgRows, [...expectedDisk].sort(), "real ripgrep brace semantics");

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expectedDisk, ...expectedStaged].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches exclude directory descendants for disk and staged paths", async t => {
  const f = await engineFixture(t);
  const disk = ["vendor/disk.txt", "vendor/cache/deep.txt", "nested/vendor/disk.txt", "nested/keep.txt", "keep/vendor", "vendor-old/keep.txt", "keep.txt"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["vendor/pending.txt", "nested/vendor/pending.txt", "pending.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  const kept = ["nested/keep.txt", "vendor-old/keep.txt", "keep.txt", "pending.txt"];
  const nested = ["nested/vendor/disk.txt", "nested/vendor/pending.txt"];

  for (const [pattern, expected] of [
    ["!ven?or", kept],
    ["!/ven?or", [...kept, ...nested, "keep/vendor"]],
    ["!ven?or/", [...kept, "keep/vendor"]],
    ["!/ven?or/", [...kept, ...nested, "keep/vendor"]],
    ["!vendor/*", [...kept, ...nested, "keep/vendor"]],
  ]) {
    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expected].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches keep embedded double-star globs within one path component", async t => {
  const f = await engineFixture(t);
  const disk = ["src/direct.js", "src/nested/deep.js", "src/build/report.txt", "src/build-cache/report.txt", "src/build-cache/nested/report.txt", "src/buildreport.txt"];

  for (const file of disk) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), {recursive:true});
    await f.write(file, "needle\n");
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["src/pending.js", "src/nested/pending.js", "src/build-new/report.txt", "src/build-new/nested/report.txt", "src/buildpending.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  for (const [pattern, expected] of [
    ["src/**.js", ["src/direct.js", "src/pending.js"]],
    ["!src/**.js", [...disk, ...staged].filter(file => file !== "src/direct.js" && file !== "src/pending.js")],
    ["src/build**/report.txt", ["src/build/report.txt", "src/build-cache/report.txt", "src/build-new/report.txt"]],
    ["src/{build**,nested}/report.txt", ["src/build/report.txt", "src/build-cache/report.txt", "src/build-new/report.txt"]],
    ["src/**/*.js", ["src/direct.js", "src/nested/deep.js", "src/pending.js", "src/nested/pending.js"]],
    ["src/{**/pending,nested/deep}.js", ["src/pending.js", "src/nested/pending.js", "src/nested/deep.js"]],
  ]) {
    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, [...expected].sort(), pattern + ": search " + i);
    }
  }
});

it("native searches expand nested ripgrep brace globs for disk and staged files", async t => {
  const f = await engineFixture(t);
  const disk = ["disk.js", "disk.ts", "disk.tsx", "other.txt"];
  await Promise.all(disk.map(file => f.write(file, "needle\n")));
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["pending.tsx", "pending.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  const pattern = "*.{js,{ts,tsx}}";
  const expected = ["disk.js", "disk.ts", "disk.tsx", "pending.tsx"].sort();

  const results = await Promise.allSettled([
    bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
    bridge.natives.glob({pattern}),
    listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
  ]);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    assert.equal(result.status, "fulfilled", "nested brace search: " + (result.reason?.message ?? i));
    assert.equal(result.value.details.via, i === 2 ? "rg" : "index");

    const rows = result.value.content.map(block => block.text).join("\n")
      .split("\n").filter(row => row && !row.startsWith("  ")).sort();

    assert.deepEqual(rows, expected, "nested braces must expand every alternative and include staged matches");
  }
});

it("native grep literal:true matches the string, not a regex", async t => {
  const f = await engineFixture(t);
  await f.write("hit.txt", "needle a+b here\n");
  await f.write("miss.txt", "needle aab here\n");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(() => bridge.close());
  const result = await bridge.natives.grep({pattern:"a+b",literal:true});
  const text = result.content.map(block => block.text).join("\n");
  assert.match(text, /hit\.txt/);
  assert.doesNotMatch(text, /miss\.txt/);
});

it("fallback native listings merge staged paths as relative, unique entries", async t => {
  const f = await engineFixture(t);
  const files = Array.from({length:4001}, (_, i) => "disk-" + i + ".txt");

  for (let i = 0; i < files.length; i += 100) {
    await Promise.all(files.slice(i, i + 100).map(file => f.write(file, "disk\n")));
  }

  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  await bridge.natives.write({path:"disk-0.txt",content:"staged\n"});
  await bridge.natives.write({path:"pending.txt",content:"new\n"});
  const result = await bridge.natives.glob({pattern:"*.txt"});
  assert.equal(result.details.via, "rg", "exercise the real large-tree fallback");
  const rows = result.content.map(block => block.text).join("\n").trimEnd().split("\n");
  assert.ok(rows.includes("pending.txt"), "new staged files must have workspace-relative names");
  assert.equal(rows.length, files.length + 1, "an overlaid disk file must not appear twice");
  assert.equal(rows.filter(row => row === "disk-0.txt").length, 1);
  assert.ok(rows.every(row => !row.startsWith(f.root)), "disk and overlay paths use the same relative namespace");
});

it("indexed native searches match literal glob metacharacters escaped with a backslash", async t => {
  const f = await engineFixture(t);
  await f.write("report*.txt", "needle\n");
  await f.write("report-other.txt", "needle\n");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(() => bridge.close());
  const pattern = "report\\*.txt";

  for (const result of [
    await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
    await bridge.natives.glob({pattern}),
  ]) {
    assert.equal(result.details.via, "index");
    const text = result.content.map(block => block.text).join("\n");
    assert.match(text, /report\*\.txt/);
    assert.doesNotMatch(text, /report-other\.txt/);
  }
});

it("indexed native searches match a leading literal closing bracket in glob classes", async t => {
  const f = await engineFixture(t);
  const files = ["].txt", "a.txt", "z.txt"];
  await Promise.all(files.map(file => f.write(file, "needle\n")));
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(() => bridge.close());

  for (const [pattern, expected] of [
    ["[]a].txt", ["].txt", "a.txt"]],
    ["[!]a].txt", ["z.txt"]],
    ["[!]].txt", ["a.txt", "z.txt"]],
    ["[^]].txt", ["a.txt", "z.txt"]],
    ["![]a].txt", ["z.txt"]],
  ]) {
    for (const result of [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
    ]) {
      assert.equal(result.details.via, "index");
      const text = result.content.map(block => block.text).join("\n");

      for (const file of files) {
        assert.equal(text.includes(file), expected.includes(file), pattern + ": " + file);
      }
    }
  }
});

it("native searches preserve literal backslashes inside ripgrep glob classes", async t => {
  const f = await engineFixture(t);
  const disk = ["].txt", "a.txt", "b.txt", "-.txt", "z.txt"];
  await Promise.all(disk.map(file => f.write(file, "needle\n")));
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  bridge.beginSpeculation();
  bridge.beginSpeculation();
  t.after(() => { bridge.rollbackSpeculation(); bridge.rollbackSpeculation(); bridge.close(); });
  const staged = ["^.txt", "_.txt", "x.txt"];

  for (const file of staged) await bridge.natives.write({path:file,content:"needle\n"});

  for (const [pattern, diskMatches, stagedMatches] of [
    ["[a\\-b].txt", ["].txt", "a.txt", "b.txt"], ["^.txt", "_.txt"]],
    ["![a\\-b].txt", ["-.txt", "z.txt"], ["x.txt"]],
  ]) {
    // Backslashes are literal class members in rg, so this range is \\ through b.
    const {stdout} = await promisify(execFile)("rg", ["--files", "-g", pattern, "."], {cwd:f.root});
    const rgRows = stdout.split("\n").filter(Boolean).map(row => row.replace(/^\.\//, "")).sort();
    assert.deepEqual(rgRows, [...diskMatches].sort(), "real ripgrep class semantics");

    const expected = [...diskMatches, ...stagedMatches].sort();

    const results = [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
      await listWithTools(f.root,pattern,f.root,undefined,staged.map(file => path.join(f.root,file))),
    ];

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].details.via, i === 2 ? "rg" : "index");

      const rows = results[i].content.map(block => block.text).join("\n")
        .split("\n").filter(row => row && !row.startsWith("  ")).sort();

      assert.deepEqual(rows, expected, pattern + ": search " + i);
    }
  }
});

it("indexed native searches honor root-anchored ripgrep globs", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "nested"));
  await f.write("report.txt", "needle\n");
  await f.write("nested/report.txt", "needle\n");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(() => bridge.close());

  for (const pattern of ["/report*.txt", "!/report*.txt"]) {
    for (const result of [
      await bridge.natives.grep({pattern:"needle",literal:true,glob:pattern}),
      await bridge.natives.glob({pattern}),
    ]) {
      assert.equal(result.details.via, "index");
      const text = result.content.map(block => block.text).join("\n");
      assert.equal(/(?:^|\n)report\.txt(?:\n|$)/.test(text), !pattern.startsWith("!"), "root file: " + pattern);
      assert.equal(text.includes("nested/report.txt"), pattern.startsWith("!"), "nested file: " + pattern);
    }
  }
});

it("indexed native searches honor ripgrep exclusion globs", async t => {
  const f = await engineFixture(t);
  await f.write("included.txt", "needle\n");
  await f.write("excluded.js", "needle\n");
  const bridge = createHostBridge({pi:null,config:limits,getCwd:()=>f.root});
  t.after(() => bridge.close());

  for (const result of [
    await bridge.natives.grep({pattern:"needle",literal:true,glob:"!*.js"}),
    await bridge.natives.glob({pattern:"!*.js"}),
  ]) {
    const text = result.content.map(block => block.text).join("\n");
    assert.match(text, /included\.txt/);
    assert.doesNotMatch(text, /excluded\.js/);
  }
});
