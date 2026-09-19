// Loaded only in the disposable, network-denied OMP child used by verify.mjs.
import fs from "node:fs/promises";
import assert from "node:assert/strict";

export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    // Let startup finish so RPC can process the fixture's real approval replies.
    setImmediate(async () => {
    try {
      const id = ctx.sessionManager.getSessionId();

      const session = pi.pi.AgentRegistry.global().list().map(ref => ref.session)
        .find(session => session.sessionManager.getSessionId() === id);

      const tool = session.getToolForEvalBridge("supernova");

      if (!tool) throw new Error("Supernova is missing from the actual OMP registry");
      const artifactDir=ctx.sessionManager.getArtifactsDir();
      assert.ok(artifactDir,"actual OMP context must expose its artifact directory");
      await fs.mkdir(artifactDir,{recursive:true});
      const payload="resource λ😀\r\n".repeat(600);
      await fs.writeFile(artifactDir+"/SupernovaUriProbe.md",payload);
      await fs.writeFile(artifactDir+"/131.txt","artifact probe");
      await pi.setActiveTools(pi.getActiveTools().filter(name=>name!=="read"));
      const resource=await tool.execute("omp-uri",{code:'return await read(["agent://SupernovaUriProbe","artifact://131"]);'},undefined,undefined,ctx);
      assert.deepEqual(resource.details.result,[payload,"artifact probe"]);
      await fs.writeFile(artifactDir+"/132.json",JSON.stringify({answer:"selected",padding:"x".repeat(50000)}));
      const selected=await tool.execute("omp-json-data",{code:'return [data.literal,await read("artifact://132?q=.answer")];',data:{literal:"literal `backticks` ${braces}"}},undefined,undefined,ctx);
      assert.deepEqual(selected.details.result,["literal `backticks` ${braces}","selected"]);
      const result = await tool.execute("omp-contract", { file:process.env.SUPERNOVA_HOST_PROGRAM }, undefined, undefined, ctx);
      await assert.rejects(tool.execute("omp-failure", { code: 'throw Error("host-failure-sentinel");' }, undefined, undefined, ctx), /host-failure-sentinel/);
      const batch = await tool.execute("omp-batch",{programs:[{code:"return data;",data:false},{code:"return 42;"}]},undefined,undefined,ctx);
      assert.deepEqual(batch.details.result,[false,42]);
      const shared = await tool.execute("omp-shared-batch",{
        code:'data.seen++; return data;',data:{seen:0,literal:"shared λ😀\r\n"},mergeData:true,
        programs:[{data:{job:1}},{data:{job:2}}],
      },undefined,undefined,ctx);
      assert.equal(shared.details.ok,true);
      assert.deepEqual(shared.details.result,[{seen:1,literal:"shared λ😀\r\n",job:1},{seen:1,literal:"shared λ😀\r\n",job:2}]);
      const stopped = await tool.execute("omp-batch-stop",{programs:[{code:'return await read("pixel.png");'},{code:'throw Error("batch-stop");'},{code:"return 9;"}]},undefined,undefined,ctx);
      assert.equal(stopped.details.ok,false); assert.equal(stopped.isError,true); assert.equal(stopped.details.attempted,2);
      assert.ok(stopped.content.some(block=>block.type==="image"));
      await fs.writeFile(process.env.SUPERNOVA_HOST_OUTPUT, JSON.stringify(result));
      process.exit(0);
    } catch (error) {
      await fs.writeFile(process.env.SUPERNOVA_HOST_OUTPUT, JSON.stringify({ error: String(error) }));
      process.exit(1);
    }
    });
  });
}
