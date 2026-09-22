import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES = join(ROOT, "themes");
const HEX = /^#[0-9a-fA-F]{6}$/;
const SECTIONS = ["$schema", "name", "vars", "colors", "export"];

const files = readdirSync(THEMES).filter((f) => f.endsWith(".json"));

function isUsableColorRef(value, vars) {
  if (value === "") return true;
  if (HEX.test(value)) return true;
  return Object.hasOwn(vars, value);
}

describe("theme package", () => {
  it("ships at least one theme", () => {
    assert.ok(files.length >= 1, "themes/ has no .json files");
  });

  it("manifest declares the themes dir", () => {
    const pj = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.ok(
      (pj.pi?.themes || []).includes("./themes"),
      'package.json pi.themes must include "./themes"',
    );
  });
});

for (const file of files) {
  describe(file, () => {
    const theme = JSON.parse(readFileSync(join(THEMES, file), "utf8"));

    it("has required name + colors", () => {
      assert.ok(theme.name.length > 0, "name is empty");
      assert.ok(!theme.name.includes("/"), "name must not contain '/'");
      assert.ok(Object.keys(theme.colors).length > 0, "colors is empty");
    });

    it("has no unknown top-level sections", () => {
      for (const key of Object.keys(theme)) {
        assert.ok(SECTIONS.includes(key), `unknown section: ${key}`);
      }
    });

    it("every var is a hex color", () => {
      for (const [key, value] of Object.entries(theme.vars || {})) {
        assert.match(String(value), HEX, `vars.${key}`);
      }
    });

    it("every color is empty, hex, or a defined var", () => {
      const vars = theme.vars || {};
      for (const [key, value] of Object.entries(theme.colors)) {
        assert.ok(isUsableColorRef(value, vars), `colors.${key} = ${JSON.stringify(value)}`);
      }
    });
  });
}
