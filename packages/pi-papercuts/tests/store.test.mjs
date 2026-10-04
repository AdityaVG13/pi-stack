import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as store from "../lib/store.js";
import { spawnSync } from "node:child_process";

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


test("ID encoding distinguishes tag lists and lone surrogate strings", () => {
  const id = (text, tags) => store.cutId("2026-01-01T00:00:00.000Z", "pi", text, "minor", tags);
  assert.notEqual(id("same", ["a,b"]), id("same", ["a", "b"]));
  assert.equal(id("same", ["b", "a"]), id("same", ["a", "b"]));
  assert.equal(new Set(["\uD800", "\uDC00", "\uFFFD"].map((text) => id(text, []))).size, 3);
  const found = store.matchIds([{ id: "pc_abcdef123456" }], ["PC_ABCDEF"]);
  assert.equal(found.found[0]?.id, "pc_abcdef123456");
});

test("append after a torn tail preserves every newly acknowledged event", () => {
  const file = path.join(tmp(), "log.jsonl");
  fs.writeFileSync(file, '{"kind":"cut","id":"incomplete');
  store.appendEvents(file, [{ kind: "cut", id: "pc_aabbccddeeff" }]);
  const result = store.readEvents(file);
  assert.equal(result.tornLines, 1);
  assert.deepEqual(result.events, [{ kind: "cut", id: "pc_aabbccddeeff" }]);
});

test("prune never acknowledges then loses an append in its read-to-rename window", async () => {
  const { default: mutableFs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const file = path.join(tmp(), "log.jsonl");
  store.appendEvents(file, [
    { kind: "cut", id: "pc_aaaaaaaaaaaa" },
    { kind: "resolve", id: "pc_aaaaaaaaaaaa" },
    { kind: "cut", id: "pc_bbbbbbbbbbbb" },
  ]);
  const concurrent = [{ kind: "cut", id: "pc_cccccccccccc" }, { kind: "resolve", id: "pc_bbbbbbbbbbbb" }];
  const write = mutableFs.writeFileSync;
  let interrupted = false;
  let blocked = false;
  mutableFs.writeFileSync = function (target, ...args) {
    if (!interrupted && String(target).includes(".tmp-prune-")) {
      interrupted = true;

      try { store.appendEvents(file, concurrent); }
      catch (error) {
        assert.equal(error.code, "busy");
        blocked = true;
      }
    }

    return write.call(this, target, ...args);
  };

  syncBuiltinESMExports();
  let receipt;

  try { receipt = store.prune(file); }
  finally { mutableFs.writeFileSync = write; syncBuiltinESMExports(); }

  assert.ok(interrupted, "exercise the actual rewrite window");

  if (blocked) store.appendEvents(file, concurrent);
  const events = [...store.readEvents(file).events, ...store.readEvents(receipt.archiveFile).events];

  for (const event of concurrent) assert.ok(events.some((e) => e.kind === event.kind && e.id === event.id));
});

test("prune rejects an archive alias without changing the log", () => {
  const dir = tmp();
  const file = path.join(dir, "log.jsonl");
  store.appendEvents(file, [{ kind: "cut", id: "pc_aaaaaaaaaaaa" }, { kind: "resolve", id: "pc_aaaaaaaaaaaa" }]);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => store.prune(file, { archivePath: file }), /archive.*log/i);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});


test("symlink aliases share locks and hard links cannot bypass them", () => {
  const dir = tmp();
  const file = path.join(dir, "log.jsonl");
  const alias = path.join(dir, "alias.jsonl");
  store.appendEvents(file, [{ kind: "cut", id: "pc_aaaaaaaaaaaa" }]);
  fs.symlinkSync(file, alias);
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: process.pid }));
  assert.throws(() => store.appendEvents(alias, [{ kind: "cut", id: "pc_bbbbbbbbbbbb" }]), { code: "busy" });
  assert.equal(store.readEvents(file).events.length, 1);
  const hard = path.join(dir, "hard.jsonl");
  fs.linkSync(file, hard);
  assert.throws(() => store.appendEvents(hard, [{ kind: "cut", id: "pc_cccccccccccc" }]), /hard-link/);
  assert.equal(store.readEvents(file).events.length, 1);
});

test("write failures release locks and prune heals torn-only logs", () => {
  const file = path.join(tmp(), "log.jsonl");
  const cyclic = { kind: "cut" };
  cyclic.self = cyclic;
  assert.throws(() => store.appendEvents(file, [cyclic]), /circular/i);
  assert.equal(fs.existsSync(file + ".lock"), false);
  fs.writeFileSync(file, '{"bad');
  const receipt = store.prune(file);
  assert.equal(receipt.tornDropped, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "");
  store.appendEvents(file, [{ kind: "cut", id: "pc_aabbccddeeff" }]);
  assert.equal(store.readEvents(file).events.length, 1);
});


