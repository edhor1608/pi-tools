/**
 * Review-loop state machine — PURE, no IO.
 *
 * The extension entry (index.ts) feeds events in and interprets the returned
 * effects; this module never touches git, subagents, timers, or the session.
 *
 * Binding rules (from docs/decisions-log.md, "2026-08-01 Pi-Native Personal
 * Agent System"):
 * - Entry gate: only a STABLE target is reviewed. A review result is only
 *   valid against the git fingerprint it reviewed; a mismatch discards the
 *   result and re-arms (it is NEVER a pass).
 * - A valid accepted finding ALWAYS causes fix -> verification -> fresh
 *   re-review. These are mandatory, not optional follow-ups.
 * - Loop until the accepted lenses are clean OR a hard stop fires:
 *   round limit (default 5) or a repeated major finding across rounds
 *   (reason "root-cause-needed").
 * - An invalid review (empty/garbled/reviewer crashed) is retried a bounded
 *   number of times and never treated as a pass.
 * - Backend failure -> "blocked" with a visible reason. Never fall back to
 *   OpenCode or any other provider.
 * - The mode never merges or lands work. No effect in this machine can
 *   express a git push/merge, by construction.
 *
 * Async-epoch isolation: `epoch` increments on every arm/off cycle and every
 * async operation gets a fresh `opId` from the monotonic `opSeq`. Completion
 * and failure events must carry the matching (epoch, opId) pair or they are
 * ignored — a reviewer or verifier from a previous on/off cycle can never
 * complete, fail, or block a newer loop.
 */

export const PHASES = [
	"idle",
	"armed",
	"reviewing",
	"triage",
	"fixing",
	"verifying",
	"re-reviewing",
	"clean",
	"blocked",
	"hard-stop",
] as const;
export type Phase = (typeof PHASES)[number];

export const SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const HARD_STOP_REASONS = ["round-limit", "root-cause-needed", "verify-exhausted"] as const;
export type HardStopReason = (typeof HARD_STOP_REASONS)[number];

export type Actor = "user" | "agent";

export const OP_KINDS = ["review", "fix", "verify"] as const;
export type OpKind = (typeof OP_KINDS)[number];

export interface ActiveOp {
	id: number;
	kind: OpKind;
}

/**
 * Who produced the reviewed work and therefore owns the fix batch (ADR:
 * "same-worker fix lineage"). Root-authored work is fixed by the root
 * session; work produced by a tracked subagent is fixed by that subagent.
 */
export type FixOwner = { kind: "root" } | { kind: "subagent"; id: string };

export interface Finding {
	id: string;
	title: string;
	severity: Severity;
	detail?: string;
}

/** Result of one reviewer run, already parsed by the review contract. */
export interface ReviewOutcome {
	/** False when the review was empty, garbled, or verdict/findings disagree. */
	valid: boolean;
	/** The fingerprint the reviewer claims to have reviewed. */
	fingerprint: string;
	findings: Finding[];
	/** Free-text verdict from the reviewer, for display only. */
	verdict?: string;
}

export interface ReviewerInfo {
	backend: string;
	model?: string;
	subagentId?: string;
}

export interface ReviewLoopState {
	phase: Phase;
	enabledBy?: Actor;
	/** Bumped on every arm/off cycle; stale-event isolation (with opId). */
	epoch: number;
	/** Monotonic dispatch counter; NEVER reset while the extension lives. */
	opSeq: number;
	/** The single in-flight async operation. Non-durable: cleared on restore. */
	activeOp?: ActiveOp;
	/** Owner of the reviewed work; the fix batch is routed to this lineage. */
	owner: FixOwner;
	/** Current review round, 1-based. 0 while no round has started. */
	round: number;
	/** Invalid-review retries consumed within the current round. */
	invalidRetries: number;
	/** Failed verify->fix retries consumed for the current finding batch. */
	fixAttempts: number;
	/** Stable git fingerprint the current round reviews (HEAD + tree hash). */
	fingerprint?: string;
	/** True while a reviewer run is in flight. Non-durable: restored as false. */
	reviewInFlight: boolean;
	reviewer?: ReviewerInfo;
	/** Findings of the last completed review (accepted subset once triaged). */
	findings: Finding[];
	/** Severity-independent keys of accepted critical/major findings, per round. */
	majorFindingHistory: string[][];
	blockedReason?: string;
	hardStopReason?: HardStopReason;
}

