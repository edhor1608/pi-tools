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

/** Events may be factories reading the CURRENT state (epoch/opId threading). */
type EventInput = ReviewLoopEvent | ((state: ReviewLoopState) => ReviewLoopEvent);

/** Drive a sequence of events, returning final state and all emitted effects. */
function run(
	events: EventInput[],
	options: { from?: ReviewLoopState; config?: ReviewLoopConfig } = {},
): { state: ReviewLoopState; effects: ReviewLoopEffect[] } {
	let state = options.from ?? initialState();
	const effects: ReviewLoopEffect[] = [];
	for (const input of events) {
		const event = typeof input === "function" ? input(state) : input;
		const result = transition(state, event, options.config ?? DEFAULT_CONFIG);
		state = result.state;
		effects.push(...result.effects);
	}
	return { state, effects };
}

// Factories that fill epoch/opId from the live state (the IO shell does the
// same by threading effect.epoch/effect.opId into its completion events).
const on = (owner?: ReviewLoopState["owner"]): ReviewLoopEvent => ({ type: "mode-on", by: "user", owner });
const off: ReviewLoopEvent = { type: "mode-off", by: "user" };
const settled =
	(fingerprint: string, stable = true, forced?: boolean): EventInput =>
	(state) => ({ type: "work-settled", epoch: state.epoch, fingerprint, stable, forced });
const reviewed =
	(outcome: ReviewOutcome, currentFingerprint: string): EventInput =>
	(state) => ({
		type: "review-completed",
		epoch: state.epoch,
		opId: state.activeOp?.id ?? -1,
		outcome,
		currentFingerprint,
	});
const accepted = (findings: Finding[]): ReviewLoopEvent => ({ type: "findings-accepted", accepted: findings });
const fixDone: EventInput = (state) => ({ type: "fix-completed", epoch: state.epoch, opId: state.activeOp?.id ?? -1 });
const verifyPassed =
	(fingerprint: string): EventInput =>
	(state) => ({ type: "verify-passed", epoch: state.epoch, opId: state.activeOp?.id ?? -1, fingerprint });
const verifyFailed: EventInput = (state) => ({
	type: "verify-failed",
	epoch: state.epoch,
	opId: state.activeOp?.id ?? -1,
	reason: "test",
});
const failed =
	(reason: string): EventInput =>
	(state) => ({ type: "backend-failure", epoch: state.epoch, opId: state.activeOp?.id, reason });

/** Shared prefix: mode on + settled work + valid review with the given findings. */
const untilTriage = (findings: Finding[]): EventInput[] => [on(), settled(FP), reviewed(validReview(FP, findings), FP)];

const dispatchReviews = (effects: ReviewLoopEffect[]) =>
	effects.filter((effect): effect is Extract<ReviewLoopEffect, { type: "dispatch-review" }> => effect.type === "dispatch-review");

void describe("mode toggling", () => {
	void test("mode-on arms the loop, bumps the epoch, and checks the gate", () => {
		const { state, effects } = run([on()]);
		assert.equal(state.phase, "armed");
		assert.equal(state.enabledBy, "user");
		assert.equal(state.epoch, 1);
		assert.deepEqual(effects, [{ type: "check-gate", epoch: 1 }]);
		assert.equal(isModeOn(state), true);
	});

	void test("mode-off resets to idle but keeps epoch/opSeq monotonic", () => {
		const { state } = run([...untilTriage([finding("bug")]), off]);
		assert.equal(state.phase, "idle");
		assert.equal(state.epoch, 2, "epoch must keep increasing across off");
		assert.ok(state.opSeq >= 1, "opSeq must survive mode-off");
	});

	void test("mode-on while already active is a no-op", () => {
		const { state } = run([on(), settled(FP), on()]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.fingerprint, FP);
	});

	void test("mode-on records the fix owner (default root, explicit subagent)", () => {
		assert.deepEqual(run([on()]).state.owner, { kind: "root" });
		assert.deepEqual(run([on({ kind: "subagent", id: "sub-3" })]).state.owner, { kind: "subagent", id: "sub-3" });
	});

	void test("mode-on with owner on an ARMED loop updates the fix lineage in place", () => {
		const { state, effects } = run([on(), on({ kind: "subagent", id: "sub-9" })]);
		assert.equal(state.phase, "armed");
		assert.deepEqual(state.owner, { kind: "subagent", id: "sub-9" });
		assert.equal(state.epoch, 1, "lineage update must not re-arm (no epoch bump)");
		assert.deepEqual(effects, [{ type: "check-gate", epoch: 1 }], "no second gate check from the update");
	});

	void test("mode-on with owner on a BLOCKED loop re-arms with the new lineage", () => {
		const { state } = run([on(), settled(FP), failed("boom"), on({ kind: "subagent", id: "sub-9" })]);
		assert.equal(state.phase, "armed");
		assert.deepEqual(state.owner, { kind: "subagent", id: "sub-9" });
	});

	void test("mode-on with owner mid-round never retargets the in-flight op", () => {
		const { state } = run([...untilTriage([finding("bug")]), accepted([finding("bug")]), on({ kind: "subagent", id: "sub-9" })]);
		assert.equal(state.phase, "fixing");
		assert.deepEqual(state.owner, { kind: "root" }, "in-flight fix keeps its original owner");
	});
});

