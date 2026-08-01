import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoute } from "./src/routing-policy.ts";

await test("Claude-family models always route to Claude Code and lose provider prefixes", () => {
	for (const model of ["fable", "opus", "sonnet", "haiku", "claude-opus-4-6", "opencode/claude-fable-5", "other/sonnet"]) {
		assert.deepEqual(resolveRoute({ harness: "pi", model }), {
			backend: "claude",
			model: model.split("/").at(-1),
		});
	}
	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			inheritedModel: { provider: "opencode", id: "claude-opus-4-6" },
		}),
		{ backend: "claude", model: "claude-opus-4-6" },
	);
});

await test("the Claude harness rejects explicitly requested non-Claude models", () => {
	const route = resolveRoute({ harness: "claude", model: "openai-codex/gpt-5.6-sol" });
	assert.ok("error" in route);
	assert.match(route.error, /not a Claude-family model/);
	assert.match(route.error, /harness "pi"/);
	assert.deepEqual(resolveRoute({ harness: "claude" }), { backend: "claude", model: undefined });
});

await test("paid OpenCode models require a provider-qualified id and explicit opt-in", () => {
	const denied = resolveRoute({ harness: "pi", model: "opencode/gpt-5.4" });
	assert.ok("error" in denied);
	assert.match(denied.error, /OpenCode.*paid/);
	assert.match(denied.error, /allowPaidOpencode: true/);
	assert.deepEqual(resolveRoute({ harness: "pi", model: "opencode/gpt-5.4", allowPaidOpencode: true }), {
		backend: "pi",
		model: "opencode/gpt-5.4",
	});

	const inherited = resolveRoute({
		harness: "pi",
		inheritedModel: { provider: "opencode", id: "gpt-5.4" },
		allowPaidOpencode: true,
	});
	assert.ok("error" in inherited);
	assert.match(inherited.error, /explicit provider-qualified model/);
});

await test("Claude-family OpenCode ids route to Claude Code without selecting paid OpenCode", () => {
	assert.deepEqual(resolveRoute({ harness: "pi", model: "opencode/claude-fable-5" }), {
		backend: "claude",
		model: "claude-fable-5",
	});
});

await test("routing preserves requested non-Claude backend and model without fallback substitution", () => {
	assert.deepEqual(resolveRoute({ harness: "pi", model: "openai-codex/gpt-unavailable" }), {
		backend: "pi",
		model: "openai-codex/gpt-unavailable",
	});
	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			inheritedModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
		}),
		{ backend: "pi", model: undefined },
	);
});
