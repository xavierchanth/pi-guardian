/**
 * ANSI Theme Sync
 *
 * Queries the terminal's live ANSI color palette via OSC 4/10/11 escape
 * sequences at startup, derives a full Pi theme from the results, and
 * activates it via ctx.ui.setTheme().
 *
 * If the query fails or times out (e.g. non-interactive / dumb terminal),
 * the extension does nothing and Pi falls back to its default theme.
 */

import fs from "node:fs";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Constants ───────────────────────────────────────────────────────────────

const THEME_NAME = "ansi-theme";
const QUERY_TIMEOUT_MS = 500;
// 16 ANSI colors + foreground + background
const EXPECTED_RESPONSES = 18;

// ─── OSC Terminal Query ───────────────────────────────────────────────────────

/**
 * Parse an X11 rgb: color spec (rgb:RR/GG/BB or rgb:RRRR/GGGG/BBBB)
 * into a lowercase #rrggbb hex string.
 */
function parseRgbSpec(spec: string): string | null {
	const m = /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(spec);
	if (!m) return null;
	// Terminals may respond with 16-bit precision (4 hex digits per channel).
	// Normalise to 8-bit by taking the top two hex digits.
	const toOctet = (s: string) => parseInt(s.length > 2 ? s.slice(0, 2) : s, 16);
	const [r, g, b] = [toOctet(m[1]), toOctet(m[2]), toOctet(m[3])];
	return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Scan a raw binary buffer for complete OSC responses (BEL or ST terminated)
 * and populate a map keyed by:
 *   "ansi0"–"ansi15" for OSC 4 ; n ; rgb:…
 *   "fg"             for OSC 10 ; rgb:…
 *   "bg"             for OSC 11 ; rgb:…
 */
function parseOscResponses(buf: string): Map<string, string> {
	const result = new Map<string, string>();
	// Match ESC ] … BEL  or  ESC ] … ESC \  (ST)
	const re = /\x1b\]([\s\S]*?)(?:\x07|\x1b\\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(buf)) !== null) {
		const payload = m[1];
		const osc4 = /^4;(\d+);(rgb:[^\x07\x1b;]+)/.exec(payload);
		if (osc4) {
			const hex = parseRgbSpec(osc4[2]);
			if (hex) result.set(`ansi${osc4[1]}`, hex);
			continue;
		}
		const osc10 = /^10;(rgb:[^\x07\x1b;]+)/.exec(payload);
		if (osc10) {
			const hex = parseRgbSpec(osc10[1]);
			if (hex) result.set("fg", hex);
			continue;
		}
		const osc11 = /^11;(rgb:[^\x07\x1b;]+)/.exec(payload);
		if (osc11) {
			const hex = parseRgbSpec(osc11[1]);
			if (hex) result.set("bg", hex);
		}
	}
	return result;
}

/**
 * Open /dev/tty, send batched OSC 4/10/11 queries, read back the responses.
 * Returns null if the terminal doesn't support the queries or on any error.
 */
async function queryAnsiColors(): Promise<Map<string, string> | null> {
	let ttyFd: number;
	try {
		ttyFd = fs.openSync("/dev/tty", "r+");
	} catch {
		return null;
	}

	return new Promise((resolve) => {
		const readStream = new tty.ReadStream(ttyFd);
		let rawModeSet = false;
		let settled = false;

		function finish(colors: Map<string, string> | null) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				if (rawModeSet) readStream.setRawMode(false);
			} catch {}
			readStream.destroy();
			resolve(colors);
		}

		try {
			readStream.setRawMode(true);
			rawModeSet = true;
		} catch {
			readStream.destroy();
			resolve(null);
			return;
		}

		let buf = "";

		const timer = setTimeout(() => {
			const colors = parseOscResponses(buf);
			finish(colors.size > 0 ? colors : null);
		}, QUERY_TIMEOUT_MS);

		readStream.on("data", (chunk: Buffer) => {
			buf += chunk.toString("binary");
			const colors = parseOscResponses(buf);
			if (colors.size >= EXPECTED_RESPONSES) {
				finish(colors);
			}
		});

		readStream.on("error", () => finish(null));

		// Build and send all queries in a single write to minimise latency.
		let queries = "";
		for (let i = 0; i < 16; i++) {
			queries += `\x1b]4;${i};?\x07`;
		}
		queries += "\x1b]10;?\x07"; // foreground
		queries += "\x1b]11;?\x07"; // background

		try {
			fs.writeSync(ttyFd, queries);
		} catch {
			finish(null);
		}
	});
}

