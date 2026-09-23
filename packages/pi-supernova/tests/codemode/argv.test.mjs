import { it } from "node:test";
import assert from "node:assert/strict";
import { engineFixture } from "../helpers/engine.mjs";
import { runCommand } from "../../src/fs/workspace.js";
import fs from "node:fs/promises";
import path from "node:path";

it("literal arguments stay literal when a host overrides the shell executor", async t => {
  const f = await engineFixture(t);
  let delegated = 0;
  f.pi.registerTool({name:"bash", async execute(_id, args, signal, _update, ctx) {
    delegated++;
    const result = await runCommand(["bash", "-c", args.command], {cwd:ctx.cwd, signal});

    return {content:[{type:"text",text:result.stdout}],isError:result.exitCode !== 0};
  }});
  const literal = "$HOME; $(touch injected) 'quoted' &|<>()%PATH%";
  const result = await f.execute(`return await bash({command:process.execPath,args:["-e","process.stdout.write(process.argv[1])",${JSON.stringify(literal)}]});`);
  assert.equal(result.details.result, literal);
  assert.equal(delegated,0,"literal argv must not enter an overridden shell executor");
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

it("literal-argv bash honors cwd from a second options argument", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "sub"));
  const result = await f.execute(`return await bash({command:process.execPath,args:["-e","process.stdout.write(process.cwd())"]},{cwd:"sub"});`);

  assert.equal(result.details.result.trim(), await fs.realpath(path.join(f.root, "sub")));
});

it("object-form bash keeps its own cwd over a second options argument", async t => {
  const f = await engineFixture(t);
  await fs.mkdir(path.join(f.root, "sub"));
  const result = await f.execute(`return await bash({command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:"sub"},{cwd:"."});`);

  assert.equal(result.details.result.trim(), await fs.realpath(path.join(f.root, "sub")));
});

it("invalid shell inputs do not flush staged files or count as external attempts", async t => {
  const f = await engineFixture(t);

  const invalid = [
    '{command:"true",timeoutMs:0}', '{command:"true",timeoutMs:NaN}',
    '{command:"true",timeout:-1}', '{command:"true\\0"}',
    '{command:process.execPath,args:["-e","bad\\0argument"]}',
  ];

  for (const [i, args] of invalid.entries()) {
    const file = `uncommitted-${i}.txt`;
    await assert.rejects(f.execute(`await write(${JSON.stringify(file)},"pending"); await bash(${args});`), error => {
      assert.match(error.message, /positive finite number|null bytes/);
      assert.equal(error.supernovaResult.details.mutations.committed, 0);
      assert.equal(error.supernovaResult.details.mutations.external, 0);
      assert.equal(error.supernovaResult.details.mutations.rolledBack, 1);

      return true;
    });
    await assert.rejects(fs.stat(path.join(f.root, file)), {code:"ENOENT"});
  }
});

it("shell syntax failures explain literal argv without rerunning or rewriting the command", async t => {
  const f = await engineFixture(t);
  const command = 'python3 -c "\nprint(f"nested ({1})")\n"';
  await assert.rejects(f.execute(`return await bash(${JSON.stringify(command)});`), error => {
    assert.match(error.message, /syntax error/);
    assert.match(error.message, /literal argv/);
    assert.match(error.message, /data\.script/);
    assert.equal(error.supernovaResult.details.mutations.external, 1);

    return true;
  });
  // The suggested argv route preserves the embedded quotes and shell metacharacters.
  const script = 'process.stdout.write("nested ($HOME) \'quoted\'")';
  const result = await f.execute(`return await bash({command:process.execPath,args:["-e",${JSON.stringify(script)}]});`);
  assert.equal(result.details.result, "nested ($HOME) 'quoted'");
});

it("a quoted executable path is passed to the shell unchanged", {skip:process.platform === "win32"}, async t => {
  const f = await engineFixture(t);
  await f.write("quoted executable", "#!/bin/sh\nprintf quoted-path-ok\n");
  await fs.chmod(path.join(f.root, "quoted executable"), 0o755);
  const result = await f.execute(`return await bash(${JSON.stringify("'./quoted executable'")});`);
  assert.equal(result.details.result, "quoted-path-ok");
});

it("long shell failures keep diagnostics instead of echoing the entire script", async t => {
  const f = await engineFixture(t);
  // Exceed the diagnostic budget, not Windows' 32K process command-line limit.
  const command = "# " + "payload-".repeat(1000) + "\nprintf FINAL_DIAGNOSTIC >&2; exit 7";
  // This checks diagnostic retention, not a two-second shell startup SLA.
  const code = `return await bash(${JSON.stringify(command)});`;
  await assert.rejects(f.tool.execute("long-shell-diagnostics",{code,timeoutMs:10000},undefined,undefined,{cwd:f.root}), error => {
    assert.match(error.message, /exit 7/);
    assert.match(error.message, /FINAL_DIAGNOSTIC/);
    assert.ok(error.message.length < 2000, "a command label must not crowd out the diagnostic");

    return true;
  });
});