void describe("entry gate", () => {
	void test("unstable work never starts a review", () => {
		const { state, effects } = run([on(), settled(FP, false)]);
		assert.equal(state.phase, "armed");
		assert.equal(dispatchReviews(effects).length, 0);
	});

	void test("stable work starts round 1 against that fingerprint with a fresh op", () => {
		const { state, effects } = run([on(), settled(FP)]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.round, 1);
		assert.equal(state.fingerprint, FP);
		assert.equal(state.reviewInFlight, true);
		assert.deepEqual(state.activeOp, { id: 1, kind: "review" });
		assert.deepEqual(effects.at(-1), { type: "dispatch-review", epoch: 1, opId: 1, fingerprint: FP, round: 1, kind: "initial" });
	});

	void test("work-settled during an in-flight review never double-dispatches", () => {
		const { effects } = run([on(), settled(FP), settled(FP)]);
		assert.equal(dispatchReviews(effects).length, 1);
	});
});

void describe("async epoch isolation", () => {
	void test("a review from a previous on/off cycle cannot complete the newer loop", () => {
		// Cycle 1: review in flight; capture its (epoch, opId); then off/on.
		const first = run([on(), settled(FP)]);
		const staleEpoch = first.state.epoch;
		const staleOpId = first.state.activeOp?.id ?? -1;
		const second = run([off, on(), settled(FP2)], { from: first.state });
		// The stale review returns "clean" — it must be ignored entirely.
		const { state } = run(
			[{ type: "review-completed", epoch: staleEpoch, opId: staleOpId, outcome: validReview(FP2), currentFingerprint: FP2 }],
			{ from: second.state },
		);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, true, "newer loop still waits for ITS reviewer");
	});

	void test("a stale backend failure cannot block the newer loop", () => {
		const first = run([on(), settled(FP)]);
		const staleEpoch = first.state.epoch;
		const staleOpId = first.state.activeOp?.id;
		const second = run([off, on(), settled(FP2)], { from: first.state });
		const { state } = run([{ type: "backend-failure", epoch: staleEpoch, opId: staleOpId, reason: "old cycle died" }], {
			from: second.state,
		});
		assert.notEqual(state.phase, "blocked");
		assert.equal(state.phase, "reviewing");
	});

	void test("a gate result from a previous epoch cannot start a round", () => {
		const armedState = run([on()]).state;
		const { state, effects } = run([{ type: "work-settled", epoch: armedState.epoch - 1, fingerprint: FP, stable: true }], {
			from: armedState,
		});
		assert.equal(state.phase, "armed");
		assert.equal(dispatchReviews(effects).length, 0);
	});

	void test("a mismatched opId in the same epoch is ignored", () => {
		const reviewing = run([on(), settled(FP)]).state;
		const { state } = run(
			[
				{
					type: "review-completed",
					epoch: reviewing.epoch,
					opId: (reviewing.activeOp?.id ?? 0) + 1000,
					outcome: validReview(FP),
					currentFingerprint: FP,
				},
			],
			{ from: reviewing },
		);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, true);
	});

	void test("stale verify events from an earlier op are ignored", () => {
		const batch = [finding("bug")];
		const verifying = run([...untilTriage(batch), accepted(batch), fixDone]).state;
		assert.equal(verifying.phase, "verifying");
		const { state } = run([{ type: "verify-passed", epoch: verifying.epoch, opId: (verifying.activeOp?.id ?? 0) + 7, fingerprint: FP2 }], {
			from: verifying,
		});
		assert.equal(state.phase, "verifying", "stale verify-passed must not advance the loop");
	});
});

