import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  detectThemeMode,
  parseRgbSpec,
  relativeLuminance,
} from "../../packages/pi-tai/src/terminal/ansi-theme/color.ts";

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

test("uses one neutral ANSI color per mode and keeps it out of backgrounds", async () => {
  const backgroundTokens = [
    "selectedBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
  ];

  for (const [mode, neutral, forbidden] of [
    ["dark", 7, 8],
    ["light", 8, 7],
  ] as const) {
    const path = new URL(`../../packages/pi-tai/themes/ansi-${mode}.json`, import.meta.url);
    const theme = JSON.parse(await readFile(path, "utf8")) as {
      vars: Record<string, string | number>;
      colors: Record<string, string | number>;
    };
    const resolve = (value: string | number): string | number =>
      typeof value === "string" && value in theme.vars ? theme.vars[value] : value;

    assert.equal(theme.vars.neutral, neutral);
    assert.equal(theme.vars.uiMuted, 5);
    assert.ok(!Object.values(theme.vars).includes(forbidden));
    assert.equal(resolve(theme.colors.muted), neutral);
    assert.equal(resolve(theme.colors.dim), 5);
    assert.equal(resolve(theme.colors.thinkingText), 5);
    assert.equal(resolve(theme.colors.syntaxComment), neutral);
    for (const token of backgroundTokens) {
      assert.ok(![7, 8].includes(resolve(theme.colors[token]) as number), token);
    }
  }
});

test("pairs panel foregrounds and backgrounds by terminal mode", async () => {
  for (const [mode, background, foreground] of [
    ["dark", 0, 15],
    ["light", 15, 0],
  ] as const) {
    const path = new URL(`../../packages/pi-tai/themes/ansi-${mode}.json`, import.meta.url);
    const theme = JSON.parse(await readFile(path, "utf8")) as {
      vars: Record<string, string | number>;
      colors: Record<string, string | number>;
    };

    assert.equal(theme.vars.panelBg, background);
    assert.equal(theme.vars.panelText, foreground);
    assert.equal(theme.colors.userMessageBg, "panelBg");
    assert.equal(theme.colors.userMessageText, "panelText");
    assert.equal(theme.colors.customMessageBg, "panelBg");
    assert.equal(theme.colors.customMessageText, "panelText");
    assert.equal(theme.colors.toolPendingBg, "panelBg");
    assert.equal(theme.colors.toolSuccessBg, "panelBg");
    assert.equal(theme.colors.toolErrorBg, "panelBg");
    assert.equal(theme.colors.toolTitle, "panelText");
    assert.equal(theme.colors.toolOutput, "panelText");
  }
});
