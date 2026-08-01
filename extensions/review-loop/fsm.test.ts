import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	DEFAULT_CONFIG,
	type Finding,
	findingKey,
	initialState,
	isModeOn,
	type ReviewLoopConfig,
	type ReviewLoopEffect,
	type ReviewLoopEvent,
	type ReviewLoopState,
	type ReviewOutcome,
	transition,
} from "./fsm.ts";

const FP = "abc123+deadbeef";
const FP2 = "def456+cafebabe";
const FP3 = "000999+00112233";

const finding = (title: string, severity: Finding["severity"] = "major"): Finding => ({
	id: title,
	title,
	severity,
});

const validReview = (fingerprint: string, findings: Finding[] = []): ReviewOutcome => ({
	valid: true,
	fingerprint,
	findings,
	verdict: findings.length === 0 ? "clean" : "findings",
});

const invalidReview = (fingerprint: string): ReviewOutcome => ({ valid: false, fingerprint, findings: [] });

/** Drive a sequence of events, returning final state and all emitted effects. */
function run(
	events: ReviewLoopEvent[],
	options: { from?: ReviewLoopState; config?: ReviewLoopConfig } = {},
): { state: ReviewLoopState; effects: ReviewLoopEffect[] } {
	let state = options.from ?? initialState();
	const effects: ReviewLoopEffect[] = [];
	for (const event of events) {
		const result = transition(state, event, options.config ?? DEFAULT_CONFIG);
		state = result.state;
		effects.push(...result.effects);
	}
	return { state, effects };
}

/** Shared prefix: mode on + settled work + valid review with the given findings. */
const untilTriage = (findings: Finding[]): ReviewLoopEvent[] => [
	{ type: "mode-on", by: "user" },
	{ type: "work-settled", fingerprint: FP, stable: true },
	{ type: "review-completed", outcome: validReview(FP, findings), currentFingerprint: FP },
];

void describe("mode toggling", () => {
	void test("mode-on arms the loop and checks the gate", () => {
		const { state, effects } = run([{ type: "mode-on", by: "user" }]);
		assert.equal(state.phase, "armed");
		assert.equal(state.enabledBy, "user");
		assert.deepEqual(effects, [{ type: "check-gate" }]);
		assert.equal(isModeOn(state), true);
	});

	void test("mode-on works for the agent too", () => {
		const { state } = run([{ type: "mode-on", by: "agent" }]);
		assert.equal(state.enabledBy, "agent");
	});

	void test("mode-off resets to idle from any phase", () => {
		const { state } = run([...untilTriage([finding("bug")]), { type: "mode-off", by: "user" }]);
		assert.deepEqual(state, initialState());
	});

	void test("mode-on while already active is a no-op", () => {
		const { state } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "mode-on", by: "user" },
		]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.fingerprint, FP);
	});
});

void describe("entry gate", () => {
	void test("unstable work never starts a review", () => {
		const { state, effects } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: false },
		]);
		assert.equal(state.phase, "armed");
		assert.equal(effects.filter((effect) => effect.type === "dispatch-review").length, 0);
	});

	void test("stable work starts round 1 against that fingerprint", () => {
		const { state, effects } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
		]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.round, 1);
		assert.equal(state.fingerprint, FP);
		assert.equal(state.reviewInFlight, true);
		assert.deepEqual(effects.at(-1), { type: "dispatch-review", fingerprint: FP, round: 1, kind: "initial" });
	});

	void test("work-settled during an in-flight review never double-dispatches", () => {
		const { state, effects } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "work-settled", fingerprint: FP, stable: true },
		]);
		assert.equal(state.phase, "reviewing");
		assert.equal(effects.filter((effect) => effect.type === "dispatch-review").length, 1);
	});
});

void describe("fingerprint validity", () => {
	void test("review of a stale fingerprint is discarded, never a pass", () => {
		const { state, effects } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			// Tree moved while the reviewer ran: current fingerprint differs.
			{ type: "review-completed", outcome: validReview(FP), currentFingerprint: FP2 },
		]);
		assert.notEqual(state.phase, "clean");
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, false);
		assert.equal(state.fingerprint, undefined);
		assert.deepEqual(effects.at(-1), { type: "check-gate" });
	});

	void test("reviewer echoing the wrong fingerprint is discarded too", () => {
		const { state } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "review-completed", outcome: validReview(FP2), currentFingerprint: FP },
		]);
		assert.notEqual(state.phase, "clean");
		assert.equal(state.fingerprint, undefined);
	});

	void test("after a discard, the next stable fingerprint re-dispatches", () => {
		const { state, effects } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "review-completed", outcome: validReview(FP), currentFingerprint: FP2 },
			{ type: "work-settled", fingerprint: FP2, stable: true },
		]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, true);
		assert.deepEqual(effects.at(-1), { type: "dispatch-review", fingerprint: FP2, round: 1, kind: "initial" });
	});
});

