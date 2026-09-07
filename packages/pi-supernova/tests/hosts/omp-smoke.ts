// Loaded only in the disposable, network-denied OMP child used by verify.mjs.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
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
      const code = await fs.readFile(process.env.SUPERNOVA_HOST_PROGRAM, "utf8");
      const result = await tool.execute("omp-contract", { code }, undefined, undefined, ctx);
      await assert.rejects(tool.execute("omp-failure", { code: 'throw Error("host-failure-sentinel");' }, undefined, undefined, ctx), /host-failure-sentinel/);
      await fs.writeFile(process.env.SUPERNOVA_HOST_OUTPUT, JSON.stringify(result));
      process.exit(0);
    } catch (error) {
      await fs.writeFile(process.env.SUPERNOVA_HOST_OUTPUT, JSON.stringify({ error: String(error) }));
      process.exit(1);
    }
  });
}
