import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initialState, type ReviewLoopState } from "./fsm.ts";
import {
	isPersistedReviewLoopState,
	readReviewLoopStateFromEntries,
	restoreReviewLoopState,
	REVIEW_LOOP_ENTRY_TYPE,
	serializeReviewLoopState,
	type SessionEntryLike,
} from "./persistence.ts";

const richState = (): ReviewLoopState => ({
	phase: "triage",
	enabledBy: "agent",
	epoch: 3,
	opSeq: 7,
	owner: { kind: "subagent", id: "sub-4" },
	round: 2,
	invalidRetries: 1,
	fixAttempts: 0,
	fingerprint: "abc123+deadbeef",
	reviewInFlight: false,
	reviewer: { backend: "pi", model: "gpt-5.6-sol", subagentId: "sub-7" },
	findings: [{ id: "f1", title: "null deref", severity: "major", detail: "manager.ts:42" }],
	majorFindingHistory: [["off-by-one"]],
	// blockedReason/hardStopReason/activeOp intentionally absent: the session
	// file is a JSON boundary, and JSON drops explicit-undefined keys.
});

const entry = (data: unknown): SessionEntryLike => ({ type: "custom", customType: REVIEW_LOOP_ENTRY_TYPE, data });

void describe("round-trip", () => {
	void test("serialize -> validate -> restore preserves durable state", () => {
		const persisted = serializeReviewLoopState(richState());
		assert.equal(isPersistedReviewLoopState(persisted), true);
		// Simulate the JSON boundary of the session file.
		const decoded: unknown = JSON.parse(JSON.stringify(persisted));
		assert.equal(isPersistedReviewLoopState(decoded), true);
		if (!isPersistedReviewLoopState(decoded)) return;
		assert.deepEqual(restoreReviewLoopState(decoded), richState());
	});

	void test("epoch, opSeq, and owner lineage survive the round-trip", () => {
		const restored = restoreReviewLoopState(serializeReviewLoopState(richState()));
		assert.equal(restored.epoch, 3);
		assert.equal(restored.opSeq, 7);
		assert.deepEqual(restored.owner, { kind: "subagent", id: "sub-4" });
	});

	void test("serialization snapshots: later mutations do not leak into the persisted copy", () => {
		const state = richState();
		const persisted = serializeReviewLoopState(state);
		const finding = state.findings[0];
		const firstHistoryEntry = state.majorFindingHistory[0];
		assert.ok(finding);
		assert.ok(firstHistoryEntry);
		finding.title = "mutated";
		firstHistoryEntry.push("new");
		assert.equal(persisted.state.findings[0]?.title, "null deref");
		assert.deepEqual(persisted.state.majorFindingHistory, [["off-by-one"]]);
	});
});

void describe("in-flight work is non-durable", () => {
	void test("an in-flight review restores as PENDING with a cleared fingerprint", () => {
		const inFlight: ReviewLoopState = {
			...richState(),
			phase: "re-reviewing",
			reviewInFlight: true,
			fingerprint: "abc123+deadbeef",
			activeOp: { id: 7, kind: "review" },
		};
		const restored = restoreReviewLoopState(serializeReviewLoopState(inFlight));
		assert.equal(restored.phase, "re-reviewing");
		assert.equal(restored.reviewInFlight, false);
		assert.equal(restored.fingerprint, undefined);
		assert.equal(restored.activeOp, undefined);
		// Everything else stays durable.
		assert.equal(restored.round, 2);
		assert.deepEqual(restored.reviewer, inFlight.reviewer);
	});

	void test("a persisted activeOp is dropped on restore for every phase", () => {
		for (const phase of ["fixing", "verifying"] as const) {
			const kind = phase === "fixing" ? ("fix" as const) : ("verify" as const);
			const inFlight: ReviewLoopState = { ...richState(), phase, activeOp: { id: 5, kind } };
			const restored = restoreReviewLoopState(serializeReviewLoopState(inFlight));
			assert.equal(restored.activeOp, undefined, `${phase}: op processes do not survive a resume`);
			assert.equal(restored.phase, phase, `${phase}: the PHASE itself stays durable for reconciliation`);
		}
	});

	void test("a settled phase restores unchanged", () => {
		const restored = restoreReviewLoopState(serializeReviewLoopState(richState()));
		assert.equal(restored.reviewInFlight, false);
		assert.equal(restored.fingerprint, "abc123+deadbeef");
	});
});

void describe("reading from session entries", () => {
	void test("no entries -> initial state", () => {
		assert.deepEqual(readReviewLoopStateFromEntries([]), initialState());
	});

	void test("the LAST valid entry on the branch wins", () => {
		const older = serializeReviewLoopState({ ...richState(), round: 1 });
		const newer = serializeReviewLoopState({ ...richState(), round: 2 });
		const state = readReviewLoopStateFromEntries([entry(older), entry(newer)]);
		assert.equal(state.round, 2);
	});

	void test("foreign and malformed entries are ignored", () => {
		const valid = serializeReviewLoopState(richState());
		const branch: SessionEntryLike[] = [
			{ type: "custom", customType: "stash-state", data: { version: 1 } },
			entry(valid),
			entry({ version: 2, state: { phase: "not-a-phase" } }),
			entry({ version: 1, state: richState() }),
			entry("garbage"),
			{ type: "message" },
		];
		assert.deepEqual(readReviewLoopStateFromEntries(branch), restoreReviewLoopState(valid));
	});

	void test("reading an in-flight snapshot from the branch yields a pending review", () => {
		const inFlight = serializeReviewLoopState({
			...richState(),
			phase: "reviewing",
			reviewInFlight: true,
			activeOp: { id: 9, kind: "review" },
		});
		const state = readReviewLoopStateFromEntries([entry(inFlight)]);
		assert.equal(state.phase, "reviewing");
		assert.equal(state.reviewInFlight, false);
		assert.equal(state.activeOp, undefined);
	});
});