export type ReviewLoopEvent =
	| { type: "mode-on"; by: Actor; owner?: FixOwner }
	| { type: "mode-off"; by: Actor }
	/** Work maybe settled: `stable` means two consecutive fingerprints agreed. */
	| { type: "work-settled"; epoch: number; fingerprint: string; stable: boolean; forced?: boolean }
	| {
			type: "review-completed";
			epoch: number;
			opId: number;
			outcome: ReviewOutcome;
			/** Fingerprint of the tree at the moment the review returned. */
			currentFingerprint: string;
			reviewer?: ReviewerInfo;
	  }
	| { type: "findings-accepted"; accepted: Finding[] }
	| { type: "fix-completed"; epoch: number; opId: number }
	| { type: "verify-passed"; epoch: number; opId: number; fingerprint: string }
	| { type: "verify-failed"; epoch: number; opId: number; reason?: string }
	/** opId omitted for failures outside an op (e.g. fingerprint computation). */
	| { type: "backend-failure"; epoch: number; opId?: number; reason: string }
	| { type: "round-limit" }
	/** Session resume/tree switch: reconcile restored state into pending actions. */
	| { type: "resumed" };

export type ReviewLoopEffect =
	/** Run the entry gate now (compute fingerprint stability, then send work-settled). */
	| { type: "check-gate"; epoch: number }
	| {
			type: "dispatch-review";
			epoch: number;
			opId: number;
			fingerprint: string;
			round: number;
			kind: "initial" | "retry" | "re-review";
	  }
	| { type: "dispatch-triage"; findings: Finding[] }
	| { type: "dispatch-fix"; epoch: number; opId: number; findings: Finding[]; round: number; owner: FixOwner }
	| { type: "dispatch-verify"; epoch: number; opId: number; reviewedFingerprint: string };

export interface ReviewLoopConfig {
	/** Hard stop after this many review rounds. */
	maxRounds: number;
	/** How often an invalid review is re-dispatched before blocking. */
	maxInvalidRetries: number;
	/** How often verify-failed may loop back into fixing before hard-stopping. */
	maxFixAttempts: number;
}

export const DEFAULT_CONFIG: ReviewLoopConfig = {
	maxRounds: 5,
	maxInvalidRetries: 2,
	maxFixAttempts: 3,
};

export interface TransitionResult {
	state: ReviewLoopState;
	effects: ReviewLoopEffect[];
}

export function initialState(): ReviewLoopState {
	return {
		phase: "idle",
		epoch: 0,
		opSeq: 0,
		owner: { kind: "root" },
		round: 0,
		invalidRetries: 0,
		fixAttempts: 0,
		reviewInFlight: false,
		findings: [],
		majorFindingHistory: [],
	};
}

export function cloneState(state: ReviewLoopState): ReviewLoopState {
	return {
		...state,
		activeOp: state.activeOp ? { ...state.activeOp } : undefined,
		owner: { ...state.owner },
		reviewer: state.reviewer ? { ...state.reviewer } : undefined,
		findings: state.findings.map((finding) => ({ ...finding })),
		majorFindingHistory: state.majorFindingHistory.map((round) => [...round]),
	};
}

/**
 * Normalized identity of a finding across rounds (repeated-major detection).
 * Deliberately severity-INDEPENDENT: a reviewer reclassifying the same issue
 * from major to critical must still trip the root-cause hard stop.
 */
export function findingKey(finding: Finding): string {
	return finding.title.trim().toLowerCase().replace(/\s+/g, " ");
}

const ACTIVE_PHASES: readonly Phase[] = ["reviewing", "triage", "fixing", "verifying", "re-reviewing"];

export function isModeOn(state: ReviewLoopState): boolean {
	return state.phase !== "idle";
}

const noChange = (state: ReviewLoopState): TransitionResult => ({ state, effects: [] });

