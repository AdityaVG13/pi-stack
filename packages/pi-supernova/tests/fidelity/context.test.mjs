import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture, modelText } from "../helpers/engine.mjs";
import { Frecency, fuzzyMatch, rankPaths } from "../../src/context/fuzzy.js";
import { WorkspaceIndex } from "../../src/context/repo-index.js";

it("returning an image read preserves an image attachment, not UTF-8 decoded binary or a text placeholder", async t => {
  const fixture = await engineFixture(t);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  await fixture.write("pixel.png", image);
  const result = await fixture.execute('return await read("pixel.png");');
  assert.equal(result.details.ok, true, result.details.error);
  const attachment = result.content.find(block => block.type === "image");
  assert.ok(attachment, "The model must receive an actual image content block through CodeMode");
  assert.equal(attachment.mimeType, "image/png");
  assert.deepEqual(Buffer.from(attachment.data, "base64"), image);
});

it("a repeated plain read remains self-contained when no retained-context acknowledgement exists", async t => {
  const fixture = await engineFixture(t);
  const body = Array.from({ length: 60 }, (_, i) => `important source line ${i}`).join("\n");
  await fixture.write("context.txt", body);
  const first = await fixture.execute('return await read("context.txt");');
  const second = await fixture.execute('return await read("context.txt");');
  assert.equal(first.details.ok, true, first.details.error);
  assert.equal(second.details.ok, true, second.details.error);
  assert.ok(modelText(first).includes(body), "First read must contain the requested source");
  assert.ok(modelText(second).includes(body), "A cache hit is not proof the model still has the earlier source in context");
});