void describe("fingerprint validity", () => {
	void test("review of a stale fingerprint is discarded, never a pass", () => {
		const { state, effects } = run([on(), settled(FP), reviewed(validReview(FP), FP2)]);
		assert.notEqual(state.phase, "clean");
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, false);
		assert.equal(state.fingerprint, undefined);
		assert.deepEqual(effects.at(-1), { type: "check-gate", epoch: state.epoch });
	});

	void test("reviewer echoing the wrong fingerprint is discarded too", () => {
		const { state } = run([on(), settled(FP), reviewed(validReview(FP2), FP)]);
		assert.notEqual(state.phase, "clean");
		assert.equal(state.fingerprint, undefined);
	});

	void test("after a discard, the next stable fingerprint re-dispatches", () => {
		const { state, effects } = run([on(), settled(FP), reviewed(validReview(FP), FP2), settled(FP2)]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, true);
		const last = dispatchReviews(effects).at(-1);
		assert.equal(last?.fingerprint, FP2);
	});
});

void describe("clean verdicts", () => {
	void test("valid review without findings ends clean", () => {
		assert.equal(run(untilTriage([])).state.phase, "clean");
	});

	void test("all findings rejected in triage ends clean", () => {
		const { state } = run([...untilTriage([finding("noise", "info")]), accepted([])]);
		assert.equal(state.phase, "clean");
		assert.deepEqual(state.findings, []);
	});

	void test("new settled work after clean starts a fresh loop", () => {
		const { state, effects } = run([...untilTriage([]), settled(FP2)]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.round, 1);
		assert.equal(dispatchReviews(effects).at(-1)?.fingerprint, FP2);
	});

	void test("re-settling the already-clean fingerprint stays clean", () => {
		assert.equal(run([...untilTriage([]), settled(FP)]).state.phase, "clean");
	});
});

void describe("mandatory fix -> verify -> fresh re-review", () => {
	void test("accepted findings force the full chain, with the owner on the fix effect", () => {
		const batch = [finding("null deref")];
		const { state, effects } = run([...untilTriage(batch), accepted(batch), fixDone, verifyPassed(FP2), settled(FP2)]);
		const kinds = effects.map((effect) => effect.type);
		assert.deepEqual(kinds.slice(1), [
			"dispatch-review",
			"dispatch-triage",
			"dispatch-fix",
			"dispatch-verify",
			"check-gate",
			"dispatch-review",
		]);
		const fix = effects.find((effect) => effect.type === "dispatch-fix");
		assert.deepEqual(fix?.owner, { kind: "root" });
		assert.equal(state.phase, "re-reviewing");
		assert.equal(state.round, 2);
		assert.equal(dispatchReviews(effects).at(-1)?.kind, "re-review");
	});

	void test("subagent owner travels into the dispatch-fix effect", () => {
		const batch = [finding("bug")];
		const { effects } = run([on({ kind: "subagent", id: "sub-9" }), settled(FP), reviewed(validReview(FP, batch), FP), accepted(batch)]);
		const fix = effects.find((effect) => effect.type === "dispatch-fix");
		assert.deepEqual(fix?.owner, { kind: "subagent", id: "sub-9" });
	});

	void test("verify-passed clears the reviewed fingerprint so the re-review needs a fresh stable target", () => {
		const batch = [finding("bug")];
		const { state } = run([...untilTriage(batch), accepted(batch), fixDone, verifyPassed(FP2)]);
		assert.equal(state.phase, "re-reviewing");
		assert.equal(state.reviewInFlight, false);
		assert.equal(state.fingerprint, undefined);
	});

	void test("verify-failed loops back into fixing", () => {
		const batch = [finding("bug")];
		const { state, effects } = run([...untilTriage(batch), accepted(batch), fixDone, verifyFailed]);
		assert.equal(state.phase, "fixing");
		assert.equal(state.fixAttempts, 1);
		assert.equal(effects.filter((effect) => effect.type === "dispatch-fix").length, 2);
	});

	void test("verify failures beyond the limit hard-stop", () => {
		const batch = [finding("bug")];
		const events: EventInput[] = [...untilTriage(batch), accepted(batch)];
		for (let attempt = 0; attempt <= DEFAULT_CONFIG.maxFixAttempts; attempt += 1) {
			events.push(fixDone, verifyFailed);
		}
		const { state } = run(events);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "verify-exhausted");
	});
});

