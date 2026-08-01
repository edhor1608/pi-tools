import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	buildReviewPrompt,
	DEFAULT_NON_CLAUDE_REVIEWER_MODEL,
	isClaudeFamily,
	parseReviewOutcome,
	pickReviewerRouting,
} from "./review-contract.ts";

const FP = "abc123+deadbeef";

const payload = (body: unknown): string => `Some prose.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;

void describe("verdict consistency", () => {
	void test("clean verdict with zero findings is valid", () => {
		const outcome = parseReviewOutcome(payload({ reviewedFingerprint: FP, verdict: "clean", findings: [] }), FP);
		assert.equal(outcome.valid, true);
		assert.equal(outcome.findings.length, 0);
		assert.equal(outcome.fingerprint, FP);
	});

	void test("findings verdict with concrete findings is valid", () => {
		const outcome = parseReviewOutcome(
			payload({ reviewedFingerprint: FP, verdict: "findings", findings: [{ title: "bug", severity: "major", detail: "x" }] }),
			FP,
		);
		assert.equal(outcome.valid, true);
		assert.equal(outcome.findings.length, 1);
		assert.equal(outcome.findings[0]?.severity, "major");
	});

	void test("findings verdict with an EMPTY list is INVALID, never a pass", () => {
		const outcome = parseReviewOutcome(payload({ reviewedFingerprint: FP, verdict: "findings", findings: [] }), FP);
		assert.equal(outcome.valid, false);
		assert.equal(outcome.findings.length, 0, "invalid outcomes carry no findings the FSM could treat as clean");
	});

	void test("clean verdict alongside findings is INVALID", () => {
		const outcome = parseReviewOutcome(
			payload({ reviewedFingerprint: FP, verdict: "clean", findings: [{ title: "bug", severity: "major" }] }),
			FP,
		);
		assert.equal(outcome.valid, false);
	});

	void test("structurally meaningless findings (empty title, bad severity) are INVALID", () => {
		for (const bad of [
			{ title: "   ", severity: "major" },
			{ title: "bug", severity: "catastrophic" },
			{ severity: "major" },
			"not-an-object",
		]) {
			const outcome = parseReviewOutcome(payload({ reviewedFingerprint: FP, verdict: "findings", findings: [bad] }), FP);
			assert.equal(outcome.valid, false, JSON.stringify(bad));
		}
	});

	void test("empty, garbled, or fingerprint-less output is INVALID", () => {
		for (const raw of [
			"",
			"no json here",
			"```json\n{broken\n```",
			payload({ verdict: "clean", findings: [] }),
			payload({ reviewedFingerprint: FP, verdict: "maybe", findings: [] }),
			payload({ reviewedFingerprint: FP, verdict: "clean" }),
		]) {
			assert.equal(parseReviewOutcome(raw, FP).valid, false, JSON.stringify(raw.slice(0, 40)));
		}
	});

	void test("the LAST json block wins (reviewers often quote examples earlier)", () => {
		const raw =
			payload({ reviewedFingerprint: "old", verdict: "findings", findings: [{ title: "draft", severity: "info" }] }) +
			payload({ reviewedFingerprint: FP, verdict: "clean", findings: [] });
		const outcome = parseReviewOutcome(raw, FP);
		assert.equal(outcome.valid, true);
		assert.equal(outcome.fingerprint, FP);
	});
});

void describe("cross-family routing", () => {
	void test("claude-family detection covers ids, aliases, and provider prefixes", () => {
		for (const id of ["claude-fable-5", "fable", "opus", "sonnet", "haiku", "anthropic/claude-opus-4-6"]) {
			assert.equal(isClaudeFamily(id), true, id);
		}
		for (const id of ["gpt-5.6-sol", "openai-codex/gpt-5.6", undefined]) {
			assert.equal(isClaudeFamily(id), false, String(id));
		}
	});

	void test("claude-authored work gets an EXPLICIT non-claude reviewer model", () => {
		const routing = pickReviewerRouting({ workProducerModelId: "claude-fable-5", preferDifferentFamily: true });
		assert.equal(routing.backend, "pi");
		// A bare pi backend would inherit the parent Claude model and re-route
		// to Claude Code — the model MUST be explicit.
		assert.equal(routing.model, DEFAULT_NON_CLAUDE_REVIEWER_MODEL);
	});

	void test("the diverse reviewer model is configurable", () => {
		const routing = pickReviewerRouting({
			workProducerModelId: "fable",
			preferDifferentFamily: true,
			nonClaudeModel: "gpt-5.6",
		});
		assert.deepEqual(routing, { backend: "pi", model: "gpt-5.6" });
	});

	void test("a subagent producer is keyed by its snapshot model label, not the root model", () => {
		// index.ts passes the OWNER subagent's meta.modelLabel (e.g. a codex
		// worker) — its diverse reviewer must be Claude even when the root
		// session itself runs a Claude model.
		assert.deepEqual(pickReviewerRouting({ workProducerModelId: "openai-codex/gpt-5.6-sol", preferDifferentFamily: true }), {
			backend: "claude",
		});
		// ...and a Claude-labelled subagent producer gets the explicit non-Claude reviewer.
		const claudeProducer = pickReviewerRouting({ workProducerModelId: "claude-opus-4-6", preferDifferentFamily: true });
		assert.deepEqual(claudeProducer, { backend: "pi", model: DEFAULT_NON_CLAUDE_REVIEWER_MODEL });
	});

	void test("non-claude work routes its diverse review to claude", () => {
		assert.deepEqual(pickReviewerRouting({ workProducerModelId: "gpt-5.6-sol", preferDifferentFamily: true }), {
			backend: "claude",
		});
	});

	void test("same-family reviews keep the producing family", () => {
		assert.equal(pickReviewerRouting({ workProducerModelId: "fable", preferDifferentFamily: false }).backend, "claude");
		const nonClaude = pickReviewerRouting({ workProducerModelId: "gpt-5.6", preferDifferentFamily: false });
		assert.equal(nonClaude.backend, "pi");
		assert.equal(nonClaude.model, DEFAULT_NON_CLAUDE_REVIEWER_MODEL);
	});
});

void describe("review prompt", () => {
	void test("prompt embeds the fingerprint, read-only rules, and the output contract", () => {
		const prompt = buildReviewPrompt({ fingerprint: FP, round: 2, kind: "re-review" });
		// FP contains "+", which a RegExp would treat as a quantifier — plain includes.
		assert.ok(prompt.includes(FP));
		assert.match(prompt, /READ-ONLY/);
		assert.match(prompt, /never commit, push, or merge/);
		assert.match(prompt, /reviewedFingerprint/);
		assert.match(prompt, /FRESH re-review/);
	});
});
