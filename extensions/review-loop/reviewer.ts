/**
 * Reviewer execution for the review loop.
 *
 * Reviews run through the EXISTING subagent execution plane, consumed behind
 * the narrow `ReviewerBackend` interface below. The subagent-backed
 * implementation uses only the smallest possible surface of that plane:
 * `createSubagentRuntime()` + the `SubagentManager` service, and of the
 * manager shape only `spawn`, `waitFor`, and `view.get`. It deliberately does
 * NOT touch steering, cancellation, orchestration trees, or the takeover UI —
 * a reviewer is spawn-once / read-result / done.
 *
 * Note: this composes the exported manager layer into its own runtime (the
 * subagents extension keeps its live manager instance private in its closure).
 * Model routing invariants (Claude-family models -> Claude Code backend,
 * never OpenCode) are enforced inside `manager.spawn` and are inherited here.
 * A backend failure surfaces as `ok: false` and becomes FSM state "blocked";
 * there is NO provider fallback of any kind.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Finding, ReviewOutcome, Severity } from "./fsm.ts";
import { SEVERITIES } from "./fsm.ts";
import type { BackendName } from "../subagents/src/domain.ts";
import { SubagentManager, type SubagentManagerShape } from "../subagents/src/manager.ts";
import { createSubagentRuntime, runTool, type SubagentRuntime } from "../subagents/src/runtime.ts";

export interface ReviewRequest {
	prompt: string;
	title: string;
	cwd: string;
	backend: BackendName;
	/** Model hint; omitted = backend default. Claude aliases reroute to Claude Code. */
	model?: string;
}

export interface ReviewerRunResult {
	ok: boolean;
	/** Raw final text of the reviewer (empty when the run failed). */
	raw: string;
	error?: string;
	subagentId?: string;
	modelLabel?: string;
}

/** The ONLY surface the review loop needs from any execution plane. */
export interface ReviewerBackend {
	runReview(request: ReviewRequest): Promise<ReviewerRunResult>;
	dispose(): Promise<void>;
}

/** Session context the pi backend needs to resolve models; provided lazily by index.ts. */
export interface ReviewerSpawnContext {
	parentCwd: string;
	inheritedModel?: { provider: string; id: string };
	inheritedThinkingLevel?: string;
	modelRegistry?: ModelRegistry;
}

export function createSubagentReviewerBackend(getSpawnContext: () => ReviewerSpawnContext): ReviewerBackend {
	let runtime: SubagentRuntime | undefined;
	let managerPromise: Promise<SubagentManagerShape> | undefined;

	const getManager = () => {
		runtime ??= createSubagentRuntime();
		managerPromise ??= runtime.runPromise(SubagentManager);
		return managerPromise;
	};

	return {
		async runReview(request) {
			try {
				const manager = await getManager();
				const active = runtime;
				if (!active) throw new Error("reviewer runtime already disposed");
				const snap = await runTool(
					active,
					manager.spawn(request.backend, {
						prompt: request.prompt,
						title: request.title,
						cwd: request.cwd,
						mode: "worker",
						model: request.model,
						parent: getSpawnContext(),
					}),
					{ interruptMessage: "Reviewer spawn aborted." },
				);
				await runTool(active, manager.waitFor([snap.id]), { interruptMessage: "Reviewer wait aborted." });
				const settled = manager.view.get(snap.id);
				if (!settled) return { ok: false, raw: "", error: "reviewer disappeared from the subagent registry" };
				if (settled.status === "error") {
					return {
						ok: false,
						raw: settled.finalText,
						error: settled.errorText ?? "reviewer failed",
						subagentId: settled.id,
						modelLabel: settled.meta.modelLabel,
					};
				}
				return { ok: true, raw: settled.finalText, subagentId: settled.id, modelLabel: settled.meta.modelLabel };
			} catch (error) {
				return { ok: false, raw: "", error: error instanceof Error ? error.message : String(error) };
			}
		},
		async dispose() {
			const closing = runtime;
			runtime = undefined;
			managerPromise = undefined;
			await closing?.dispose();
		},
	};
}

// --- Model-family diversity -------------------------------------------------

const CLAUDE_ALIASES = new Set(["fable", "haiku", "opus", "sonnet"]);

export function isClaudeFamily(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const bare = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
	return /^claude(?:-|$)/.test(bare) || CLAUDE_ALIASES.has(bare);
}

/**
 * Prefer a DIFFERENT model family than the one that produced the work
 * (risky-change rule from the ADR): Claude-produced work is reviewed by a
 * native Pi model (Codex family via the pi backend default), non-Claude work
 * by Claude Code. `preferDifferentFamily: false` keeps the work's own family.
 */
export function pickReviewerRouting(options: { workProducerModelId?: string; preferDifferentFamily: boolean }): {
	backend: BackendName;
	model?: string;
} {
	const workIsClaude = isClaudeFamily(options.workProducerModelId);
	if (options.preferDifferentFamily) {
		return workIsClaude ? { backend: "pi" } : { backend: "claude" };
	}
	return workIsClaude ? { backend: "claude" } : { backend: "pi" };
}

// --- Prompt + outcome parsing ----------------------------------------------

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

const isSeverity = (value: unknown): value is Severity => typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);

/**
 * Parse a reviewer's raw final text into a `ReviewOutcome`. Anything empty,
 * garbled, or missing the fingerprint echo is INVALID (`valid: false`) — the
 * FSM retries it bounded and never treats it as a pass.
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
		if (typeof candidate.title !== "string" || !isSeverity(candidate.severity)) return invalid;
		findings.push({
			id: `f${index + 1}`,
			title: candidate.title,
			severity: candidate.severity,
			detail: typeof candidate.detail === "string" ? candidate.detail : undefined,
		});
	}
	// A "clean" verdict alongside findings is contradictory -> garbled.
	if (record.verdict === "clean" && findings.length > 0) return invalid;
	return {
		valid: true,
		fingerprint: record.reviewedFingerprint,
		findings,
		verdict: record.verdict,
	};
}
