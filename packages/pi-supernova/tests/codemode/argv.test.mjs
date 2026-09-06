import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture, limits } from "../helpers/engine.mjs";
import { runGuestProgram } from "../../src/runtime/runtime.js";
import fs from "node:fs/promises";
import path from "node:path";

it("argv capability negotiation preserves legacy and delegated executor arguments", async () => {
  for (const nativeArgv of [undefined,true]) {
    const result = await runGuestProgram({code:'return await bash({command:"printf",args:["%s","$HOME"]});',config:limits,nova:{
      nativeArgv,
      async call(name,args) {
        assert.equal(name,"bash");
        assert.deepEqual(args.args,["%s","$HOME"]);
        assert.equal(args._directArgv,nativeArgv);
        return {ok:true,value:args.command};
      },
    }});
    assert.equal(result.ok,true,result.error);
    assert.equal(result.result,nativeArgv ? "printf" : "'printf' '%s' '$HOME'");
  }
});

it("literal argv bypasses shell startup while string commands retain it", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const startup = path.join(f.root,"startup.sh");
  const marker = path.join(f.root,"shell-started");
  await f.write("startup.sh", "printf started > " + JSON.stringify(marker));
  const before = process.env.BASH_ENV;
  process.env.BASH_ENV = startup;
  try {
    const result = await f.execute('return await bash({command:process.execPath,args:["-e",'+JSON.stringify('process.stdout.write("literal")')+']});');
    assert.equal(result.details.result,"literal");
    await assert.rejects(fs.stat(marker),{code:"ENOENT"});
    assert.equal((await f.execute('return await bash("printf shell");')).details.result,"shell");
    assert.equal(await fs.readFile(marker,"utf8"),"started");
    const payload = 'const unused="'+"long-argument-".repeat(300)+'"; console.error("argv diagnostic"); process.exit(7);';
    await assert.rejects(f.execute('return await bash({command:process.execPath,args:["-e",'+JSON.stringify(payload)+']});'),error=>{
      assert.match(error.message,/exit 7/);
      assert.match(error.message,/argv diagnostic/);
      assert.ok(!error.message.includes("long-argument-"),"do not echo the caller's entire program in an error");
      return true;
    });
    const sleeping = payload.replace("process.exit(7)","setInterval(()=>{},1000)");
    await assert.rejects(f.execute('return await bash({command:process.execPath,args:["-e",'+JSON.stringify(sleeping)+'],timeoutMs:100});'),error=>{
      assert.match(error.message,/timed out/);
      assert.ok(!error.message.includes("long-argument-"));
      return true;
    });
  } finally {
    if (before === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = before;
  }
});

it("bash retains literal argv execution without an exec alias or argument mutation", async t => {
  const f = await engineFixture(t);
  const literal = "$(printf injected); 'quoted' $HOME";
  const args = { command: "printf", args: ["%s", literal] };
  const result = await f.execute(`
    const args = ${JSON.stringify(args)};
    const first = await bash(args);
    const second = await bash(args);
    return {first,second,args,alias:typeof exec};
  `);
  assert.deepEqual(result.details.result, { first: literal, second: literal, args, alias: "undefined" });
  const boxed = await f.execute('return await bash({command:new String("printf"),args:["%s","boxed"]});');
  assert.equal(boxed.details.result,"boxed");
});