void describe("clean verdicts", () => {
	void test("valid review without findings ends clean", () => {
		const { state } = run(untilTriage([]));
		assert.equal(state.phase, "clean");
	});

	void test("all findings rejected in triage ends clean", () => {
		const { state } = run([...untilTriage([finding("noise", "info")]), { type: "findings-accepted", accepted: [] }]);
		assert.equal(state.phase, "clean");
		assert.deepEqual(state.findings, []);
	});

	void test("new settled work after clean starts a fresh loop", () => {
		const { state, effects } = run([...untilTriage([]), { type: "work-settled", fingerprint: FP2, stable: true }]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.round, 1);
		assert.deepEqual(effects.at(-1), { type: "dispatch-review", fingerprint: FP2, round: 1, kind: "initial" });
	});

	void test("re-settling the already-clean fingerprint stays clean", () => {
		const { state } = run([...untilTriage([]), { type: "work-settled", fingerprint: FP, stable: true }]);
		assert.equal(state.phase, "clean");
	});
});

void describe("mandatory fix -> verify -> fresh re-review", () => {
	void test("accepted findings force the full chain", () => {
		const accepted = [finding("null deref")];
		const { state, effects } = run([
			...untilTriage(accepted),
			{ type: "findings-accepted", accepted },
			{ type: "fix-completed" },
			{ type: "verify-passed", fingerprint: FP2 },
			{ type: "work-settled", fingerprint: FP2, stable: true },
		]);
		const kinds = effects.map((effect) => effect.type);
		assert.deepEqual(kinds.slice(1), [
			"dispatch-review",
			"dispatch-triage",
			"dispatch-fix",
			"dispatch-verify",
			"check-gate",
			"dispatch-review",
		]);
		assert.equal(state.phase, "re-reviewing");
		assert.equal(state.round, 2);
		assert.deepEqual(effects.at(-1), { type: "dispatch-review", fingerprint: FP2, round: 2, kind: "re-review" });
	});

	void test("verify-passed clears the reviewed fingerprint so the re-review needs a fresh stable target", () => {
		const accepted = [finding("bug")];
		const { state } = run([
			...untilTriage(accepted),
			{ type: "findings-accepted", accepted },
			{ type: "fix-completed" },
			{ type: "verify-passed", fingerprint: FP2 },
		]);
		assert.equal(state.phase, "re-reviewing");
		assert.equal(state.reviewInFlight, false);
		assert.equal(state.fingerprint, undefined);
	});

	void test("verify-failed loops back into fixing", () => {
		const accepted = [finding("bug")];
		const { state, effects } = run([
			...untilTriage(accepted),
			{ type: "findings-accepted", accepted },
			{ type: "fix-completed" },
			{ type: "verify-failed", reason: "tree unchanged" },
		]);
		assert.equal(state.phase, "fixing");
		assert.equal(state.fixAttempts, 1);
		assert.equal(effects.filter((effect) => effect.type === "dispatch-fix").length, 2);
	});

	void test("verify failures beyond the limit hard-stop", () => {
		const accepted = [finding("bug")];
		const events: ReviewLoopEvent[] = [...untilTriage(accepted), { type: "findings-accepted", accepted }];
		for (let attempt = 0; attempt <= DEFAULT_CONFIG.maxFixAttempts; attempt += 1) {
			events.push({ type: "fix-completed" }, { type: "verify-failed" });
		}
		const { state } = run(events);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "verify-exhausted");
	});
});

void describe("invalid reviews", () => {
	void test("an invalid review is retried, never treated as a pass", () => {
		const { state, effects } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "review-completed", outcome: invalidReview(FP), currentFingerprint: FP },
		]);
		assert.notEqual(state.phase, "clean");
		assert.equal(state.phase, "reviewing");
		assert.equal(state.invalidRetries, 1);
		assert.deepEqual(effects.at(-1), { type: "dispatch-review", fingerprint: FP, round: 1, kind: "retry" });
	});

	void test("retries are bounded: exhaustion blocks instead of passing", () => {
		const events: ReviewLoopEvent[] = [
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
		];
		for (let retry = 0; retry <= DEFAULT_CONFIG.maxInvalidRetries; retry += 1) {
			events.push({ type: "review-completed", outcome: invalidReview(FP), currentFingerprint: FP });
		}
		const { state } = run(events);
		assert.equal(state.phase, "blocked");
		assert.match(state.blockedReason ?? "", /never treated as a pass/);
	});

	void test("a valid review resets the invalid-retry budget", () => {
		const { state } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "review-completed", outcome: invalidReview(FP), currentFingerprint: FP },
			{ type: "review-completed", outcome: validReview(FP, [finding("bug")]), currentFingerprint: FP },
		]);
		assert.equal(state.phase, "triage");
		assert.equal(state.invalidRetries, 0);
	});
});