void describe("invalid reviews", () => {
	void test("an invalid review is retried, never treated as a pass", () => {
		const { state, effects } = run([on(), settled(FP), reviewed(invalidReview(FP), FP)]);
		assert.notEqual(state.phase, "clean");
		assert.equal(state.phase, "reviewing");
		assert.equal(state.invalidRetries, 1);
		assert.equal(dispatchReviews(effects).at(-1)?.kind, "retry");
	});

	void test("retries are bounded: exhaustion blocks instead of passing", () => {
		const events: EventInput[] = [on(), settled(FP)];
		for (let retry = 0; retry <= DEFAULT_CONFIG.maxInvalidRetries; retry += 1) {
			events.push(reviewed(invalidReview(FP), FP));
		}
		const { state } = run(events);
		assert.equal(state.phase, "blocked");
		assert.match(state.blockedReason ?? "", /never treated as a pass/);
	});

	void test("a valid review resets the invalid-retry budget", () => {
		const { state } = run([on(), settled(FP), reviewed(invalidReview(FP), FP), reviewed(validReview(FP, [finding("bug")]), FP)]);
		assert.equal(state.phase, "triage");
		assert.equal(state.invalidRetries, 0);
	});
});

void describe("hard stops", () => {
	const roundTrip = (fingerprintIn: string, fingerprintOut: string, batch: Finding[]): EventInput[] => [
		settled(fingerprintIn),
		reviewed(validReview(fingerprintIn, batch), fingerprintIn),
		accepted(batch),
		fixDone,
		verifyPassed(fingerprintOut),
	];

	void test("round limit fires when a verified fix would exceed maxRounds", () => {
		const config: ReviewLoopConfig = { ...DEFAULT_CONFIG, maxRounds: 2 };
		const { state } = run([on(), ...roundTrip(FP, FP2, [finding("bug one")]), ...roundTrip(FP2, FP3, [finding("bug two")])], {
			config,
		});
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "round-limit");
	});

	void test("explicit round-limit event hard-stops an active loop", () => {
		const { state } = run([on(), settled(FP), { type: "round-limit" }]);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "round-limit");
	});

	void test("a repeated major finding across rounds stops for root-cause work", () => {
		const repeated = finding("race condition in queue");
		const { state } = run([
			on(),
			...roundTrip(FP, FP2, [repeated]),
			settled(FP2),
			reviewed(validReview(FP2, [repeated]), FP2),
			accepted([repeated]),
		]);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "root-cause-needed");
	});

	void test("severity reclassification cannot defeat the root-cause stop", () => {
		// Round 1: MAJOR. Round 2: the SAME issue upgraded to CRITICAL.
		const asMajor = finding("race condition in queue", "major");
		const asCritical = finding("race condition in queue", "critical");
		const { state } = run([
			on(),
			...roundTrip(FP, FP2, [asMajor]),
			settled(FP2),
			reviewed(validReview(FP2, [asCritical]), FP2),
			accepted([asCritical]),
		]);
		assert.equal(state.phase, "hard-stop");
		assert.equal(state.hardStopReason, "root-cause-needed");
	});

	void test("repeated MINOR findings do not trigger the root-cause stop", () => {
		const minor = finding("typo in comment", "minor");
		const { state } = run([
			on(),
			...roundTrip(FP, FP2, [finding("unrelated major")]),
			settled(FP2),
			reviewed(validReview(FP2, [minor]), FP2),
			accepted([minor]),
		]);
		assert.equal(state.phase, "fixing");
	});

	void test("finding identity is normalized and severity-independent", () => {
		assert.equal(findingKey(finding("  Race  Condition ")), findingKey(finding("race condition")));
		assert.equal(findingKey(finding("race condition", "major")), findingKey(finding("race condition", "critical")));
	});
});