/** Stale-async guard: the event must belong to the current epoch and op. */
const matchesOp = (state: ReviewLoopState, event: { epoch: number; opId: number }, kind: OpKind): boolean =>
	event.epoch === state.epoch && state.activeOp?.kind === kind && state.activeOp.id === event.opId;

/** Allocate the next op id on a draft state. */
function beginOp(draft: ReviewLoopState, kind: OpKind): number {
	draft.opSeq += 1;
	draft.activeOp = { id: draft.opSeq, kind };
	return draft.opSeq;
}

function armed(state: ReviewLoopState): ReviewLoopState {
	return {
		...cloneState(state),
		phase: "armed",
		epoch: state.epoch + 1,
		activeOp: undefined,
		round: 0,
		invalidRetries: 0,
		fixAttempts: 0,
		fingerprint: undefined,
		reviewInFlight: false,
		reviewer: undefined,
		findings: [],
		majorFindingHistory: [],
		blockedReason: undefined,
		hardStopReason: undefined,
	};
}

function startRound(state: ReviewLoopState, fingerprint: string, kind: "initial" | "re-review"): TransitionResult {
	const next = cloneState(state);
	next.phase = kind === "initial" ? "reviewing" : "re-reviewing";
	next.round = kind === "initial" ? 1 : state.round;
	next.fingerprint = fingerprint;
	next.reviewInFlight = true;
	next.invalidRetries = 0;
	next.blockedReason = undefined;
	if (kind === "initial") {
		next.findings = [];
		next.majorFindingHistory = [];
		next.fixAttempts = 0;
	}
	const opId = beginOp(next, "review");
	return {
		state: next,
		effects: [{ type: "dispatch-review", epoch: next.epoch, opId, fingerprint, round: next.round, kind }],
	};
}

function handleWorkSettled(state: ReviewLoopState, event: Extract<ReviewLoopEvent, { type: "work-settled" }>): TransitionResult {
	// A gate check from a previous on/off cycle must not steer this one.
	if (event.epoch !== state.epoch) return noChange(state);
	if (!event.stable) return noChange(state);
	switch (state.phase) {
		case "armed":
			return startRound(state, event.fingerprint, "initial");
		case "clean":
			// New work after a clean verdict starts a fresh loop for the new target.
			if (event.fingerprint === state.fingerprint) return noChange(state);
			return startRound(armed(state), event.fingerprint, "initial");
		case "reviewing":
		case "re-reviewing": {
			// Pending (restored or awaiting a fresh fingerprint after a fix):
			// dispatch now. An in-flight review is never double-dispatched.
			if (state.reviewInFlight) return noChange(state);
			const next = cloneState(state);
			next.fingerprint = event.fingerprint;
			next.reviewInFlight = true;
			const opId = beginOp(next, "review");
			return {
				state: next,
				effects: [
					{
						type: "dispatch-review",
						epoch: next.epoch,
						opId,
						fingerprint: event.fingerprint,
						round: next.round,
						kind: state.phase === "reviewing" ? "initial" : "re-review",
					},
				],
			};
		}
		case "blocked":
			// Only an explicit user/agent retry (/review-loop now) leaves blocked.
			if (!event.forced) return noChange(state);
			return startRound(armed(state), event.fingerprint, "initial");
		default:
			return noChange(state);
	}
}

