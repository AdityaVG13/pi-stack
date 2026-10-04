import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fs from "node:fs";
import { backupPathFor, planOrphanSweep, planProviderUpdate, readModelsFile, writeModelsFile, MANAGED_BY } from "../lib/store.js";
import { tempDir } from "./helpers.mjs";

function owned(entry) {
  return { ...entry, _managedBy: MANAGED_BY };
}

describe("models.json store", () => {
  test("reads missing files as empty, refuses corrupt ones", () => {
    const dir = tempDir();

    assert.deepEqual(readModelsFile(join(dir, "models.json"), fs), { providers: {} });
    writeFileSync(join(dir, "bad.json"), "{nope", "utf8");
    assert.throws(() => readModelsFile(join(dir, "bad.json"), fs), /corrupt/);
    writeFileSync(join(dir, "odd.json"), "[1]", "utf8");
    assert.throws(() => readModelsFile(join(dir, "odd.json"), fs), /corrupt/);
  });

  test("reads Pi JSONC models.json (BOM, comments, trailing commas)", () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      "\uFEFF{\n  // hand-written gateway\n  \"providers\": {\n    \"demo\": { \"models\": [{ \"id\": \"hand\", \"name\": \"keep // comment-like\" }] },\n  },\n}\n",
      "utf8",
    );

    const doc = readModelsFile(path, fs);

    assert.equal(doc.providers.demo.models[0].id, "hand");
    assert.equal(doc.providers.demo.models[0].name, "keep // comment-like");
  });

  test("adds, updates, keeps, and prunes only tagged entries on success", () => {
    const doc = {
      providers: {
        demo: {
          modelOverrides: { keep: { contextWindow: 1 } },
          models: [
            owned({ id: "same", contextWindow: 5 }),
            owned({ id: "stale", contextWindow: 5 }),
            { id: "hand", contextWindow: 5 },
            owned({ id: "gone", contextWindow: 5 }),
          ],
        },
      },
    };

    const plan = planProviderUpdate(
      doc,
      "demo",
      [{ id: "same", contextWindow: 5 }, { id: "stale", contextWindow: 9 }, { id: "hand", contextWindow: 99 }, { id: "new", contextWindow: 1 }],
      true,
    );

    assert.deepEqual([plan.added, plan.updated, plan.removed, plan.kept], [1, 1, 1, 2]);
    const models = plan.next.providers.demo.models;
    assert.equal(models.find((m) => m.id === "hand").contextWindow, 5);
    assert.equal(models.find((m) => m.id === "stale").contextWindow, 9);
    assert.equal(models.find((m) => m.id === "gone"), undefined);
    assert.equal(models.find((m) => m.id === "new")._managedBy, MANAGED_BY);
    assert.deepEqual(plan.next.providers.demo.modelOverrides, { keep: { contextWindow: 1 } });
  });

  test("duplicate untagged entries retain their field values", () => {
    const doc = {
      providers: { demo: { models: [{ id: "dup", contextWindow: 5 }, { id: "dup", contextWindow: 5 }] } },
    };

    const plan = planProviderUpdate(doc, "demo", [{ id: "dup", contextWindow: 5 }], true);

    assert.deepEqual(plan.next.providers.demo.models, [{ id: "dup", contextWindow: 5 }, { id: "dup", contextWindow: 5 }]);
    assert.equal(plan.removed, 0);
  });

  test("failed discovery changes nothing; orphans sweep only what left", () => {
    const stale = { providers: { demo: { models: [owned({ id: "old" })] } } };
    const frozen = planProviderUpdate(stale, "demo", [], false);

    assert.deepEqual([frozen.added, frozen.updated, frozen.removed, frozen.kept], [0, 0, 0, 1]);
    assert.deepEqual(frozen.next, stale);

    const doc = {
      providers: {
        ghost: { models: [owned({ id: "a" }), { id: "hand" }] },
        husk: { models: [owned({ id: "b" })] },
        shell: { baseUrl: "https://k.test", models: [owned({ id: "c" })] },
        user: { models: [{ id: "u" }] },
        live: { models: [owned({ id: "d" })] },
      },
    };

    const plan = planOrphanSweep(doc, ["live"]);

    assert.deepEqual(plan.swept, [
      { providerId: "ghost", removed: 1 },
      { providerId: "husk", removed: 1 },
      { providerId: "shell", removed: 1 },
    ]);
    assert.deepEqual(plan.next.providers.ghost.models, [{ id: "hand" }]);
    assert.equal(plan.next.providers.husk, undefined);
    assert.deepEqual(plan.next.providers.shell, { baseUrl: "https://k.test", models: [] });
    assert.deepEqual(plan.next.providers.user.models, [{ id: "u" }]);
    assert.deepEqual(plan.next.providers.live.models, [owned({ id: "d" })]);
  });

  test("does not write chat entries whose id would fail Pi schema", () => {
    const plan = planProviderUpdate({ providers: {} }, "demo", [{ id: "" }, { id: "fresh" }], true);

    assert.equal(plan.added, 1);
    assert.deepEqual(plan.next.providers.demo.models.map((model) => model.id), ["fresh"]);
  });

  test("does not overlay chat ids already composed outside models.json", () => {
    const created = planProviderUpdate({ providers: {} }, "demo", [{ id: "seed" }, { id: "fresh" }], true, ["seed"]);

    assert.equal(created.added, 1);
    assert.deepEqual(created.next.providers.demo.models.map((model) => model.id), ["fresh"]);

    const managed = planProviderUpdate(
      { providers: { demo: { models: [owned({ id: "seed", contextWindow: 1 })] } } },
      "demo",
      [{ id: "seed", contextWindow: 2 }],
      true,
      ["seed"],
    );

    assert.equal(managed.updated, 1);
    assert.equal(managed.next.providers.demo.models[0].contextWindow, 2);
  });

  test("successful prune of the last managed chat models drops empty husk sections", () => {
    const husk = { providers: { demo: { models: [owned({ id: "old" })] } } };
    const plan = planProviderUpdate(husk, "demo", [], true);

    assert.equal(plan.removed, 1);
    assert.equal(plan.next.providers.demo, undefined);

    const shell = { providers: { demo: { baseUrl: "https://k.test", models: [owned({ id: "old" })] } } };
    const kept = planProviderUpdate(shell, "demo", [], true);

    assert.equal(kept.removed, 1);
    assert.deepEqual(kept.next.providers.demo, { baseUrl: "https://k.test", models: [] });
  });

  test("writes back up first and never clobber", () => {
    const dir = tempDir();
    const path = join(dir, "models.json");
    writeFileSync(path, '{"providers":{}}', "utf8");
    const { backupPath } = writeModelsFile(path, { providers: { a: { models: [] } } }, fs);

    assert.match(backupPath, /models\.json\.bak-20\d{6}T\d{6}Z$/);
    assert.equal(readFileSync(backupPath, "utf8"), '{"providers":{}}');
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).providers.a, { models: [] });
    assert.equal(backupPathFor(path, new Date("2026-01-02T03:04:05Z")), `${path}.bak-20260102T030405Z`);

    const rerun = tempDir();
    const rerunPath = join(rerun, "models.json");
    writeFileSync(rerunPath, '{"v":1}', "utf8");

    const first = writeModelsFile(rerunPath, { v: 2 }, fs);
    const second = writeModelsFile(rerunPath, { v: 3 }, fs);

    assert.notEqual(first.backupPath, second.backupPath);
    assert.equal(readFileSync(first.backupPath, "utf8"), '{"v":1}');
    assert.equal(readFileSync(second.backupPath, "utf8"), JSON.stringify({ v: 2 }, null, 2) + "\n");
  });
});


