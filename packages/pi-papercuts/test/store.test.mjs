import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as store from "../store.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "papercuts-test-"));
}

test("cutId is deterministic and content-addressed", () => {
  const a = store.cutId("2026-01-01T00:00:00.000Z", "pi", "hello", "minor", ["tooling"]);
  const b = store.cutId("2026-01-01T00:00:00.000Z", "pi", "hello", "minor", ["tooling"]);
  assert.equal(a, b);
  assert.match(a, /^pc_[0-9a-f]{12}$/);
  // tag order does not matter
  const left = store.cutId("2026-01-01T00:00:00.000Z", "pi", "hello", "minor", ["z", "a"]);
  const right = store.cutId("2026-01-01T00:00:00.000Z", "pi", "hello", "minor", ["a", "z"]);
  assert.equal(left, right);
});

test("truncateText stays within 10000 UTF-8 bytes on multi-byte edges", () => {
  const input = "a".repeat(9998) + "😀" + "z"; // 9998 + 4 + 1 = 10003 bytes
  const out = store.truncateText(input);
  assert.ok(Buffer.byteLength(out, "utf-8") <= 10_000);
  assert.ok(!out.includes("\uFFFD"));
});

test("matchIds requires ≥4 hex and reports ambiguity", () => {
  const a = { id: "pc_9f2c00000001" };
  const b = { id: "pc_9f2c00000002" };
  const amb = store.matchIds([a, b], ["pc_9f2c"]);
  assert.equal(amb.found.length, 0);
  assert.equal(amb.ambiguous.length, 1);
  const short = store.matchIds([a], ["pc_9"]);
  assert.deepEqual(short.missing, ["pc_9"]);
  const ok = store.matchIds([a], ["pc_9f2c0000"]);
  assert.equal(ok.found[0].id, a.id);
});

test("resolveLogPath finds the git root .papercuts.jsonl", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "sub", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), "gitdir: /tmp/fake\n"); // .git as file also counts
  const p = store.resolveLogPath({ cwd: path.join(dir, "sub", "deep"), env: {} });
  assert.equal(p, path.join(dir, ".papercuts.jsonl"));
});

test("append + read + fold: open then resolved", () => {
  const dir = tmp();
  const file = path.join(dir, ".papercuts.jsonl");
  const cut = {
    kind: "cut",
    id: store.cutId("2026-01-01T00:00:00.000Z", "pi", "broken thing", "major", ["tooling"]),
    ts: "2026-01-01T00:00:00.000Z",
    agent: "pi",
    text: "broken thing",
    tags: ["tooling"],
    severity: "major",
    cwd: dir,
    repo: dir,
  };
  store.appendEvents(file, [cut]);
  let items = store.fold(store.readEvents(file).events);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "open");

  store.appendEvents(file, [{ kind: "resolve", id: cut.id, ts: "2026-01-02T00:00:00.000Z", agent: "pi", note: "fixed" }]);
  items = store.fold(store.readEvents(file).events);
  assert.equal(items[0].status, "resolved");
  assert.equal(items[0].resolution.note, "fixed");
});

test("readEvents tear-heals malformed lines", () => {
  const dir = tmp();
  const file = path.join(dir, ".papercuts.jsonl");
  fs.writeFileSync(file, '{"kind":"cut","id":"pc_a","ts":"x","agent":"a","text":"t","tags":[],"severity":"minor","cwd":"/","repo":null}\n{"kind":"cut","id":"pc_b"\n');
  const { events, tornLines } = store.readEvents(file);
  assert.equal(events.length, 1);
  assert.equal(tornLines, 1);
});

test("sortItems is severity-first then newest", () => {
  const mk = (id, sev, ts) => ({ id, severity: sev, ts });
  const items = [
    mk("a", "minor", "2026-01-01T00:00:00Z"),
    mk("b", "blocker", "2026-01-01T00:00:00Z"),
    mk("c", "major", "2026-01-03T00:00:00Z"),
    mk("d", "blocker", "2026-01-04T00:00:00Z"),
  ];
  const sorted = store.sortItems(items).map((i) => i.id);
  assert.deepEqual(sorted, ["d", "b", "c", "a"]);
});

