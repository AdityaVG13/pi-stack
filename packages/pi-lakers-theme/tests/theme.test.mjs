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

function resolveColor(value, vars) {
  if (value === "" || HEX.test(value)) return String(value).toLowerCase();
  if (!Object.hasOwn(vars, value)) return String(value).toLowerCase();
  return String(vars[value]).toLowerCase();
}

function srgbChannel(hex2) {
  const c = parseInt(hex2, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const h = String(hex).replace("#", "");
  const r = srgbChannel(h.slice(0, 2));
  const g = srgbChannel(h.slice(2, 4));
  const b = srgbChannel(h.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
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

    it("scrollbar track is not the page background", () => {
      // Pi paints scrollbarTrack as a foreground glyph. Matching the page
      // background (export.pageBg / vars.black) makes the track disappear.
      if (theme.colors.scrollbarTrack === undefined) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      const track = resolveColor(theme.colors.scrollbarTrack, vars);
      assert.notEqual(
        track,
        page,
        `colors.scrollbarTrack resolves to ${track}, same as the page background`,
      );
    });

    it("prompt border contrasts with the page background", () => {
      // Pi paints colors.border as a foreground glyph (composer, loaders).
      // purple_deep is a raised-surface fill -- 1.36:1 on black, so the box vanishes.
      if (theme.colors.border === undefined) return;
      if (!HEX.test(String(theme.export?.pageBg ?? theme.vars?.black ?? ""))) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      const border = resolveColor(theme.colors.border, vars);
      if (!HEX.test(border) || !HEX.test(page)) return;

      const ratio = contrastRatio(border, page);
      assert.ok(
        ratio >= 3,
        `colors.border ${border} vs page ${page} contrast ${ratio.toFixed(2)}:1 (need 3:1)`,
      );
    });

    it("highlighted border contrasts with the page background", () => {
      // Pi paints colors.borderAccent as FG: tree compaction labels, HTML
      // export titles (.header h1, .tree-compaction). Official Lakers purple
      // is 1.98:1 on black, so highlighted chrome and export headings vanish.
      if (theme.colors.borderAccent === undefined) return;
      if (!HEX.test(String(theme.export?.pageBg ?? theme.vars?.black ?? ""))) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      const accent = resolveColor(theme.colors.borderAccent, vars);
      if (!HEX.test(accent) || !HEX.test(page)) return;

      const ratio = contrastRatio(accent, page);
      assert.ok(
        ratio >= 3,
        `colors.borderAccent ${accent} vs page ${page} contrast ${ratio.toFixed(2)}:1 (need 3:1)`,
      );
    });

    it("scrollbar thumb contrasts with the page background", () => {
      // Pi paints scrollbarThumb as a foreground glyph (fallback: text).
      // Official Lakers purple is too dark on black -- the thumb disappears.
      if (theme.colors.scrollbarThumb === undefined) return;
      if (!HEX.test(String(theme.export?.pageBg ?? theme.vars?.black ?? ""))) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      const thumb = resolveColor(theme.colors.scrollbarThumb, vars);
      if (!HEX.test(thumb) || !HEX.test(page)) return;

      const ratio = contrastRatio(thumb, page);
      assert.ok(
        ratio >= 3,
        `colors.scrollbarThumb ${thumb} vs page ${page} contrast ${ratio.toFixed(2)}:1 (need 3:1)`,
      );
    });

    it("thinking-low composer border contrasts with the page background", () => {
      // Pi sets editor.borderColor from getThinkingBorderColor(level), not colors.border.
      // plum was a raised-surface fill -- 2.74:1 on black, same luminance as thinkingOff,
      // so the prompt box vanishes at thinking=low and is indistinguishable from off.
      if (theme.colors.thinkingLow === undefined) return;
      if (!HEX.test(String(theme.export?.pageBg ?? theme.vars?.black ?? ""))) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      const low = resolveColor(theme.colors.thinkingLow, vars);
      if (!HEX.test(low) || !HEX.test(page)) return;

      const ratio = contrastRatio(low, page);
      assert.ok(
        ratio >= 3,
        `colors.thinkingLow ${low} vs page ${page} contrast ${ratio.toFixed(2)}:1 (need 3:1)`,
      );
    });

    it("thinking-medium composer border contrasts with the page background", () => {
      // Pi sets editor.borderColor from getThinkingBorderColor(level), not colors.border.
      // thinkingMedium is official Lakers purple -- 1.98:1 on black, so the prompt box vanishes.
      if (theme.colors.thinkingMedium === undefined) return;
      if (!HEX.test(String(theme.export?.pageBg ?? theme.vars?.black ?? ""))) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      const medium = resolveColor(theme.colors.thinkingMedium, vars);
      if (!HEX.test(medium) || !HEX.test(page)) return;

      const ratio = contrastRatio(medium, page);
      assert.ok(
        ratio >= 3,
        `colors.thinkingMedium ${medium} vs page ${page} contrast ${ratio.toFixed(2)}:1 (need 3:1)`,
      );
    });

    it("markdown quote border and hr contrast with the page background", () => {
      // Pi paints mdQuoteBorder / mdHr as foreground glyphs (blockquote bar, ---).
      // purple_deep is a raised-surface fill -- 1.36:1 on black, so the chrome vanishes.
      if (!HEX.test(String(theme.export?.pageBg ?? theme.vars?.black ?? ""))) return;

      const vars = theme.vars || {};
      const page = resolveColor(theme.export?.pageBg ?? vars.black ?? "", vars);
      if (!HEX.test(page)) return;

      for (const key of ["mdQuoteBorder", "mdHr"]) {
        if (theme.colors[key] === undefined) continue;
        const token = resolveColor(theme.colors[key], vars);
        if (!HEX.test(token)) continue;
        const ratio = contrastRatio(token, page);
        assert.ok(
          ratio >= 3,
          `colors.${key} ${token} vs page ${page} contrast ${ratio.toFixed(2)}:1 (need 3:1)`,
        );
      }
    });
  });
}
