/**
 * ANSI Theme Sync
 *
 * Detects terminal background color changes via OSC 11 escape sequences
 * and switches between dark/light themes configured in settings.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;

type ThemeMode = "dark" | "light";

interface AnsiThemeConfig {
	darkTheme?: string;
	lightTheme?: string;
}

// ─── OSC Helpers (run in child process to avoid raw mode on main TTY) ────────

const OSC_QUERY_SCRIPT = `
const fs = require("fs");
const tty = require("tty");
const path = require("path");

function parseRgbSpec(spec) {
    const m = /rgb:([0-9a-fA-F]+)\\/([0-9a-fA-F]+)\\/([0-9a-fA-F]+)/.exec(spec);
    if (!m) return null;
    const toOctet = (s) => parseInt(s.length > 2 ? s.slice(0, 2) : s, 16);
    const [r, g, b] = [toOctet(m[1]), toOctet(m[2]), toOctet(m[3])];
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function parseOsc11(buf) {
    const re = /\\x1b\\]11;(rgb:[^\\x07\\x1b]+)(?:\\x07|\\x1b\\\\)/;
    const m = re.exec(buf);
    if (!m) return null;
    return parseRgbSpec(m[1]);
}

let ttyFd;
try {
    ttyFd = fs.openSync("/dev/tty", "r+");
} catch {
    process.exit(1);
}

const readStream = new tty.ReadStream(ttyFd);
let rawModeSet = false;

try {
    readStream.setRawMode(true);
    rawModeSet = true;
} catch {
    fs.closeSync(ttyFd);
    process.exit(1);
}

let buf = "";
const timer = setTimeout(() => {
    const bg = parseOsc11(buf);
    if (bg) console.log(JSON.stringify({ ok: true, bg }));
    else console.log(JSON.stringify({ ok: false }));
    cleanup();
}, 500);

function cleanup() {
    clearTimeout(timer);
    try { if (rawModeSet) readStream.setRawMode(false); } catch {}
    readStream.destroy();
}

readStream.on("data", (chunk) => {
    buf += chunk.toString("binary");
    const bg = parseOsc11(buf);
    if (bg) {
        console.log(JSON.stringify({ ok: true, bg }));
        cleanup();
    }
});

readStream.on("error", () => cleanup());

try {
    fs.writeSync(ttyFd, "\\x1b]11;?\\x07");
} catch {
    console.log(JSON.stringify({ ok: false }));
    cleanup();
}
`;

function relativeLuminance(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	const r = ((n >> 16) & 0xff) / 255;
	const g = ((n >> 8) & 0xff) / 255;
	const b = (n & 0xff) / 255;
	const toLinear = (c: number) =>
		c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function detectMode(bgHex: string): ThemeMode {
	return relativeLuminance(bgHex) < 0.5 ? "dark" : "light";
}

function queryBgColor(): Promise<string | null> {
	return new Promise((resolve) => {
		const child = spawn("node", ["-e", OSC_QUERY_SCRIPT], {
			stdio: ["ignore", "pipe", "ignore"],
			detached: false,
		});

		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stdout.on("end", () => {
			try {
				const result = JSON.parse(output.trim());
				resolve(result.ok ? result.bg : null);
			} catch {
				resolve(null);
			}
		});
		child.on("error", () => resolve(null));
	});
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const config = (pi.getSettings?.() ?? {})["ansiTheme"] as
		| AnsiThemeConfig
		| undefined;
	const darkTheme = config?.darkTheme ?? "ansi-dark";
	const lightTheme = config?.lightTheme ?? "ansi-light";

	// Initial query
	const bg = await queryBgColor();
	if (!bg) return;

	let currentMode: ThemeMode = detectMode(bg);

	function getThemeName(mode: ThemeMode): string {
		return mode === "dark" ? darkTheme : lightTheme;
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setTheme(getThemeName(currentMode));
	});

	// Poll for background color changes in a child process
	let pollTimer: NodeJS.Timeout | null = null;

	async function poll() {
		const bg = await queryBgColor();
		if (bg) {
			const mode = detectMode(bg);
			if (mode !== currentMode) {
				currentMode = mode;
			}
		}
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	}

	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);

	pi.on("session_shutdown", () => {
		if (pollTimer) clearTimeout(pollTimer);
	});
}
