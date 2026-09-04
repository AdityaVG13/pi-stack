import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHostBridge } from "../host-bridge.js";
import { profileQuery, stem } from "../evidence.js";

const FIXTURE = {
  "src/auth.js": [
    "import { hashToken } from \"./crypto.js\";",
    "",
    "export function verifySession(token) {",
    "  const digest = hashToken(token);",
    "  return digest.length > 0;",
    "}",
    "",
    "export function refreshSession(token) {",
    "  return verifySession(token) ? hashToken(token + \"1\") : null;",
    "}",
  ].join("\n"),
  "src/crypto.js": ["export function hashToken(token) {", "  return \"h:\" + token;", "}"].join("\n"),
  "src/server.js": [
    "import { verifySession } from \"./auth.js\";",
    "",
    "export function handleRequest(req) {",
    "  if (!verifySession(req.token)) return 401;",
    "  return 200;",
    "}",
    "",
    "export function unrelatedHelper() {",
    "  return 42;",
    "}",
  ].join("\n"),
  "README.md": "# verifySession\n\nverifySession checks the session token.",
  "test/auth.test.js": "import { verifySession } from '../src/auth.js';\nverifySession('x');",
};

async function fixtureBridge() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-"));
  for (const [rel, text] of Object.entries(FIXTURE)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text + "\n");
  }
  const bridge = createHostBridge({ pi: null, config: { maxCallResultChars: 100000, maxBridgeCalls: 1000 }, getCwd: () => dir });
  const evidence = async (query, extra = {}) => JSON.parse((await bridge.call("evidence", { query, ...extra })).value);
  return { dir, evidence };
}

describe("zero-token evidence selection", () => {
  it("routes identifier questions to the graph view and plain questions to the hierarchy", () => {
    assert.equal(profileQuery("how does verifySession work").route, "relational");
    assert.equal(profileQuery("who calls verifySession").answerType, "usage");
    assert.equal(profileQuery("where is the request handled").route, "local");
    assert.equal(stem("terminated"), stem("terminate"));
  });

  it("ranks the definition first and brings its dependency as a bridge", async () => {
    const { dir, evidence } = await fixtureBridge();
    try {
      const r = await evidence("how does verifySession work");
      assert.equal(r.spans[0].path, "src/auth.js");
      assert.equal(r.spans[0].name, "verifySession");
      assert.deepEqual(r.spans[0].lines, [3, 6]);
      assert.ok(r.spans.some((s) => s.name === "hashToken"), "definition of the called helper is included");
      assert.ok(!r.spans.some((s) => s.path.endsWith(".md")), "docs excluded unless asked");
      assert.ok(!r.spans.some((s) => s.path.startsWith("test/")), "tests excluded unless asked");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("answers a usage question with the caller ahead of the definition", async () => {
    const { dir, evidence } = await fixtureBridge();
    try {
      const r = await evidence("who calls verifySession");
      const names = r.spans.filter((s) => s.why === "main").map((s) => s.name);
      // The declaration has no use lines, so the definer is absent or ranked after every caller.
      const definer = names.includes("verifySession") ? names.indexOf("verifySession") : Infinity;
      assert.ok(names.indexOf("handleRequest") < definer, names.join(","));
      assert.ok(names.indexOf("refreshSession") < definer, names.join(","));
      assert.ok(!names.includes("unrelatedHelper"), "spans without lexical support are not evidence");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns exact source slices with provenance and honours the text budget", async () => {
    const { dir, evidence } = await fixtureBridge();
    try {
      const r = await evidence("verifySession", { maxChars: 120 });
      assert.ok(r.spans.length >= 1);
      let total = 0;
      for (const s of r.spans) {
        const file = await fs.readFile(path.join(dir, s.path), "utf8");
        const slice = file.split("\n").slice(s.lines[0] - 1, s.lines[1]).join("\n");
        assert.ok(slice.startsWith(s.text.replace(/…$/, "")), "text is a verbatim slice of the cited lines");
        total += s.text.length;
      }
      assert.ok(total <= 121, "budget respected (allowing the ellipsis)");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