// ─── Color Utilities ──────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((c) =>
			Math.round(Math.max(0, Math.min(255, c)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** Linearly blend fgHex over bgHex at the given opacity (0 = all bg, 1 = all fg). */
function blend(bgHex: string, fgHex: string, alpha: number): string {
	const [br, bg, bb] = hexToRgb(bgHex);
	const [fr, fg, fb] = hexToRgb(fgHex);
	return rgbToHex(br + (fr - br) * alpha, bg + (fg - bg) * alpha, bb + (fb - bb) * alpha);
}

/** WCAG relative luminance — used to detect light vs dark backgrounds. */
function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ─── Theme Builder ────────────────────────────────────────────────────────────

function buildTheme(colors: Map<string, string>): object {
	const bg = colors.get("bg") ?? "#1e1e2e";
	const fg = colors.get("fg") ?? "#cdd6f4";

	// Semantic ANSI slots — fall back to bright variant, then a sensible default.
	const c = (key: string, fallback: string) => colors.get(key) ?? fallback;
	const red = c("ansi1", "#f38ba8");
	const green = c("ansi2", "#a6e3a1");
	const yellow = c("ansi3", "#f9e2af");
	const blue = c("ansi4", "#89b4fa");
	const magenta = c("ansi5", "#cba6f7");
	const brightRed = c("ansi9", red);
	const brightBlue = c("ansi12", blue);

	// Background-derived tints — all blends of bg toward fg (or a semantic color)
	// so they naturally respect both light and dark backgrounds.
	const muted = blend(bg, fg, 0.5);
	const dim = blend(bg, fg, 0.35);
	const borderMuted = blend(bg, fg, 0.22);
	const selectedBg = blend(bg, fg, 0.13);
	const userMsgBg = blend(bg, fg, 0.08);
	const toolPendingBg = blend(bg, fg, 0.05);
	const toolSuccessBg = blend(bg, green, 0.14);
	const toolErrorBg = blend(bg, red, 0.14);
	const customMsgBg = blend(bg, blue, 0.08);

	const isDark = relativeLuminance(bg) < 0.5;

	return {
		$schema:
			"https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		name: THEME_NAME,
		vars: {
			bg,
			fg,
			accent: magenta,
			accentAlt: blue,
			link: brightRed,
			error: red,
			success: green,
			warning: yellow,
			muted,
			dim,
			borderMuted,
			selectedBg,
			userMsgBg,
			toolPendingBg,
			toolSuccessBg,
			toolErrorBg,
			customMsgBg,
		},
		colors: {
			accent: "accent",
			border: "link",
			borderAccent: "accent",
			borderMuted: "borderMuted",
			success: "success",
			error: "error",
			warning: "warning",
			muted: "muted",
			dim: "dim",
			text: "",
			thinkingText: "muted",
			selectedBg: "selectedBg",
			userMessageBg: "userMsgBg",
			userMessageText: "",
			customMessageBg: "customMsgBg",
			customMessageText: "",
			customMessageLabel: "accent",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "muted",
			mdHeading: "warning",
			mdLink: "link",
			mdLinkUrl: "dim",
			mdCode: "accent",
			mdCodeBlock: "success",
			mdCodeBlockBorder: "muted",
			mdQuote: "muted",
			mdQuoteBorder: "muted",
			mdHr: "muted",
			mdListBullet: "accent",
			toolDiffAdded: "success",
			toolDiffRemoved: "error",
			toolDiffContext: "muted",
			syntaxComment: "muted",
			syntaxKeyword: "accent",
			syntaxFunction: "link",
			syntaxVariable: "accentAlt",
			syntaxString: "success",
			syntaxNumber: "accent",
			syntaxType: "accentAlt",
			syntaxOperator: "fg",
			syntaxPunctuation: "muted",
			thinkingOff: "borderMuted",
			thinkingMinimal: "muted",
			thinkingLow: "link",
			thinkingMedium: "accentAlt",
			thinkingHigh: "accent",
			thinkingXhigh: "accent",
			bashMode: "success",
		},
		export: {
			pageBg: blend(bg, fg, isDark ? 0.03 : 0.06),
			cardBg: bg,
			infoBg: blend(bg, fg, isDark ? 0.09 : 0.12),
		},
	};
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const baseDir = path.dirname(fileURLToPath(import.meta.url));
	const themePath = path.join(baseDir, `${THEME_NAME}.json`);

	// Query colors before the TUI takes over the terminal.
	const colors = await queryAnsiColors();

	if (!colors) {
		// No TTY or terminal doesn't support OSC queries — leave Pi's default theme alone.
		return;
	}

	// Write the generated theme file next to this extension.
	const theme = buildTheme(colors);
	fs.writeFileSync(themePath, JSON.stringify(theme, null, 2));

	// Contribute the generated theme file to Pi's theme registry.
	pi.on("resources_discover", () => ({
		themePaths: [themePath],
	}));

	// Activate the theme each session (handles /new, /resume, /reload).
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setTheme(THEME_NAME);
	});
}