test("matchIds resolves unique prefixes and reports misses", () => {
  const items = [{ id: "pc_9f2c41d0a8b3" }, { id: "pc_a81e00000000" }];
  const { found, missing } = store.matchIds(items, ["pc_9f2c", "pc_nope"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "pc_9f2c41d0a8b3");
  assert.deepEqual(missing, ["pc_nope"]);
});

test("parseEvent accepts cut/resolve and rejects illegal kinds", () => {
  const cut = store.parseEvent(JSON.stringify({ kind: "cut", id: "pc_a" }));
  assert.equal(cut.ok, true);
  assert.equal(cut.event.kind, "cut");
  const bad = store.parseEvent(JSON.stringify({ kind: "meta", id: "x" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "illegal_kind");
  const empty = store.parseEvent("   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");
  const junk = store.parseEvent("{not json");
  assert.equal(junk.ok, false);
  assert.equal(junk.reason, "json");
});

test("readEvents only yields parseEvent-ok events", () => {
  const dir = tmp();
  const file = path.join(dir, ".papercuts.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ kind: "cut", id: "pc_1", ts: "t", agent: "a", text: "x", tags: [], severity: "minor", cwd: "/", repo: null }),
      JSON.stringify({ kind: "ghost", id: "pc_2" }),
      "",
      "{broken",
      JSON.stringify({ kind: "resolve", id: "pc_1", ts: "t2", agent: "a", note: null }),
    ].join("\n") + "\n",
  );
  const { events, tornLines } = store.readEvents(file);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.kind === "cut" || e.kind === "resolve"));
  assert.equal(tornLines, 2); // ghost + broken; empty not torn
});

test("matchIds accepts bare hex and rejects non-hex / <4 hex", () => {
  const a = { id: "pc_9f2c00000001" };
  // bare hex (≥4) auto-prefixed
  const bare = store.matchIds([a], ["9f2c00000001"]);
  assert.equal(bare.found[0].id, a.id);
  // non-hex → missing (not first-wins)
  const nonhex = store.matchIds([a], ["pc_zzzz", "pc_9f2g"]);
  assert.deepEqual(nonhex.missing, ["pc_zzzz", "pc_9f2g"]);
  assert.equal(nonhex.found.length, 0);
  // exactly 4 hex unique
  const four = store.matchIds([a], ["pc_9f2c"]);
  assert.equal(four.found[0].id, a.id);
  // 3 hex → missing
  const three = store.matchIds([a], ["pc_9f2"]);
  assert.deepEqual(three.missing, ["pc_9f2"]);
});

test("prune archives resolved events and keeps open cuts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papercuts-prune-"));
  const file = path.join(dir, ".papercuts.jsonl");
  const ts = "2026-01-01T00:00:00.000Z";
  store.appendEvents(file, [
    { kind: "cut", id: "pc_aaaa11112222", ts, agent: "t", text: "open one", tags: [], severity: "minor", cwd: dir, repo: null },
    { kind: "cut", id: "pc_bbbb11112222", ts, agent: "t", text: "resolved one", tags: [], severity: "major", cwd: dir, repo: null },
    { kind: "resolve", id: "pc_bbbb11112222", ts, agent: "t", note: "done" },
  ]);
  const receipt = store.prune(file);
  assert.equal(receipt.archived, 1);
  assert.equal(receipt.archivedEvents, 2);
  assert.equal(receipt.open, 1);
  const after = store.fold(store.readEvents(file).events);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "pc_aaaa11112222");
  assert.equal(after[0].status, "open");
  const archived = store.fold(store.readEvents(receipt.archiveFile).events);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].status, "resolved");
  // idempotent: second prune is a no-op
  const second = store.prune(file);
  assert.equal(second.archivedEvents, 0);
  assert.equal(second.open, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
