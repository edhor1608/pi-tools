/**
 * Session persistence for the review-loop FSM.
 *
 * Mechanics imitate stash.ts / structured-compaction: every state mutation
 * appends a full-state custom entry (`pi.appendEntry`), and reconstruction
 * reads the LAST valid entry on the current session branch. Custom entries
 * never enter model context, so the loop state is invisible to the LLM
 * except through the explicit status/tool surfaces.
 *
 * Resume semantics: durable state (phase, epoch, round, fingerprint,
 * findings, owner, reviewer info, blocked reason) survives a session resume,
 * but in-flight PROCESSES (reviewer subagents, verify commands, fix turns)
 * do not — `restoreReviewLoopState` therefore clears `activeOp` and
 * normalizes an in-flight review to PENDING. index.ts then feeds the FSM a
 * `resumed` event, which reconciles every active phase into a durable
 * pending action: pending review -> gate check, fixing -> re-dispatched fix,
 * verifying -> re-run verification, triage -> re-run triage.
 */

import {
	type ActiveOp,
	cloneState,
	type Finding,
	type FixOwner,
	HARD_STOP_REASONS,
	type HardStopReason,
	initialState,
	OP_KINDS,
	PHASES,
	type Phase,
	type ReviewerInfo,
	type ReviewLoopState,
	SEVERITIES,
} from "./fsm.ts";

export const REVIEW_LOOP_ENTRY_TYPE = "review-loop-state";

export interface PersistedReviewLoopState {
	version: 2;
	state: ReviewLoopState;
}

/** Minimal structural view of a Pi `SessionEntry`; keeps this module IO-free. */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isPhase = (value: unknown): value is Phase => typeof value === "string" && (PHASES as readonly string[]).includes(value);

const isHardStopReason = (value: unknown): value is HardStopReason =>
	typeof value === "string" && (HARD_STOP_REASONS as readonly string[]).includes(value);

const isActiveOp = (value: unknown): value is ActiveOp =>
	isObject(value) && typeof value.id === "number" && typeof value.kind === "string" && (OP_KINDS as readonly string[]).includes(value.kind);

const isFixOwner = (value: unknown): value is FixOwner =>
	isObject(value) && (value.kind === "root" || (value.kind === "subagent" && typeof value.id === "string"));

const isFinding = (value: unknown): value is Finding =>
	isObject(value) &&
	typeof value.id === "string" &&
	typeof value.title === "string" &&
	typeof value.severity === "string" &&
	(SEVERITIES as readonly string[]).includes(value.severity) &&
	(value.detail === undefined || typeof value.detail === "string");

const isReviewerInfo = (value: unknown): value is ReviewerInfo =>
	isObject(value) &&
	typeof value.backend === "string" &&
	(value.model === undefined || typeof value.model === "string") &&
	(value.subagentId === undefined || typeof value.subagentId === "string");

const isReviewLoopState = (value: unknown): value is ReviewLoopState =>
	isObject(value) &&
	isPhase(value.phase) &&
	(value.enabledBy === undefined || value.enabledBy === "user" || value.enabledBy === "agent") &&
	typeof value.epoch === "number" &&
	typeof value.opSeq === "number" &&
	(value.activeOp === undefined || isActiveOp(value.activeOp)) &&
	isFixOwner(value.owner) &&
	typeof value.round === "number" &&
	typeof value.invalidRetries === "number" &&
	typeof value.fixAttempts === "number" &&
	(value.fingerprint === undefined || typeof value.fingerprint === "string") &&
	typeof value.reviewInFlight === "boolean" &&
	(value.reviewer === undefined || isReviewerInfo(value.reviewer)) &&
	Array.isArray(value.findings) &&
	value.findings.every(isFinding) &&
	Array.isArray(value.majorFindingHistory) &&
	value.majorFindingHistory.every((round) => Array.isArray(round) && round.every((key) => typeof key === "string")) &&
	(value.blockedReason === undefined || typeof value.blockedReason === "string") &&
	(value.hardStopReason === undefined || isHardStopReason(value.hardStopReason));

export const isPersistedReviewLoopState = (value: unknown): value is PersistedReviewLoopState =>
	isObject(value) && value.version === 2 && isReviewLoopState(value.state);

export function serializeReviewLoopState(state: ReviewLoopState): PersistedReviewLoopState {
	return { version: 2, state: cloneState(state) };
}

/**
 * Turn a persisted snapshot back into a runtime state. Processes are
 * non-durable: `activeOp` is dropped and an in-flight review comes back as
 * PENDING (`reviewInFlight: false`, fingerprint cleared) so the entry gate
 * re-dispatches it against the tree as it exists after the resume — never
 * trusting a stale in-flight run. The follow-up `resumed` FSM event (sent by
 * index.ts) re-triggers fixing/verifying/triage phases with fresh op ids.
 */
export function restoreReviewLoopState(persisted: PersistedReviewLoopState): ReviewLoopState {
	const state = cloneState(persisted.state);
	// delete (not `= undefined`): the JSON boundary drops absent keys, and
	// deepStrictEqual treats an explicit-undefined key as different.
	delete state.activeOp;
	if (state.reviewInFlight) {
		state.reviewInFlight = false;
		delete state.fingerprint;
	}
	return state;
}

/** Last valid review-loop entry on the branch wins; none -> initial state. */
export function readReviewLoopStateFromEntries(entries: readonly SessionEntryLike[]): ReviewLoopState {
	const snapshot = entries
		.filter((entry) => entry.type === "custom" && entry.customType === REVIEW_LOOP_ENTRY_TYPE)
		.map((entry) => entry.data)
		.reverse()
		.find(isPersistedReviewLoopState);
	return snapshot ? restoreReviewLoopState(snapshot) : initialState();
}
