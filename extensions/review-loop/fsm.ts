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

export interface Finding {
	id: string;
	title: string;
	severity: Severity;
	detail?: string;
}

/** Result of one reviewer run, already parsed by the reviewer module. */
export interface ReviewOutcome {
	/** False when the review was empty, garbled, or the reviewer crashed. */
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
	/** Current review round, 1-based. 0 while no round has started. */
	round: number;
	/** Invalid-review retries consumed within the current round. */
	invalidRetries: number;
	/** Failed verify->fix retries consumed for the current finding batch. */
	fixAttempts: number;
	/** Stable git fingerprint the current round reviews (HEAD + worktree diff hash). */
	fingerprint?: string;
	/** True while a reviewer run is in flight. Non-durable: restored as false. */
	reviewInFlight: boolean;
	reviewer?: ReviewerInfo;
	/** Findings of the last completed review (accepted subset once triaged). */
	findings: Finding[];
	/** Normalized keys of accepted critical/major findings, one array per round. */
	majorFindingHistory: string[][];
	blockedReason?: string;
	hardStopReason?: HardStopReason;
}

export type ReviewLoopEvent =
	| { type: "mode-on"; by: Actor }
	| { type: "mode-off"; by: Actor }
	/** Work maybe settled: `stable` means two consecutive fingerprints agreed. */
	| { type: "work-settled"; fingerprint: string; stable: boolean; forced?: boolean }
	| {
			type: "review-completed";
			outcome: ReviewOutcome;
			/** Fingerprint of the tree at the moment the review returned. */
			currentFingerprint: string;
			reviewer?: ReviewerInfo;
	  }
	| { type: "findings-accepted"; accepted: Finding[] }
	| { type: "fix-completed" }
	| { type: "verify-passed"; fingerprint: string }
	| { type: "verify-failed"; reason?: string }
	| { type: "backend-failure"; reason: string }
	| { type: "round-limit" };

export type ReviewLoopEffect =
	/** Run the entry gate now (compute fingerprint stability, then send work-settled). */
	| { type: "check-gate" }
	| { type: "dispatch-review"; fingerprint: string; round: number; kind: "initial" | "retry" | "re-review" }
	| { type: "dispatch-triage"; findings: Finding[] }
	| { type: "dispatch-fix"; findings: Finding[]; round: number }
	| { type: "dispatch-verify"; reviewedFingerprint: string };

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
		reviewer: state.reviewer ? { ...state.reviewer } : undefined,
		findings: state.findings.map((finding) => ({ ...finding })),
		majorFindingHistory: state.majorFindingHistory.map((round) => [...round]),
	};
}

/** Normalized identity of a finding across rounds (repeated-major detection). */
export function findingKey(finding: Finding): string {
	return `${finding.severity}:${finding.title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

const ACTIVE_PHASES: readonly Phase[] = ["reviewing", "triage", "fixing", "verifying", "re-reviewing"];

export function isModeOn(state: ReviewLoopState): boolean {
	return state.phase !== "idle";
}

const noChange = (state: ReviewLoopState): TransitionResult => ({ state, effects: [] });

function armed(state: ReviewLoopState): ReviewLoopState {
	return {
		...cloneState(state),
		phase: "armed",
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
	return {
		state: next,
		effects: [{ type: "dispatch-review", fingerprint, round: next.round, kind }],
	};
}

function handleWorkSettled(state: ReviewLoopState, event: Extract<ReviewLoopEvent, { type: "work-settled" }>): TransitionResult {
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
			return {
				state: next,
				effects: [
					{
						type: "dispatch-review",
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
	if ((state.phase !== "reviewing" && state.phase !== "re-reviewing") || !state.reviewInFlight) {
		return noChange(state);
	}
	const next = cloneState(state);
	next.reviewInFlight = false;
	if (event.reviewer) next.reviewer = event.reviewer;

	// Fingerprint mismatch: the target moved (or the reviewer reviewed the
	// wrong tree). The result is worthless — discard and wait for stability
	// again. This is NEVER a pass and does not consume an invalid retry.
	const mismatch = event.outcome.fingerprint !== state.fingerprint || event.currentFingerprint !== state.fingerprint;
	if (mismatch) {
		next.fingerprint = undefined;
		return { state: next, effects: [{ type: "check-gate" }] };
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
		return {
			state: next,
			effects: [{ type: "dispatch-review", fingerprint: state.fingerprint ?? "", round: next.round, kind: "retry" }],
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
	// stop for root-cause/design work instead of looping.
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
	return { state: next, effects: [{ type: "dispatch-fix", findings: next.findings, round: next.round }] };
}

function handleVerify(
	state: ReviewLoopState,
	event: Extract<ReviewLoopEvent, { type: "verify-passed" } | { type: "verify-failed" }>,
	config: ReviewLoopConfig,
): TransitionResult {
	if (state.phase !== "verifying") return noChange(state);
	const next = cloneState(state);
	if (event.type === "verify-failed") {
		next.fixAttempts += 1;
		if (next.fixAttempts > config.maxFixAttempts) {
			next.phase = "hard-stop";
			next.hardStopReason = "verify-exhausted";
			return { state: next, effects: [] };
		}
		next.phase = "fixing";
		return { state: next, effects: [{ type: "dispatch-fix", findings: next.findings, round: next.round }] };
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
	return { state: next, effects: [{ type: "check-gate" }] };
}

export function transition(state: ReviewLoopState, event: ReviewLoopEvent, config: ReviewLoopConfig = DEFAULT_CONFIG): TransitionResult {
	switch (event.type) {
		case "mode-on": {
			if (state.phase !== "idle" && state.phase !== "blocked" && state.phase !== "hard-stop") {
				return noChange(state);
			}
			const next = armed(state);
			next.enabledBy = event.by;
			return { state: next, effects: [{ type: "check-gate" }] };
		}
		case "mode-off":
			return { state: initialState(), effects: [] };
		case "work-settled":
			return handleWorkSettled(state, event);
		case "review-completed":
			return handleReviewCompleted(state, event, config);
		case "findings-accepted":
			return handleFindingsAccepted(state, event);
		case "fix-completed": {
			if (state.phase !== "fixing") return noChange(state);
			const next = cloneState(state);
			next.phase = "verifying";
			return {
				state: next,
				effects: [{ type: "dispatch-verify", reviewedFingerprint: state.fingerprint ?? "" }],
			};
		}
		case "verify-passed":
		case "verify-failed":
			return handleVerify(state, event, config);
		case "backend-failure": {
			if (!ACTIVE_PHASES.includes(state.phase) && state.phase !== "armed") return noChange(state);
			const next = cloneState(state);
			next.phase = "blocked";
			next.reviewInFlight = false;
			next.blockedReason = event.reason;
			return { state: next, effects: [] };
		}
		case "round-limit": {
			if (!ACTIVE_PHASES.includes(state.phase)) return noChange(state);
			const next = cloneState(state);
			next.phase = "hard-stop";
			next.hardStopReason = "round-limit";
			next.reviewInFlight = false;
			return { state: next, effects: [] };
		}
	}
}
