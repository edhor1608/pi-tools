import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoute } from "./src/routing-policy.ts";

await test("Claude-family models always route to Claude Code and lose provider prefixes", () => {
	for (const model of ["fable", "opus", "sonnet", "haiku", "claude-opus-4-6", "openrouter/claude-fable-5", "other/sonnet"]) {
		assert.deepEqual(resolveRoute({ harness: "pi", model }), {
			backend: "claude",
			model: model.split("/").at(-1),
		});
	}
	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			inheritedModel: { provider: "openrouter", id: "claude-opus-4-6" },
		}),
		{ backend: "claude", model: "claude-opus-4-6" },
	);
});

await test("model-picking keys map to executable Claude Code aliases", () => {
	for (const [requested, executable] of [
		["fable-5", "fable"],
		["opus-5", "opus"],
		["sonnet-5", "sonnet"],
	] as const) {
		assert.deepEqual(resolveRoute({ harness: "pi", model: requested }), { backend: "claude", model: executable });
		assert.deepEqual(resolveRoute({ harness: "claude", model: requested }), { backend: "claude", model: executable });
	}
});

await test("the Claude harness rejects explicitly requested non-Claude models", () => {
	const route = resolveRoute({ harness: "claude", model: "openai-codex/gpt-5.6-sol" });
	assert.ok("error" in route);
	assert.match(route.error, /not a Claude-family model/);
	assert.match(route.error, /harness "pi"/);
	assert.deepEqual(resolveRoute({ harness: "claude" }), { backend: "claude", model: undefined });
});

await test("paid OpenRouter requires provider qualification, the user config gate, and the spawn-time flag", () => {
	const flagOnly = resolveRoute({
		harness: "pi",
		model: "openrouter/moonshotai/kimi-k2.5",
		allowPaidOpenrouter: true,
		paidOpenrouterConfigPath: "/home/jonas/.pi/agent/pi-tools.json",
	});
	assert.ok("error" in flagOnly);
	assert.match(flagOnly.error, /OpenRouter is paid and disabled/);
	assert.match(flagOnly.error, /Jonas must enable allowPaidOpenrouter in \/home\/jonas\/\.pi\/agent\/pi-tools\.json/);
	assert.doesNotMatch(flagOnly.error, /changing|arguments|set allowPaidOpenrouter/);

	const userConfigOnly = resolveRoute({
		harness: "pi",
		model: "openrouter/moonshotai/kimi-k2.5",
		userAllowsPaidOpenrouter: true,
	});
	assert.ok("error" in userConfigOnly);
	assert.match(userConfigOnly.error, /spawn-time allowPaidOpenrouter: true/);

	const bare = resolveRoute({
		harness: "pi",
		model: "moonshotai/kimi-k2.5",
		resolvedModel: { provider: "openrouter", id: "moonshotai/kimi-k2.5" },
		userAllowsPaidOpenrouter: true,
		allowPaidOpenrouter: true,
	});
	assert.ok("error" in bare);
	assert.match(bare.error, /explicit provider-qualified model/);
	assert.match(bare.error, /openrouter\/moonshotai\/kimi-k2\.5/);

	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			model: "openrouter/moonshotai/kimi-k2.5",
			userAllowsPaidOpenrouter: true,
			allowPaidOpenrouter: true,
		}),
		{ backend: "pi", model: "openrouter/moonshotai/kimi-k2.5" },
	);
});

await test("bare model ids never select OpenRouter and preserve native providers", () => {
	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			model: "gpt-5.4",
			inheritedModel: { provider: "openrouter", id: "gpt-5.4" },
			bareModelProviders: ["openrouter", "openai-codex"],
		}),
		{ backend: "pi", model: "openai-codex/gpt-5.4" },
	);

	const onlyOpenRouter = resolveRoute({
		harness: "pi",
		model: "kimi-k2.5",
		bareModelProviders: ["openrouter"],
		userAllowsPaidOpenrouter: true,
		allowPaidOpenrouter: true,
	});
	assert.ok("error" in onlyOpenRouter);
	assert.match(onlyOpenRouter.error, /openrouter\/kimi-k2\.5/);
	assert.match(onlyOpenRouter.error, /explicit provider-qualified model/);
});

await test("OpenRouter cannot be selected through inheritance", () => {
	const inheritedDefault = resolveRoute({
		harness: "pi",
		inheritedModel: { provider: "openrouter", id: "moonshotai/kimi-k2.5" },
	});
	assert.ok("error" in inheritedDefault);
	assert.match(inheritedDefault.error, /explicit provider-qualified model/);
	assert.doesNotMatch(inheritedDefault.error, /enable allowPaidOpenrouter/);

	const inheritedBare = resolveRoute({
		harness: "pi",
		model: "moonshotai/kimi-k2.5",
		inheritedModel: { provider: "openrouter", id: "moonshotai/kimi-k2.5" },
		resolvedModel: { provider: "openrouter", id: "moonshotai/kimi-k2.5" },
		userAllowsPaidOpenrouter: true,
		allowPaidOpenrouter: true,
	});
	assert.ok("error" in inheritedBare);
	assert.match(inheritedBare.error, /explicit provider-qualified model/);
});

await test("nested OpenRouter spawns are unavailable even with both opt-ins", () => {
	const nested = resolveRoute({
		harness: "pi",
		model: "openrouter/moonshotai/kimi-k2.5",
		userAllowsPaidOpenrouter: true,
		allowPaidOpenrouter: true,
		nestedSpawn: true,
	});
	assert.ok("error" in nested);
	assert.match(nested.error, /unavailable for nested subagent spawns by policy/);
	assert.doesNotMatch(nested.error, /set allowPaidOpenrouter/);
});

await test("retired OpenCode providers are rejected explicitly and cannot win bare resolution", () => {
	for (const model of ["opencode/gpt-5.4", "opencode-go/kimi-k2.5", "opencode/claude-fable-5"]) {
		const route = resolveRoute({
			harness: "pi",
			model,
			userAllowsPaidOpenrouter: true,
			allowPaidOpenrouter: true,
		});
		assert.ok("error" in route);
		assert.match(route.error, /OpenCode provider .* retired/i);
	}

	const resolvedAlias = resolveRoute({
		harness: "pi",
		model: "zen/kimi-k2.5",
		resolvedModel: { provider: "opencode-go", id: "kimi-k2.5" },
	});
	assert.ok("error" in resolvedAlias);
	assert.match(resolvedAlias.error, /opencode-go.*retired/i);

	const openRouterAlias = resolveRoute({
		harness: "pi",
		model: "zen/kimi-k2.5",
		resolvedModel: { provider: "openrouter", id: "kimi-k2.5" },
		userAllowsPaidOpenrouter: true,
		allowPaidOpenrouter: true,
	});
	assert.ok("error" in openRouterAlias);
	assert.match(openRouterAlias.error, /explicit provider-qualified model/);

	const bareOnly = resolveRoute({
		harness: "pi",
		model: "kimi-k2.5",
		bareModelProviders: ["opencode-go"],
	});
	assert.ok("error" in bareOnly);
	assert.match(bareOnly.error, /opencode-go.*retired/i);
});

await test("Claude-family OpenRouter ids route to Claude Code without selecting paid OpenRouter", () => {
	assert.deepEqual(resolveRoute({ harness: "pi", model: "openrouter/anthropic/claude-fable-5" }), {
		backend: "claude",
		model: "claude-fable-5",
	});
});

await test("routing preserves normal Codex paths and never substitutes a fallback provider", () => {
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