test("keeps the original models file when a write fails partway", () => {
  const dir = tempDir();
  const path = join(dir, "models.json");
  const original = '{"providers":{},"user":"keep exactly"}\n';
  writeFileSync(path, original, { mode: 0o600 });

  const failing = { ...fs, writeFileSync(target, value, options) {
    fs.writeFileSync(target, value.slice(0, 8), options);
    throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
  } };

  assert.throws(() => writeModelsFile(path, { providers: { added: { models: [] } } }, failing), /disk full/);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

test("backup destination races never overwrite the earlier backup", () => {
  const dir = tempDir();
  const path = join(dir, "models.json");
  writeFileSync(path, '{"version":1}');
  let first;

  const racing = { ...fs, copyFileSync(from, to, flags) {
    if (first === undefined) {
      first = to;
      writeFileSync(to, "concurrent backup");
    }

    return fs.copyFileSync(from, to, flags);
  } };

  const result = writeModelsFile(path, { version: 2 }, racing);
  assert.equal(readFileSync(first, "utf8"), "concurrent backup");
  assert.notEqual(result.backupPath, first);
  assert.equal(readFileSync(result.backupPath, "utf8"), '{"version":1}');
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
});


test("publication preserves symlinks and existing permissions", () => {
  const dir = tempDir();
  const target = join(dir, "real-models.json");
  const link = join(dir, "models.json");
  writeFileSync(target, '{"version":1}', { mode: 0o600 });
  fs.symlinkSync("real-models.json", link);
  const result = writeModelsFile(link, { version: 2 }, fs);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).version, 2);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(readFileSync(result.backupPath, "utf8"), '{"version":1}');
  assert.equal(fs.readdirSync(dir).some(name => name.includes(".tmp-")), false);
});


