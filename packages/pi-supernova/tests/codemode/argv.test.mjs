import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";
import { runCommand } from "../../src/fs/workspace.js";
import fs from "node:fs/promises";
import path from "node:path";

it("literal arguments stay literal when a host overrides the shell executor", async t => {
  const f = await engineFixture(t);
  f.pi.registerTool({name:"bash", async execute(_id, args, signal, _update, ctx) {
    const result = await runCommand(["bash", "-c", args.command], {cwd:ctx.cwd, signal});
    return {content:[{type:"text",text:result.stdout}],isError:result.exitCode !== 0};
  }});
  const literal = "$HOME; $(touch injected) 'quoted'";
  const result = await f.execute(`return await bash({command:"printf",args:["%s",${JSON.stringify(literal)}]});`);
  assert.equal(result.details.result, literal);
  await assert.rejects(fs.stat(path.join(f.root,"injected")), {code:"ENOENT"});
});

it("literal argv bypasses shell startup while string commands retain it", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  const startup = path.join(f.root,"startup.sh");
  const marker = path.join(f.root,"shell-started");
  await f.write("startup.sh", "printf started > " + JSON.stringify(marker));
  const before = Object.fromEntries(["BASH_ENV", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"].map(key => [key, process.env[key]]));
  // SSH detection changes Bash startup rules; test an ordinary noninteractive shell.
  for (const key of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) delete process.env[key];
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
    for (const [key,value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
});
