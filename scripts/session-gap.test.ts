import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionGapAlert, buildSessionGapNotification, checkSessionGapOnce, computeSessionGap } from "../extensions/session-gap.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

void test("session gap requires strictly more than two days", () => {
	assert.equal(computeSessionGap([NOW - 2 * DAY], NOW), undefined);
	assert.deepEqual(computeSessionGap([NOW - 2 * DAY - 5 * HOUR], NOW), {
		milliseconds: 2 * DAY + 5 * HOUR,
		days: 2,
		hours: 5,
	});
});

void test("session gap ignores entries from the current sixty-second activity stretch", () => {
	const gap = computeSessionGap([NOW - 10_000, NOW - 3 * DAY - 4 * HOUR], NOW);
	assert.deepEqual(gap, {
		milliseconds: 3 * DAY + 4 * HOUR,
		days: 3,
		hours: 4,
	});
	assert.equal(computeSessionGap([NOW - 10_000], NOW), undefined);
});

void test("session gap check is consumed once per resumed session", () => {
	const first = checkSessionGapOnce({ checked: false }, [NOW - 3 * DAY], NOW);
	const second = checkSessionGapOnce(first.state, [NOW - 4 * DAY], NOW);

	assert.equal(first.gap?.days, 3);
	assert.equal(first.state.checked, true);
	assert.equal(second.gap, undefined);
	assert.equal(second.state, first.state);
});

void test("session gap alert and notification preserve catchup wording", () => {
	assert.equal(
		buildSessionGapAlert({ days: 3, hours: 7 }),
		"SESSION-GAP ALERT: The previous activity in this session was 3 day(s) 7h ago. Jonas has ADHD and has completely lost the context of this session. BEFORE addressing his new prompt, invoke the 'catchup' skill and follow it: verify the real current state (git, tasks, files, background agents — do not trust conversation memory alone) and deliver the re-orientation briefing it defines. Then explicitly connect his new prompt to that state — if his prompt seems to ignore or contradict where the session left off, point that out instead of silently following it.",
	);
	assert.equal(
		buildSessionGapNotification({ days: 3, hours: 7 }),
		"⏰ Session war 3d 7h inaktiv — Re-Orientierungs-Briefing wird vorangestellt.",
	);
});