function handleReviewCompleted(
	state: ReviewLoopState,
	event: Extract<ReviewLoopEvent, { type: "review-completed" }>,
	config: ReviewLoopConfig,
): TransitionResult {
	if (state.phase !== "reviewing" && state.phase !== "re-reviewing") return noChange(state);
	if (!state.reviewInFlight || !matchesOp(state, event, "review")) return noChange(state);
	const next = cloneState(state);
	next.reviewInFlight = false;
	next.activeOp = undefined;
	if (event.reviewer) next.reviewer = event.reviewer;

	// Fingerprint mismatch: the target moved (or the reviewer reviewed the
	// wrong tree). The result is worthless — discard and wait for stability
	// again. This is NEVER a pass and does not consume an invalid retry.
	const mismatch = event.outcome.fingerprint !== state.fingerprint || event.currentFingerprint !== state.fingerprint;
	if (mismatch) {
		next.fingerprint = undefined;
		return { state: next, effects: [{ type: "check-gate", epoch: next.epoch }] };
	}

	// Invalid review: bounded retry, never a pass.
	if (!event.outcome.valid) {
		next.invalidRetries += 1;
		if (next.invalidRetries > config.maxInvalidRetries) {
			next.phase = "blocked";
			next.blockedReason = `review invalid after ${config.maxInvalidRetries} retries — never treated as a pass`;
			return { state: next, effects: [] };
		}
		next.reviewInFlight = true;
		const opId = beginOp(next, "review");
		return {
			state: next,
			effects: [
				{ type: "dispatch-review", epoch: next.epoch, opId, fingerprint: state.fingerprint ?? "", round: next.round, kind: "retry" },
			],
		};
	}

	next.invalidRetries = 0;
	if (event.outcome.findings.length === 0) {
		next.phase = "clean";
		next.findings = [];
		return { state: next, effects: [] };
	}
	next.phase = "triage";
	next.findings = event.outcome.findings.map((finding) => ({ ...finding }));
	return { state: next, effects: [{ type: "dispatch-triage", findings: next.findings }] };
}

function handleFindingsAccepted(state: ReviewLoopState, event: Extract<ReviewLoopEvent, { type: "findings-accepted" }>): TransitionResult {
	if (state.phase !== "triage") return noChange(state);
	const next = cloneState(state);
	if (event.accepted.length === 0) {
		// Every finding was rejected in triage: the accepted lenses are clean.
		next.phase = "clean";
		next.findings = [];
		return { state: next, effects: [] };
	}
	next.findings = event.accepted.map((finding) => ({ ...finding }));

	// Repeated major findings across rounds mean polishing will not converge:
	// stop for root-cause/design work instead of looping. Keys are
	// severity-independent so reclassification cannot defeat the stop.
	const majorKeys = next.findings.filter((finding) => finding.severity === "critical" || finding.severity === "major").map(findingKey);
	const seenBefore = new Set(state.majorFindingHistory.flat());
	if (majorKeys.some((key) => seenBefore.has(key))) {
		next.phase = "hard-stop";
		next.hardStopReason = "root-cause-needed";
		return { state: next, effects: [] };
	}
	next.majorFindingHistory = [...state.majorFindingHistory.map((round) => [...round]), majorKeys];

	// A valid accepted finding ALWAYS causes a fix. Mandatory, not optional.
	next.phase = "fixing";
	const opId = beginOp(next, "fix");
	return {
		state: next,
		effects: [{ type: "dispatch-fix", epoch: next.epoch, opId, findings: next.findings, round: next.round, owner: next.owner }],
	};
}

function handleVerify(
	state: ReviewLoopState,
	event: Extract<ReviewLoopEvent, { type: "verify-passed" } | { type: "verify-failed" }>,
	config: ReviewLoopConfig,
): TransitionResult {
	if (state.phase !== "verifying" || !matchesOp(state, event, "verify")) return noChange(state);
	const next = cloneState(state);
	next.activeOp = undefined;
	if (event.type === "verify-failed") {
		next.fixAttempts += 1;
		if (next.fixAttempts > config.maxFixAttempts) {
			next.phase = "hard-stop";
			next.hardStopReason = "verify-exhausted";
			return { state: next, effects: [] };
		}
		next.phase = "fixing";
		const opId = beginOp(next, "fix");
		return {
			state: next,
			effects: [{ type: "dispatch-fix", epoch: next.epoch, opId, findings: next.findings, round: next.round, owner: next.owner }],
		};
	}
	// Verified fix -> a fresh re-review is MANDATORY, unless the round limit
	// hard-stops the loop first.
	next.fixAttempts = 0;
	if (state.round >= config.maxRounds) {
		next.phase = "hard-stop";
		next.hardStopReason = "round-limit";
		return { state: next, effects: [] };
	}
	next.phase = "re-reviewing";
	next.round = state.round + 1;
	next.reviewInFlight = false;
	// The fix changed the tree: the old fingerprint is dead. The gate must
	// observe a NEW stable fingerprint before the re-review dispatches.
	next.fingerprint = undefined;
	return { state: next, effects: [{ type: "check-gate", epoch: next.epoch }] };
}