void describe("hard stops", () => {
	const roundTrip = (fingerprintIn: string, fingerprintOut: string, title: string): ReviewLoopEvent[] => [
		{ type: "work-settled", fingerprint: fingerprintIn, stable: true },
		{ type: "review-completed", outcome: validReview(fingerprintIn, [finding(title)]), currentFingerprint: fingerprintIn },
		{ type: "findings-accepted", accepted: [finding(title)] },
		{ type: "fix-completed" },
		{ type: "verify-passed", fingerprint: fingerprintOut },
	];

	void test("round limit fires when a verified fix would exceed maxRounds", () => {
		const config: ReviewLoopConfig = { ...DEFAULT_CONFIG, maxRounds: 2 };
		const { state } = run([{ type: "mode-on", by: "user" }, ...roundTrip(FP, FP2, "bug one"), ...roundTrip(FP2, FP3, "bug two")], {
			config,
		});
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "round-limit");
	});

	void test("explicit round-limit event hard-stops an active loop", () => {
		const { state } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "round-limit" },
		]);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "round-limit");
	});

	void test("a repeated major finding across rounds stops for root-cause work", () => {
		const repeated = finding("race condition in queue");
		const { state } = run([
			{ type: "mode-on", by: "user" },
			...roundTrip(FP, FP2, repeated.title),
			{ type: "work-settled", fingerprint: FP2, stable: true },
			{ type: "review-completed", outcome: validReview(FP2, [repeated]), currentFingerprint: FP2 },
			{ type: "findings-accepted", accepted: [repeated] },
		]);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "root-cause-needed");
	});

	void test("repeated MINOR findings do not trigger the root-cause stop", () => {
		const minor = finding("typo in comment", "minor");
		const { state } = run([
			{ type: "mode-on", by: "user" },
			...roundTrip(FP, FP2, "unrelated major"),
			{ type: "work-settled", fingerprint: FP2, stable: true },
			{ type: "review-completed", outcome: validReview(FP2, [minor]), currentFingerprint: FP2 },
			{ type: "findings-accepted", accepted: [minor] },
		]);
		assert.equal(state.phase, "fixing");
	});

	void test("finding identity is normalized for repeat detection", () => {
		assert.equal(findingKey(finding("  Race  Condition ")), findingKey(finding("race condition")));
		assert.notEqual(findingKey(finding("race condition", "major")), findingKey(finding("race condition", "minor")));
	});
});

void describe("backend failure", () => {
	void test("backend failure blocks visibly with the reason", () => {
		const { state } = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "backend-failure", reason: "claude executable missing" },
		]);
		assert.equal(state.phase, "blocked");
		assert.equal(state.blockedReason, "claude executable missing");
		assert.equal(state.reviewInFlight, false);
	});

	void test("blocked ignores ordinary settles; only a forced retry re-arms", () => {
		const blocked = run([
			{ type: "mode-on", by: "user" },
			{ type: "work-settled", fingerprint: FP, stable: true },
			{ type: "backend-failure", reason: "backend down" },
		]).state;
		const stillBlocked = run([{ type: "work-settled", fingerprint: FP2, stable: true }], { from: blocked }).state;
		assert.equal(stillBlocked.phase, "blocked");
		const retried = run([{ type: "work-settled", fingerprint: FP2, stable: true, forced: true }], { from: blocked });
		assert.equal(retried.state.phase, "reviewing");
		assert.deepEqual(retried.effects.at(-1), { type: "dispatch-review", fingerprint: FP2, round: 1, kind: "initial" });
	});
});

void describe("event guards", () => {
	void test("review-completed outside an in-flight review is ignored", () => {
		const armed = run([{ type: "mode-on", by: "user" }]).state;
		const { state } = run([{ type: "review-completed", outcome: validReview(FP), currentFingerprint: FP }], {
			from: armed,
		});
		assert.equal(state.phase, "armed");
	});

	void test("fix/verify events outside their phases are ignored", () => {
		const clean = run(untilTriage([])).state;
		assert.equal(run([{ type: "fix-completed" }], { from: clean }).state.phase, "clean");
		assert.equal(run([{ type: "verify-passed", fingerprint: FP2 }], { from: clean }).state.phase, "clean");
	});
});
