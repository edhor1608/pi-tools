/**
 * Review contract — PURE reviewer-facing logic: prompt shape, outcome
 * parsing/validation, and model-family routing. No IO and no imports from
 * the subagent plane, so tests can exercise every rule cheaply.
 */

import type { Finding, ReviewOutcome, Severity } from "./fsm.ts";
import { SEVERITIES } from "./fsm.ts";

// --- Model-family diversity -------------------------------------------------

const CLAUDE_ALIASES = new Set(["fable", "haiku", "opus", "sonnet"]);

export function isClaudeFamily(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const bare = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
	return /^claude(?:-|$)/.test(bare) || CLAUDE_ALIASES.has(bare);
}

/**
 * Default diverse reviewer for Claude-authored work. Must be an EXPLICIT
 * non-Claude model: a bare `{backend:"pi"}` would inherit the parent's
 * Claude model and the manager's routing invariant would send the "diverse"
 * reviewer straight back to Claude Code. Configurable via
 * `.pi/review-loop.json` (`nonClaudeReviewerModel`).
 */
export const DEFAULT_NON_CLAUDE_REVIEWER_MODEL = "gpt-5.6-sol";

/**
 * Prefer a DIFFERENT model family than the one that produced the work
 * (risky-change rule from the ADR): Claude-produced work is reviewed by an
 * explicit non-Claude model on the pi backend, non-Claude work by Claude
 * Code. `preferDifferentFamily: false` keeps the work's own family.
 */
export function pickReviewerRouting(options: { workProducerModelId?: string; preferDifferentFamily: boolean; nonClaudeModel?: string }): {
	backend: "pi" | "claude";
	model?: string;
} {
	const workIsClaude = isClaudeFamily(options.workProducerModelId);
	const nonClaudeModel = options.nonClaudeModel ?? DEFAULT_NON_CLAUDE_REVIEWER_MODEL;
	if (options.preferDifferentFamily) {
		// model must be explicit on the pi side: inheritance would re-route.
		return workIsClaude ? { backend: "pi", model: nonClaudeModel } : { backend: "claude" };
	}
	return workIsClaude ? { backend: "claude" } : { backend: "pi", model: nonClaudeModel };
}

// --- Prompt -----------------------------------------------------------------

export function buildReviewPrompt(options: { fingerprint: string; round: number; kind: "initial" | "retry" | "re-review" }): string {
	const focus =
		options.kind === "re-review"
			? "This is a FRESH re-review after a fix round. Judge the current state with fresh eyes; do not assume earlier findings were fixed."
			: "Review the current state of this working tree with fresh eyes.";
	return [
		`You are an independent code reviewer (round ${options.round}).`,
		focus,
		"",
		"Rules:",
		"- READ-ONLY: never modify files, never run write/fix commands, never commit, push, or merge.",
		"- Inspect the uncommitted changes and recent commits (`git status`, `git diff`, `git log`) plus any files needed for context.",
		"- Report only concrete, verifiable findings. No style nitpicks unless they hide bugs.",
		"- Rank every finding with a severity: critical | major | minor | info.",
		"",
		`Target fingerprint (echo it back EXACTLY): ${options.fingerprint}`,
		"",
		"Your FINAL message must end with exactly one fenced JSON block of this shape:",
		"```json",
		'{"reviewedFingerprint": "<the fingerprint above>", "verdict": "clean" | "findings", "findings": [{"title": "...", "severity": "critical|major|minor|info", "detail": "..."}]}',
		"```",
		'Use "verdict": "clean" with an empty findings array only when you found nothing worth fixing.',
	].join("\n");
}

// --- Outcome parsing --------------------------------------------------------

const isSeverity = (value: unknown): value is Severity => typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);

/**
 * Parse a reviewer's raw final text into a `ReviewOutcome`. Anything empty,
 * garbled, missing the fingerprint echo, or verdict-inconsistent is INVALID
 * (`valid: false`) — the FSM retries it bounded and never treats it as a
 * pass. Verdict consistency is strict:
 * - "clean" requires ZERO findings,
 * - "findings" requires at least one structurally meaningful finding
 *   (non-empty title). A findings verdict with an empty list would otherwise
 *   sail through the FSM's zero-findings branch as a pass.
 */
export function parseReviewOutcome(raw: string, expectedFingerprint: string): ReviewOutcome {
	const invalid: ReviewOutcome = { valid: false, fingerprint: expectedFingerprint, findings: [] };
	const blocks = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/g)];
	const source = blocks.at(-1)?.[1] ?? raw.trim();
	if (!source) return invalid;
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return invalid;
	}
	if (typeof parsed !== "object" || parsed === null) return invalid;
	const record = parsed as Record<string, unknown>;
	if (typeof record.reviewedFingerprint !== "string") return invalid;
	if (record.verdict !== "clean" && record.verdict !== "findings") return invalid;
	if (!Array.isArray(record.findings)) return invalid;
	const findings: Finding[] = [];
	for (const [index, entry] of record.findings.entries()) {
		if (typeof entry !== "object" || entry === null) return invalid;
		const candidate = entry as Record<string, unknown>;
		if (typeof candidate.title !== "string" || candidate.title.trim().length === 0 || !isSeverity(candidate.severity)) {
			return invalid;
		}
		findings.push({
			id: `f${index + 1}`,
			title: candidate.title,
			severity: candidate.severity,
			detail: typeof candidate.detail === "string" ? candidate.detail : undefined,
		});
	}
	// Verdict/findings must agree in BOTH directions; anything else is garbled.
	if (record.verdict === "clean" && findings.length > 0) return invalid;
	if (record.verdict === "findings" && findings.length === 0) return invalid;
	return {
		valid: true,
		fingerprint: record.reviewedFingerprint,
		findings,
		verdict: record.verdict,
	};
}