/**
 * Reconcile a restored session into durable pending actions. In-flight ops
 * were lost with the process; every active phase re-triggers its own work.
 */
function handleResumed(state: ReviewLoopState): TransitionResult {
	switch (state.phase) {
		case "armed":
			return { state, effects: [{ type: "check-gate", epoch: state.epoch }] };
		case "reviewing":
		case "re-reviewing":
			// Restore guarantees reviewInFlight=false: the gate re-dispatches.
			return { state, effects: [{ type: "check-gate", epoch: state.epoch }] };
		case "triage":
			return { state, effects: [{ type: "dispatch-triage", findings: state.findings.map((finding) => ({ ...finding })) }] };
		case "fixing": {
			const next = cloneState(state);
			const opId = beginOp(next, "fix");
			return {
				state: next,
				effects: [{ type: "dispatch-fix", epoch: next.epoch, opId, findings: next.findings, round: next.round, owner: next.owner }],
			};
		}
		case "verifying": {
			const next = cloneState(state);
			const opId = beginOp(next, "verify");
			return {
				state: next,
				effects: [{ type: "dispatch-verify", epoch: next.epoch, opId, reviewedFingerprint: next.fingerprint ?? "" }],
			};
		}
		default:
			return noChange(state);
	}
}

export function transition(state: ReviewLoopState, event: ReviewLoopEvent, config: ReviewLoopConfig = DEFAULT_CONFIG): TransitionResult {
	switch (event.type) {
		case "mode-on": {
			if (state.phase !== "idle" && state.phase !== "blocked" && state.phase !== "hard-stop") {
				// Already active: an explicit owner still UPDATES the fix lineage
				// while the loop is merely armed (no round running). It never
				// retargets an in-flight op mid-round — mid-round phases ignore it.
				if (state.phase === "armed" && event.owner) {
					const next = cloneState(state);
					next.owner = { ...event.owner };
					return { state: next, effects: [] };
				}
				return noChange(state);
			}
			const next = armed(state);
			next.enabledBy = event.by;
			next.owner = event.owner ? { ...event.owner } : { kind: "root" };
			return { state: next, effects: [{ type: "check-gate", epoch: next.epoch }] };
		}
		case "mode-off":
			// Preserve epoch monotonicity so async work from this cycle can
			// never match a later cycle; preserve opSeq for the same reason.
			return {
				state: { ...initialState(), epoch: state.epoch + 1, opSeq: state.opSeq },
				effects: [],
			};
		case "work-settled":
			return handleWorkSettled(state, event);
		case "review-completed":
			return handleReviewCompleted(state, event, config);
		case "findings-accepted":
			return handleFindingsAccepted(state, event);
		case "fix-completed": {
			if (state.phase !== "fixing" || !matchesOp(state, event, "fix")) return noChange(state);
			const next = cloneState(state);
			next.phase = "verifying";
			const opId = beginOp(next, "verify");
			return {
				state: next,
				effects: [{ type: "dispatch-verify", epoch: next.epoch, opId, reviewedFingerprint: state.fingerprint ?? "" }],
			};
		}
		case "verify-passed":
		case "verify-failed":
			return handleVerify(state, event, config);
		case "backend-failure": {
			if (!ACTIVE_PHASES.includes(state.phase) && state.phase !== "armed") return noChange(state);
			// Stale failures from an earlier cycle/op must not block this loop.
			if (event.epoch !== state.epoch) return noChange(state);
			if (event.opId !== undefined && state.activeOp?.id !== event.opId) return noChange(state);
			const next = cloneState(state);
			next.phase = "blocked";
			next.reviewInFlight = false;
			next.activeOp = undefined;
			next.blockedReason = event.reason;
			return { state: next, effects: [] };
		}
		case "round-limit": {
			if (!ACTIVE_PHASES.includes(state.phase)) return noChange(state);
			const next = cloneState(state);
			next.phase = "hard-stop";
			next.hardStopReason = "round-limit";
			next.reviewInFlight = false;
			next.activeOp = undefined;
			return { state: next, effects: [] };
		}
		case "resumed":
			return handleResumed(state);
	}
}
