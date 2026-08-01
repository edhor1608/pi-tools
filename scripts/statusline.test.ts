import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	clearExtensionStatus,
	getExtensionStatuses,
	onStatusChange,
	resetStatusBusForTest,
	setExtensionStatus,
} from "../extensions/shared/status-bus.ts";
import { codexUsageFromResponse, composeFooterLines, type RenderTheme } from "../extensions/statusline.ts";

const ansi = {
	dim: "\u001b[2m",
	warning: "\u001b[33m",
	error: "\u001b[31m",
} as const;

const theme = {
	fg(color, text) {
		const prefix = ansi[color as keyof typeof ansi] ?? "";
		return prefix ? `${prefix}${text}\u001b[0m` : text;
	},
	bold(text) {
		return text;
	},
} satisfies RenderTheme;

void test("Codex account usage response becomes footer usage", () => {
	const usage = codexUsageFromResponse(
		{
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 4.2,
					limit_window_seconds: 604800,
					reset_at: 1785911787,
				},
			},
			rate_limit_reset_credits: {
				available_count: 3,
				applicable_available_count: 0,
			},
		},
		1000,
	);

	assert.deepEqual(usage, {
		windows: [
			{
				label: "7d",
				usedPercent: 4,
				resetAt: 1785911787000,
				windowSeconds: 604800,
			},
		],
		planType: "pro",
		creditsAvailable: 0,
		fetchedAt: 1000,
	});
});

void test("Codex account usage response includes 5h and weekly windows", () => {
	const usage = codexUsageFromResponse(
		{
			rate_limit: {
				primary_window: {
					used_percent: 8,
					limit_window_seconds: 604800,
					reset_at: 1785911787,
				},
				secondary_window: {
					used_percent: 42,
					limit_window_seconds: 18000,
					reset_at: 1785360000,
				},
			},
		},
		1000,
	);

	assert.deepEqual(usage?.windows, [
		{
			label: "5h",
			usedPercent: 42,
			resetAt: 1785360000000,
			windowSeconds: 18000,
		},
		{
			label: "7d",
			usedPercent: 8,
			resetAt: 1785911787000,
			windowSeconds: 604800,
		},
	]);
});

void test("Codex account usage parser rejects unrelated payloads", () => {
	assert.equal(codexUsageFromResponse({ ok: true }, 1000), undefined);
});

void test("extension statuses are ordered by order then id and tone-colored", () => {
	resetStatusBusForTest();
	setExtensionStatus("zeta", "info", { order: 20 });
	setExtensionStatus("beta", "error", { tone: "error", order: 10 });
	setExtensionStatus("alpha", "warn", { tone: "warn", order: 10 });

	const lines = composeFooterLines("footer", theme, 200, getExtensionStatuses());

	assert.deepEqual(
		getExtensionStatuses().map(({ id }) => id),
		["alpha", "beta", "zeta"],
	);
	assert.deepEqual(lines, [
		"footer",
		`${ansi.warning}warn\u001b[0m${ansi.dim} | \u001b[0m${ansi.error}error\u001b[0m${ansi.dim} | \u001b[0m${ansi.dim}info\u001b[0m`,
	]);
	resetStatusBusForTest();
});

void test("extension status line is truncated to terminal width", () => {
	const lines = composeFooterLines("footer", theme, 12, [
		{ id: "long", text: "a very long extension status", tone: "info", order: 1, updatedAt: 0 },
	]);

	assert.equal(lines.length, 2);
	assert.equal(visibleWidth(lines[1] ?? ""), 12);
	assert.match(lines[1] ?? "", /\.\.\./);
});

void test("empty status bus renders only the existing footer line", () => {
	resetStatusBusForTest();
	assert.deepEqual(composeFooterLines("footer", theme, 80, getExtensionStatuses()), ["footer"]);
});

void test("native Pi statuses are merged and sorted by key", () => {
	const lines = composeFooterLines(
		"footer",
		theme,
		80,
		[{ id: "shared", text: "bus", tone: "info", order: 1, updatedAt: 0 }],
		new Map([
			["zeta", "native z"],
			["alpha", "native a"],
			["shared", "duplicate"],
		]),
	);

	assert.equal(lines[1], `${ansi.dim}bus\u001b[0m${ansi.dim} | \u001b[0mnative a${ansi.dim} | \u001b[0mnative z`);
});

void test("status bus listeners are notified on set and clear", () => {
	resetStatusBusForTest();
	let notifications = 0;
	const unsubscribe = onStatusChange(() => notifications++);

	setExtensionStatus("worker", "running");
	setExtensionStatus("worker", "done");
	clearExtensionStatus("worker");
	clearExtensionStatus("missing");

	assert.equal(notifications, 3);
	unsubscribe();
	setExtensionStatus("worker", "ignored");
	assert.equal(notifications, 3);
	resetStatusBusForTest();
});