it("a display-limited source view gives exact continuation without losing its path or range", async t => {
  const fixture = await engineFixture(t);
  await fixture.write("large.txt", Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: ${"payload ".repeat(20)}`).join("\n"));
  const result = await fixture.execute('return await read({path:"large.txt",resolve:true});');
  assert.equal(result.details.ok, true, result.details.error);
  const text = modelText(result);
  assert.ok(/truncat|omitt|continu/i.test(text), "The response must explicitly disclose incomplete content");
  assert.equal(result.details.result.path,"large.txt");
  assert.equal(result.details.result.nextOffset,result.details.result.lines[1]+1);
  assert.ok(result.details.result.nextOffset>1);
});

it("diagnostic source windows omit a file changed between short reads", async t => {
  const f = await engineFixture(t);
  await f.write("unit.js","old-one\nold-two\n");
  const handle = await fs.open(path.join(f.root,"unit.js"));
  const identity = await handle.stat();
  const prototype = Object.getPrototypeOf(handle), original = prototype.read;
  await handle.close();
  let changed = false;

  const mock = t.mock.method(prototype,"read",async function(buffer,offset,length,position) {
    const current = await this.stat();
    const target = current.dev === identity.dev && current.ino === identity.ino;
    const result = await original.call(this,buffer,offset,!changed && target ? Math.min(8,length) : length,position);

    if (!changed && target && result.bytesRead === 8 && buffer.subarray(offset,offset+8).toString() === "old-one\n") {
      changed = true;
      await f.write("unit.js","new-one\nnew-two\n");
    }

    return result;
  });

  try {
    const script = 'process.stderr.write("unit.js:2\\nproblem\\n"); process.exitCode=1;';
    await assert.rejects(f.execute('await bash({command:process.execPath,args:["-e",'+JSON.stringify(script)+']});'), error => {
      assert.match(error.message,/unit.js:2/);
      assert.doesNotMatch(error.message,/old-one|new-two/,"do not attach a fabricated mixed-version source excerpt");

      return true;
    });
  } finally { mock.mock.restore(); }

  assert.equal(changed,true);
});


it("frecency retains the recently reused file when capacity evicts an entry", () => {
  const f = new Frecency();

  for (let n = 0; n < 10000; n++) f.record("file-" + n, 1000);
  f.record("file-0", 1100);
  f.record("new-file", 1200);
  assert.ok(f.score("file-0", 0, 1200) > 1);
  assert.equal(f.score("file-1", 0, 1200), 0);
  assert.equal(f.access.size, 10000);
});

it("Unicode case folding never shifts fuzzy offsets or filename bonuses", () => {
  const normal = fuzzyMatch("foo", "Istanbul/foo.js");
  const expanded = fuzzyMatch("foo", "İstanbul/foo.js");
  assert.equal(expanded.start, 9);
  assert.equal(expanded.end, 12);
  assert.equal(expanded.score, normal.score);
  const paths = ["Istanbul/foo.js", "İstanbul/foo.js"];
  const ranked = rankPaths("foo", paths, { maxTypos: 0 });
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(fuzzyMatch("i", "İ").start, 0);
  assert.equal(fuzzyMatch("iος", "İΟΣ")?.start, 0, "length repair must preserve contextual lowercase");
});


it("Markdown about reads select prose rather than unrelated fenced declarations", async t => {
  const f = await engineFixture(t);
  const document = ['# Contract', '', '```js', 'export function unrelatedExample() {}', '```', ...Array(20).fill(''), '## Durability', 'External writers may race with publication.', ''].join('\n');
  await f.write("guide.md", document);
  const result = await f.execute('return [await read("guide.md", {about:"durability"}), await read("guide.md", {about:"quantum"})];');
  assert.match(modelText(result), /External writers may race with publication/);
  assert.match(modelText(result), /no matching text/);
  assert.doesNotMatch(modelText(result), /unrelatedExample/);
  const staged = await f.execute('return await edit(async () => { await write({path:"guide.md", content:"## Durability\\nStaged prose stays visible.\\n", replace:true}); return await read("guide.md", {about:"durability"}); });');
  assert.match(modelText(staged), /Staged prose stays visible/);
});


it("indexed source discovery reads its own bytes and produces an editable view", async t => {
  const f = await engineFixture(t);
  const body = 'export function adjust() {\r\n  return 17;\r\n}\r\n';
  const original = body + 'export function untouched() { return 99; }\r\n';
  await f.write('literal name.js', original);
  f.pi.registerTool({name:'isearch', approval:'read', annotations:{readOnlyHint:true},parameters:{type:'object'}, execute:async () => ({
    content:[{type:'text',text:'STALE PROVIDER TEXT MUST NOT BECOME THE READ'}],
    details:{code:'OK', truncated:true, contextSelectionComplete:true, contexts:[{path:'literal name.js',startLine:1,endLine:3,sourceVersion:'not-an-edit-token'}]},
  })});
  const read = await f.execute('return await read({query:"adjust",indexed:true});');
  assert.equal(read.details.result.text,body);
  assert.doesNotMatch(modelText(read),/STALE PROVIDER/);
  const edited = await f.execute('const v = await read({query:"adjust",indexed:true}); await edit(v,"return 17","return 18"); return v.path;');
  assert.equal(edited.details.ok,true,edited.details.error);
  assert.equal(await fs.readFile(path.join(f.root,'literal name.js'),'utf8'),original.replace('17','18'));
});

it("indexed source hints cannot escape scope, select ambiguous paths or bypass tool permissions", async t => {
  const f = await engineFixture(t);
  await f.write('a.js','export function available() { return 1; }\n');
  await f.write('b.js','export function available() { return 2; }\n');
  await assert.rejects(f.execute('return await read({query:"available",indexed:true});'),/callable.*isearch|isearch.*enabled/);
  let contexts = [{path:'../outside.js',startLine:1,endLine:1}];
  f.pi.registerTool({name:'isearch',approval:'read',annotations:{readOnlyHint:true},parameters:{type:'object'},execute:async () => ({content:[],details:{code:'OK',contexts}})});
  await assert.rejects(f.execute('return await read({query:"available",indexed:true});'),/scope|workspace/);
  contexts = [{path:'a.js',startLine:1,endLine:1},{path:'b.js',startLine:1,endLine:2}];
  const ambiguous = await f.execute('return await read({query:"available",indexed:true});');
  assert.equal(ambiguous.details.result.status,'ambiguous');
  // Named edits read internally; unresolved locator metadata must not become an editable view.
  await assert.rejects(f.execute('const v=await read({query:"available",indexed:true}); await edit(v,"return 1","return 3");'),/invalid edit signature/);
  const outside=await fs.mkdtemp(path.join(f.root,'..','indexed-outside-'));
  await fs.writeFile(path.join(outside,'private.js'),'private');
  await fs.symlink(path.join(outside,'private.js'),path.join(f.root,'link.js'));
  contexts=[{path:'link.js',startLine:1,endLine:1}];
  await assert.rejects(f.execute('return await read({query:"private",indexed:true});'),/scope|workspace/);
  const foreign=await engineFixture(t);
  foreign.pi.registerTool({name:'read',parameters:{type:'object'},execute:async()=>({content:[{type:'text',text:'foreign'}]})});
  await assert.rejects(foreign.execute('return await read({query:"available",indexed:true});'),/Supernova-owned read/);
  f.pi.getActiveTools = () => ['supernova'];
  await assert.rejects(f.execute('return await read({query:"available",indexed:true});'),/callable.*isearch|isearch.*enabled/);
});

it("indexed source discovery respects staged source and rejects a write raced after its read", async t => {
  const f = await engineFixture(t);
  await f.write('a.js','export function before() { return 1; }\n');
  f.pi.registerTool({name:'isearch',approval:'read',annotations:{readOnlyHint:true},parameters:{type:'object'},execute:async () => ({content:[],details:{code:'OK',contexts:[{path:'a.js',startLine:1,endLine:1}]}})});
  const staged = await f.execute('await read("a.js"); await edit("a.js","before() { return 1","after() { return 2"); return await read({query:"after",indexed:true});');
  assert.equal(staged.details.result.status,'found');
  assert.match(staged.details.result.text,/function after/);
  const {gatedExecute,GUEST_GATE_POLL} = await import('../helpers/engine.mjs');
  const {pending,gate} = gatedExecute(f, 'const v = await read({query:"after",indexed:true}); '+GUEST_GATE_POLL+' await edit(v,v.text.replace("return 2","return 3"));', r => r.adapter === 'read' && r.ok);
  await gate;
  await f.write('a.js','export function after() { return 9; }\n');
  await f.write('go.txt','go');
  await assert.rejects(pending,/changed|conflict|stale/);
  assert.match(await fs.readFile(path.join(f.root,'a.js'),'utf8'),/return 9/);
});

it('metadata-only host discovers one read-only locator without retaining withdrawn capabilities',async t=>{
  const f=await engineFixture(t);
  await f.write('a.js','export function located() { return 1; }\n');
  const parameters={type:'object'};
  const provider={name:'isearch',parameters,annotations:{readOnlyHint:true},execute:async()=>({content:[],details:{code:'OK',contextSelectionComplete:true,contexts:[{path:'a.js',startLine:1,endLine:1}]}})};
  let active=['supernova','isearch'], available=true, duplicate=false, effectiveParameters=parameters;
  f.pi.getAllTools=()=>[{name:'isearch',parameters:effectiveParameters}];
  f.pi.getActiveTools=()=>active;
  f.pi.events={emit(name,event){
    if(name==='pi-indexer:readonly-provider' && available && event.parameters===parameters) {
      event.accept(provider);

      if(duplicate) event.accept(provider);
    }
  }};
  const code='const view=await read({query:"located",indexed:true}); await edit(view,"return 1","return 2"); return view.status;';
  assert.equal((await f.execute(code)).details.result,'found');
  assert.equal(await fs.readFile(path.join(f.root,'a.js'),'utf8'),'export function located() { return 2; }\n');
  const read='return await read({query:"located",indexed:true});';
  active=['supernova'];
  await assert.rejects(f.execute(read),/callable.*isearch/);
  active=['supernova','isearch']; available=false;
  await assert.rejects(f.execute(read),/callable.*isearch/);
  available=true; duplicate=true;
  await assert.rejects(f.execute(read),/callable.*isearch/);
  duplicate=false; effectiveParameters={type:'object'};
  await assert.rejects(f.execute(read),/callable.*isearch/);
  effectiveParameters=parameters;
  const sessionManager={getSessionId:()=> 'denied-session'};
  const session={sessionManager,getEvalBridgeToolNames:()=>[],getToolForEvalBridge:()=>undefined};
  f.pi.pi={AgentRegistry:{global:()=>({list:()=>[{session}]})}};
  await assert.rejects(f.tool.execute('denied',{code:read},undefined,undefined,{cwd:f.root,sessionManager}),/callable.*isearch/);
});


it("focused text without declarations does not wait for unrelated workspace discovery", async t => {
  const f = await engineFixture(t);
  const source = "Startup complete\nCache refresh requested\nCache refresh succeeded\nShutdown complete\n";
  await f.write("events.txt", source);
  const catalog = Promise.withResolvers(), requested = Promise.withResolvers();

  const listing = t.mock.method(WorkspaceIndex.prototype, "files", () => {
    requested.resolve();

    return catalog.promise;
  });

  const running = f.execute('return await read("events.txt",{about:"cache refresh"});');

  try {
    const outcome = await Promise.race([
      running.then(result => ({ result })),
      requested.promise.then(() => ({ blocked: true })),
    ]);

    assert.equal(outcome.blocked, undefined, "Text focus has no caller hints to discover; it must complete independently of the workspace catalog");
    assert.equal(outcome.result.details.result,
      "// events.txt · focused text windows (not a complete file); read(path, line, count) for raw source\n" +
      "    1 Startup complete\n    2 Cache refresh requested\n    3 Cache refresh succeeded\n    4 Shutdown complete\n    5 ");
    assert.equal(await fs.readFile(path.join(f.root, "events.txt"), "utf8"), source);
    const whole = await f.execute('return await read("events.txt",{about:""});');
    assert.equal(whole.details.result, source, "An empty about still falls back to the whole text read");
  } finally {
    catalog.resolve([]);
    listing.mock.restore();
    await running;
  }
});


it("canonical locator paths work through workspace aliases without widening indexed scope", async t => {
  const f = await engineFixture(t);
  const physical = path.join(f.root,"physical"), alias = path.join(f.root,"alias");
  await fs.mkdir(path.join(physical,"scope"),{recursive:true});
  await fs.symlink(physical,alias,"junction");
  const source = 'export function located() { return 1; }\n';
  await fs.writeFile(path.join(physical,"scope","a.js"),source);
  await fs.writeFile(path.join(physical,"outside.js"),source);
  let locator = await fs.realpath(path.join(physical,"scope","a.js"));

  f.pi.registerTool({name:"isearch",annotations:{readOnlyHint:true},parameters:{type:"object"},execute:async()=>({content:[],details:{code:"OK",contexts:[{path:locator,startLine:1,endLine:1}]}})});
  const execute = code => f.tool.execute("aliased-indexed",{code},undefined,undefined,{cwd:alias});
  const result = await execute('const view = await read({path:"scope",query:"located",indexed:true}); await edit(view,"return 1","return 2"); return view;');
  assert.equal(result.details.result.path,"scope/a.js");
  assert.equal(result.details.result.text,source);
  assert.equal(await fs.readFile(path.join(physical,"scope","a.js"),"utf8"),source.replace("return 1","return 2"));
  locator = await fs.realpath(path.join(physical,"outside.js"));
  await assert.rejects(execute('return await read({path:"scope",query:"located",indexed:true});'),/scope|workspace/);
  await fs.symlink(path.join(physical,"outside.js"),path.join(physical,"scope","escape.js"));
  locator = path.join(alias,"scope","escape.js");
  await assert.rejects(execute('return await read({path:"scope",query:"located",indexed:true});'),/scope|workspace/);
});

it("focused outline caller hints match whole dollar-bearing identifiers on disk and staged source", async t => {
  const f = await engineFixture(t);
  const source = "export function alpha() { return 1; }\nexport function $leading() { return 2; }\nexport function trailing$() { return 3; }\n";
  const callers = "$leading();\ntrailing$();\nalpha();\nalpha(); prefix$leading(); trailing$suffix();\n$alpha(); alpha$();\n$leading(); $alpha(); alpha$();\n";
  assert.doesNotThrow(() => new Function(source.replaceAll("export ", "") + callers));
  await f.write("target.js", source);
  await f.write("caller.js", callers);
  const hints = outline => outline.split("\n").filter(line => line.includes("used by:"));
  const disk = (await f.execute('return await read("target.js",{about:"alpha leading trailing"});')).details.result;
  assert.match(disk, /3 expanded/);
  assert.deepEqual(hints(disk), [
    "      // used by: caller.js:3, caller.js:4",
    "      // used by: caller.js:1, caller.js:6",
    "      // used by: caller.js:2",
  ]);

  const pending = "$leading();\ntrailing$();\nalpha();\n";
  const staged = (await f.execute('return await edit(async () => { await write("staged.js",' + JSON.stringify(pending) + '); return await read("target.js",{about:"alpha leading trailing"}); });')).details.result.value;
  assert.deepEqual(hints(staged), [
    "      // used by: caller.js:3, caller.js:4, staged.js:3",
    "      // used by: caller.js:1, caller.js:6, staged.js:1",
    "      // used by: caller.js:2, staged.js:2",
  ]);
  assert.equal(await fs.readFile(path.join(f.root, "target.js"), "utf8"), source);
  assert.equal(await fs.readFile(path.join(f.root, "staged.js"), "utf8"), pending);
});

it("exact method about reads keep the requested body without expanding noisy enclosing classes", async t => {
  const f = await engineFixture(t);

  const source = [
    "export class SliceLibrary {",
    "  usefulSlice(value) {",
    "    return value.trim();",
    "  }",
    "  get(value) {",
    "    return this.usefulSlice(value);",
    "  }",
    "  unrelatedWork() {",
    ...Array(250).fill("    // useful slice context that belongs to unrelated work"),
    "    return false;",
    "  }",
    "}",
    "",
  ].join("\n");

  await f.write("slices.js", source);
  const focused = await f.execute('return await read("slices.js", {about:"usefulSlice"});');
  assert.equal(focused.details.ok, true);
  const text = modelText(focused);
  assert.match(text, /return value\.trim\(\);/, "the exact requested method body must remain available");
  assert.doesNotMatch(text, /context that belongs to unrelated work/, "an enclosing class must not swamp an exact method query");
  assert.match(text, /export class SliceLibrary/, "the enclosing declaration remains navigable");
  assert.match(text, /unrelatedWork\(\).*lines/, "unrequested bodies retain line-based recovery guidance");
  const stopWord = await f.execute('return await read("slices.js", {about:"get"});');
  assert.match(modelText(stopWord), /return this\.usefulSlice\(value\);/, "exact identifiers are not prose stop words");
  const full = await f.execute('return (await read("slices.js", {complete:true})).length;');
  assert.equal(full.details.result, source.length, "focused output must not limit full internal reads");
});

it("late-file focused bodies survive a large declaration map with exact source recovery", async t => {
  const f = await engineFixture(t);

  const prefix = Array.from({length:180}, (_, i) => `export function earlierDeclarationNumber${i}() {\n  return ${i};\n}\n`).join("\n");
  const target = "export function lateTarget(value) {\n  return value.trim();\n}\n";
  await f.write("late.js", prefix + target);
  const focused = await f.execute('return await read("late.js", {about:"lateTarget"});');
  assert.equal(focused.details.ok, true);
  const text = modelText(focused);
  assert.ok(text.includes("return value.trim();"), "the display budget must retain the requested late-file body");
  const location = text.match(/^\s*(\d+) export function lateTarget\(value\) \{/m);
  assert.ok(location, "requested source must retain its real line locator");
  assert.equal(Number(location[1]), prefix.split("\n").length);
  assert.ok(text.includes("earlierDeclarationNumber0"), "navigation remains available after the focused body");
  assert.ok(text.includes("outline truncated"), "omitted navigation must be disclosed");
  const recovered = await f.execute(`return await read("late.js", {offset:${location[1]},limit:3});`);
  assert.equal(recovered.details.result, target, "the emitted line locator must recover exact source bytes");
});


it("image reads bound bytes consumed when a file grows after stat", async t => {
  const f = await engineFixture(t);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
  await f.write("growing.png", image);
  const target = path.join(f.root, "growing.png");
  const handle = await fs.open(target, "r"), initial = await handle.stat();
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const stat = prototype.stat, read = prototype.read, readFile = prototype.readFile;
  const limit = 20 * 1024 * 1024;
  let targetFd, consumed = 0;

  const mocks = [
    t.mock.method(prototype, "stat", async function(...args) {
      const observed = await stat.apply(this, args);

      if (targetFd === undefined && observed.ino === initial.ino && observed.dev === initial.dev) {
        targetFd = this.fd;
        await fs.truncate(target, limit + 4 * 1024 * 1024);
      }

      return observed;
    }),
    t.mock.method(prototype, "read", async function(...args) {
      const result = await read.apply(this, args);

      if (this.fd === targetFd) consumed += result.bytesRead;

      return result;
    }),
    t.mock.method(prototype, "readFile", async function(...args) {
      const result = await readFile.apply(this, args);

      if (this.fd === targetFd) consumed += result.length;

      return result;
    }),
  ];

  try {
    await assert.rejects(f.execute('return await read("growing.png");'), /file changed while reading|image read limit/);
  } finally { for (const mock of mocks) mock.mock.restore(); }

  assert.ok(consumed > image.length, "the test must exercise growth after the size observation");
  assert.ok(consumed <= limit + 1, "image I/O must stop at the byte limit plus one overflow byte, not buffer the grown file");
  assert.equal((await fs.stat(target)).size, limit + 4 * 1024 * 1024);
});
