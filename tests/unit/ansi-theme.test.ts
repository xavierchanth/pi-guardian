import assert from "node:assert/strict";
import test from "node:test";
import {
  detectThemeMode,
  parseRgbSpec,
  relativeLuminance,
} from "../../packages/pi-tai/src/ansi-theme/color.ts";

test("parses OSC RGB specifications", () => {
  assert.equal(parseRgbSpec("rgb:ffff/8000/0000"), "#ff8000");
  assert.equal(parseRgbSpec("rgb:f/0/a"), "#ff00aa");
  assert.equal(parseRgbSpec("not-rgb"), undefined);
});

test("classifies terminal backgrounds by luminance", () => {
  assert.equal(detectThemeMode("#000000"), "dark");
  assert.equal(detectThemeMode("#ffffff"), "light");
  assert.ok(relativeLuminance("#ffffff") > relativeLuminance("#222222"));
  assert.throws(() => relativeLuminance("bad"), /Invalid RGB/);
});