test("chat sync preserves mixed model types with colliding ids", () => {
  const image = Object.freeze({ id: "shared", type: "image", name: "User image" });
  const classifier = Object.freeze(owned({ id: "classifier-collision", type: "classifier", labels: ["A", "B"] }));
  const managedImage = Object.freeze(owned({ id: "image-only", type: "image" }));

  const doc = { providers: { demo: { models: [
    image, owned({ id: "shared", type: "chat", contextWindow: 4 }), classifier,
    owned({ id: "stale-chat" }), managedImage,
  ] } } };

  const before = structuredClone(doc);

  const plan = planProviderUpdate(doc, "demo", [
    { id: "shared", contextWindow: 8 },
    { id: "classifier-collision", contextWindow: 11 },
    { id: "ignored-image", type: "image" },
  ], true);

  const models = plan.next.providers.demo.models;
  assert.deepEqual([plan.added, plan.updated, plan.removed, plan.kept], [1, 1, 1, 3]);
  assert.equal(models.find(model => model.type === "image" && model.id === "shared"), image);
  assert.equal(models.find(model => model.type === "classifier"), classifier);
  assert.equal(models.find(model => model.id === "image-only"), managedImage);
  assert.equal(models.find(model => model.id === "shared" && !model.type).contextWindow, 8);
  assert.equal(models.find(model => model.id === "classifier-collision" && !model.type).contextWindow, 11);
  assert.ok(!models.some(model => model.id === "stale-chat" || model.id === "ignored-image"));
  assert.deepEqual(doc, before, "planning must not mutate mixed catalogs");
});

test("chat orphan sweep never claims non-chat ownership", () => {
  const image = owned({ id: "same", type: "image" });
  const classifier = owned({ id: "same", type: "classifier" });
  const futureType = owned({ id: "same", type: "future-operation" });
  const doc = { providers: { orphan: { models: [owned({ id: "same" }), image, classifier, futureType] } } };
  const plan = planOrphanSweep(doc, []);
  assert.deepEqual(plan.swept, [{ providerId: "orphan", removed: 1 }]);
  assert.deepEqual(plan.next.providers.orphan.models, [image, classifier, futureType]);
});
