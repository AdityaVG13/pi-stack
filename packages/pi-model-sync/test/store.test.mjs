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

  test("duplicate untagged entries survive byte-identical", () => {
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