test("dangling symlink log paths cannot bypass the future target lock", () => {
  const dir = tmp();
  const file = path.join(dir, "future.jsonl");
  const alias = path.join(dir, "alias.jsonl");
  fs.symlinkSync(file, alias);
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: process.pid }));
  assert.throws(() => store.appendEvents(alias, [{ kind: "cut", id: "pc_aaaaaaaaaaaa" }]), /dangling|busy/i);
  assert.equal(fs.existsSync(file), false);
});


test("prune cannot use its own lock as the archive", () => {
  const file = path.join(tmp(), "log.jsonl");
  store.appendEvents(file, [{ kind: "cut", id: "pc_aaaaaaaaaaaa" }, { kind: "resolve", id: "pc_aaaaaaaaaaaa" }]);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => store.prune(file, { archivePath: file + ".lock" }), { code: "usage" });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(file + ".lock"), false);
});

test("log appends cannot write into the reserved lock namespace", () => {
  const dir = tmp();

  for (const suffix of [".lock", ".LOCK"]) {
    const file = path.join(dir, "reserved" + suffix);
    assert.throws(() => store.appendEvents(file, [{ kind: "cut", id: "pc_aaaaaaaaaaaa" }]), { code: "usage" });
    assert.equal(fs.existsSync(file), false);
  }

  const lock = path.join(dir, "log.jsonl.lock");
  fs.writeFileSync(lock, "lock owner metadata\n");
  const alias = path.join(dir, "alias.jsonl");
  fs.symlinkSync(lock, alias);
  assert.throws(() => store.appendEvents(alias, [{ kind: "cut", id: "pc_aaaaaaaaaaaa" }]), { code: "usage" });
  assert.equal(fs.readFileSync(lock, "utf8"), "lock owner metadata\n");
});

test("review regression: relative environment paths follow the supplied cwd", () => {
  const cwd = tmp();
  assert.equal(store.resolveLogPath({ cwd, env: { PAPERCUTS_FILE: "logs/cuts.jsonl" } }), path.join(cwd, "logs/cuts.jsonl"));
});

test("review regression: FIFO readers fail without blocking", { skip: process.platform === "win32" }, () => {
  const fifo = path.join(tmp(), "blocked.jsonl");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const source = new URL("../lib/store.js", import.meta.url).href;
  const script = `import {readEvents} from ${JSON.stringify(source)};try{readEvents(${JSON.stringify(fifo)});console.log('accepted')}catch(error){console.log(JSON.stringify({code:error.code}))}`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 2000, killSignal: "SIGKILL", encoding: "utf8" });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.equal(JSON.parse(child.stdout).code, "usage");
});

test("review regression: missing logs are empty but devices and directories are refused", () => {
  const dir = tmp();
  assert.deepEqual(store.readEvents(path.join(dir, "missing.jsonl")), { events: [], tornLines: 0 });
  assert.throws(() => store.readEvents(dir));

  if (process.platform !== "win32") assert.throws(() => store.readEvents("/dev/null"), { code: "usage" });
});


test("bulk prefixes preserve query order, ambiguity and longer legacy IDs", () => {
  const a = { id: "pc_abcd00000001" }, b = { id: "pc_f00d00000002" }, longer = { id: "pc_abcd0000000100" }, c = { id: "pc_eeee00000003" };
  const result = store.matchIds([a, b, longer, c], ["EEEE00000003", "f00d00000002", "pc_abcd00000001", "pc_dead00000004", "pc_f00d00000002"]);
  assert.deepEqual(result.found, [c, b]);
  assert.deepEqual(result.ambiguous, [{ prefix: "pc_abcd00000001", ids: [a.id, longer.id] }]);
  assert.deepEqual(result.missing, ["pc_dead00000004"]);
  assert.deepEqual(store.matchIds([a, a], [a.id, a.id]).ambiguous, [
    { prefix: a.id, ids: [a.id, a.id] }, { prefix: a.id, ids: [a.id, a.id] },
  ]);
  assert.deepEqual(store.matchIds([a, b, longer], ["pc_abcd", b.id]).found, [b]);
});


test("prune preserves permissions under a tighter umask", { skip: process.platform === "win32" }, () => {
  const file = path.join(tmp(), "permissions.jsonl");
  const resolved = { kind: "cut", id: "pc_aaaaaaaaaaaa", text: "Resolved" };
  const resolution = { kind: "resolve", id: resolved.id };
  const open = { kind: "cut", id: "pc_bbbbbbbbbbbb", text: "Still open" };
  store.appendEvents(file, [resolved, resolution, open]);
  fs.chmodSync(file, 0o660);
  const previous = process.umask(0o077);
  let receipt;

  try { receipt = store.prune(file); }
  finally { process.umask(previous); }

  assert.equal(fs.statSync(file).mode & 0o777, 0o660);
  assert.deepEqual(store.readEvents(file).events, [open]);
  assert.deepEqual(store.readEvents(receipt.archiveFile).events, [resolved, resolution]);
});