void describe("backend failure", () => {
	void test("backend failure blocks visibly with the reason", () => {
		const { state } = run([on(), settled(FP), failed("claude executable missing")]);
		assert.equal(state.phase, "blocked");
		assert.equal(state.blockedReason, "claude executable missing");
		assert.equal(state.reviewInFlight, false);
	});

	void test("a fingerprint failure without an op blocks from armed", () => {
		const armedState = run([on()]).state;
		const { state } = run([{ type: "backend-failure", epoch: armedState.epoch, reason: "not a git repository: /tmp/x" }], {
			from: armedState,
		});
		assert.equal(state.phase, "blocked");
		assert.match(state.blockedReason ?? "", /not a git repository/);
	});

	void test("blocked ignores ordinary settles; only a forced retry re-arms", () => {
		const blocked = run([on(), settled(FP), failed("backend down")]).state;
		const stillBlocked = run([settled(FP2)], { from: blocked }).state;
		assert.equal(stillBlocked.phase, "blocked");
		const retried = run([settled(FP2, true, true)], { from: blocked });
		assert.equal(retried.state.phase, "reviewing");
		assert.equal(dispatchReviews(retried.effects).at(-1)?.fingerprint, FP2);
	});
});

void describe("resume reconciliation", () => {
	const resumed: ReviewLoopEvent = { type: "resumed" };

	void test("a pending review re-enters through the gate", () => {
		const pending: ReviewLoopState = { ...run([on(), settled(FP)]).state, reviewInFlight: false, activeOp: undefined };
		const { state, effects } = run([resumed], { from: pending });
		assert.equal(state.phase, "reviewing");
		assert.deepEqual(effects, [{ type: "check-gate", epoch: pending.epoch }]);
	});

	void test("a restored fixing phase re-dispatches the fix batch with a fresh op", () => {
		const batch = [finding("bug")];
		const fixing = run([...untilTriage(batch), accepted(batch)]).state;
		const restored: ReviewLoopState = { ...fixing, activeOp: undefined };
		const { state, effects } = run([resumed], { from: restored });
		assert.equal(state.phase, "fixing");
		const fix = effects.find((effect) => effect.type === "dispatch-fix");
		assert.ok(fix, "fix must be re-dispatched");
		assert.equal(fix.opId, state.activeOp?.id);
		assert.deepEqual(
			fix.findings.map((entry) => entry.title),
			["bug"],
		);
	});

	void test("a restored verifying phase re-runs verification against the reviewed fingerprint", () => {
		const batch = [finding("bug")];
		const verifying = run([...untilTriage(batch), accepted(batch), fixDone]).state;
		const restored: ReviewLoopState = { ...verifying, activeOp: undefined };
		const { state, effects } = run([resumed], { from: restored });
		assert.equal(state.phase, "verifying");
		const verify = effects.find((effect) => effect.type === "dispatch-verify");
		assert.equal(verify?.reviewedFingerprint, FP);
		assert.equal(verify?.opId, state.activeOp?.id);
	});

	void test("a restored triage phase re-runs triage on its findings", () => {
		const triage = run(untilTriage([finding("bug")])).state;
		const { effects } = run([resumed], { from: triage });
		const effect = effects.find((entry) => entry.type === "dispatch-triage");
		assert.deepEqual(
			effect?.findings.map((entry) => entry.title),
			["bug"],
		);
	});

	void test("settled phases resume without effects", () => {
		for (const from of [initialState(), run(untilTriage([])).state]) {
			assert.deepEqual(run([resumed], { from }).effects, []);
		}
	});
});

void describe("event guards", () => {
	void test("review-completed outside an in-flight review is ignored", () => {
		const armedState = run([on()]).state;
		const { state } = run([reviewed(validReview(FP), FP)], { from: armedState });
		assert.equal(state.phase, "armed");
	});

	void test("fix/verify events outside their phases are ignored", () => {
		const clean = run(untilTriage([])).state;
		assert.equal(run([fixDone], { from: clean }).state.phase, "clean");
		assert.equal(run([verifyPassed(FP2)], { from: clean }).state.phase, "clean");
	});
});
