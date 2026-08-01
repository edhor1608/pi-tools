import assert from "node:assert/strict";
import test from "node:test";
import {
	decideUsageGuard,
	isCodexUsageCacheFresh,
	shouldCheckUsageMidTurn,
	usageGuardThresholds,
	type UsageGuardLatches,
} from "../extensions/usage-guard.ts";
import type { CodexUsageWindow } from "../extensions/statusline.ts";

const NOW = 1_800_000_000_000;
const thresholds = { warnAt: 80, wrapupAt: 90 } as const;

function window(usedPercent: number, resetAt = NOW + 60_000): CodexUsageWindow {
	return { label: "5h", usedPercent, resetAt };
}

void test("usage guard crosses warning and wrap-up thresholds", () => {
	assert.equal(decideUsageGuard([window(79)], {}, thresholds, NOW, "session-a", "directive").level, undefined);

	const warning = decideUsageGuard([window(80)], {}, thresholds, NOW, "session-a", "directive");
	assert.equal(warning.level, "warn");
	assert.deepEqual(warning.windows, [window(80)]);

	const wrapup = decideUsageGuard([window(90)], warning.latches, thresholds, NOW + 1, "session-a", "directive");
	assert.equal(wrapup.level, "wrapup");
	assert.deepEqual(wrapup.windows, [window(90)]);
});

void test("usage guard latches each level once per window", () => {
	const first = decideUsageGuard([window(85)], {}, thresholds, NOW, "session-a", "directive");
	const repeated = decideUsageGuard([window(86)], first.latches, thresholds, NOW + 1, "session-a", "directive");

	assert.equal(first.level, "warn");
	assert.equal(repeated.level, undefined);
	assert.deepEqual(repeated.windows, []);
});

void test("usage guard re-arms after the usage window reset changes", () => {
	const first = decideUsageGuard([window(85, NOW + 60_000)], {}, thresholds, NOW, "session-a", "directive");
	const nextWindow = decideUsageGuard([window(85, NOW + 120_000)], first.latches, thresholds, NOW + 60_001, "session-a", "directive");

	assert.equal(nextWindow.level, "warn");
	assert.equal(Object.keys(nextWindow.latches).length, 2);
});

void test("usage guard latches once per session and re-fires in a new session", () => {
	const first = decideUsageGuard([window(93)], {}, thresholds, NOW, "session-a", "directive");
	const repeated = decideUsageGuard([window(93)], first.latches, thresholds, NOW + 1, "session-a", "directive");
	const newSession = decideUsageGuard([window(93)], repeated.latches, thresholds, NOW + 2, "session-b", "directive");

	assert.equal(first.level, "wrapup");
	assert.equal(repeated.level, undefined);
	assert.equal(newSession.level, "wrapup");
});

void test("mid-turn notification does not consume the next-turn directive latch", () => {
	const notification = decideUsageGuard([window(93)], {}, thresholds, NOW, "session-a", "notification");
	const repeatedNotification = decideUsageGuard([window(93)], notification.latches, thresholds, NOW + 1, "session-a", "notification");
	const directive = decideUsageGuard([window(93)], repeatedNotification.latches, thresholds, NOW + 2, "session-a", "directive");

	assert.equal(notification.level, "wrapup");
	assert.equal(repeatedNotification.level, undefined);
	assert.equal(directive.level, "wrapup");
});

void test("mid-turn checks are throttled", () => {
	assert.equal(shouldCheckUsageMidTurn(NOW, NOW + 14_999), false);
	assert.equal(shouldCheckUsageMidTurn(NOW, NOW + 15_000), true);
});

void test("usage guard thresholds accept valid env overrides and reject invalid ones", () => {
	assert.deepEqual(usageGuardThresholds({ PI_USAGE_GUARD_WARN_AT: "72.5", PI_USAGE_GUARD_WRAPUP_AT: "88" }), {
		warnAt: 72.5,
		wrapupAt: 88,
	});
	assert.deepEqual(usageGuardThresholds({ PI_USAGE_GUARD_WARN_AT: "invalid", PI_USAGE_GUARD_WRAPUP_AT: "101" }), {
		warnAt: 80,
		wrapupAt: 90,
	});
});

void test("statusline Codex usage cache is stale only after 120 seconds", () => {
	assert.equal(isCodexUsageCacheFresh(undefined, NOW), false);
	assert.equal(isCodexUsageCacheFresh({ fetchedAt: NOW - 120_000 }, NOW), true);
	assert.equal(isCodexUsageCacheFresh({ fetchedAt: NOW - 120_001 }, NOW), false);
	assert.equal(isCodexUsageCacheFresh({ fetchedAt: NOW + 1 }, NOW), false);
});

void test("usage guard prunes latches older than fourteen days", () => {
	const latches: UsageGuardLatches = {
		old: NOW - 14 * 24 * 60 * 60 * 1000 - 1,
		fresh: NOW - 1,
	};
	const decision = decideUsageGuard([], latches, thresholds, NOW, "session-a", "directive");

	assert.deepEqual(decision.latches, { fresh: NOW - 1 });
	assert.equal(decision.changed, true);
});
