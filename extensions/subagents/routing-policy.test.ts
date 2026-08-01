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

await test("paid OpenCode requires both the user gate and spawn-time flag", () => {
	const flagOnly = resolveRoute({
		harness: "pi",
		model: "opencode/gpt-5.4",
		allowPaidOpencode: true,
		paidOpencodeConfigPath: "/home/jonas/.pi/agent/pi-tools.json",
	});
	assert.ok("error" in flagOnly);
	assert.match(flagOnly.error, /OpenCode is paid and disabled/);
	assert.match(flagOnly.error, /Jonas must enable allowPaidOpencode in \/home\/jonas\/\.pi\/agent\/pi-tools\.json/);
	assert.doesNotMatch(flagOnly.error, /changing|arguments|set allowPaidOpencode/);

	const userConfigOnly = resolveRoute({
		harness: "pi",
		model: "opencode/gpt-5.4",
		userAllowsPaidOpencode: true,
	});
	assert.ok("error" in userConfigOnly);
	assert.match(userConfigOnly.error, /spawn-time allowPaidOpencode: true/);

	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			model: "opencode/gpt-5.4",
			userAllowsPaidOpencode: true,
			allowPaidOpencode: true,
		}),
		{ backend: "pi", model: "opencode/gpt-5.4" },
	);

	const inherited = resolveRoute({
		harness: "pi",
		inheritedModel: { provider: "opencode", id: "gpt-5.4" },
		userAllowsPaidOpencode: true,
		allowPaidOpencode: true,
	});
	assert.ok("error" in inherited);
	assert.match(inherited.error, /explicit provider-qualified model/);
});

await test("bare model ids prefer an available native provider over OpenCode", () => {
	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			model: "gpt-5.4",
			inheritedModel: { provider: "opencode", id: "gpt-5.4" },
			bareModelProviders: ["opencode", "openai-codex"],
		}),
		{ backend: "pi", model: "openai-codex/gpt-5.4" },
	);

	const onlyOpenCode = resolveRoute({
		harness: "pi",
		model: "gpt-5.4",
		bareModelProviders: ["opencode"],
		userAllowsPaidOpencode: true,
	});
	assert.ok("error" in onlyOpenCode);
	assert.match(onlyOpenCode.error, /opencode\/gpt-5\.4/);
	assert.match(onlyOpenCode.error, /explicit provider-qualified model/);
});

await test("all opencode-* providers require paid opt-in", () => {
	const qualified = resolveRoute({ harness: "pi", model: "opencode-go/kimi-k2.5" });
	assert.ok("error" in qualified);
	assert.match(qualified.error, /OpenCode is paid and disabled/);
	assert.deepEqual(
		resolveRoute({
			harness: "pi",
			model: "opencode-go/kimi-k2.5",
			userAllowsPaidOpencode: true,
			allowPaidOpencode: true,
		}),
		{
			backend: "pi",
			model: "opencode-go/kimi-k2.5",
		},
	);

	const bareOnly = resolveRoute({
		harness: "pi",
		model: "kimi-k2.5",
		bareModelProviders: ["opencode-go"],
		userAllowsPaidOpencode: true,
	});
	assert.ok("error" in bareOnly);
	assert.match(bareOnly.error, /opencode-go\/kimi-k2\.5/);
	assert.ok(
		"error" in
			resolveRoute({
				harness: "pi",
				model: "kimi-k2.5",
				bareModelProviders: ["opencode-go"],
				userAllowsPaidOpencode: true,
				allowPaidOpencode: true,
			}),
	);

	const inherited = resolveRoute({
		harness: "pi",
		inheritedModel: { provider: "opencode-go", id: "kimi-k2.5" },
		userAllowsPaidOpencode: true,
	});
	assert.ok("error" in inherited);
	assert.match(inherited.error, /opencode-go\/kimi-k2\.5/);
});

await test("resolved provider guards catch the live opencode alias shape", () => {
	const liveShape = resolveRoute({
		harness: "pi",
		model: "opencode/kimi-k2.5",
		resolvedModel: { provider: "opencode-go", id: "kimi-k2.5" },
	});
	assert.ok("error" in liveShape);
	assert.match(liveShape.error, /OpenCode is paid and disabled/);

	const userEnabledLiveShape = resolveRoute({
		harness: "pi",
		model: "opencode/kimi-k2.5",
		resolvedModel: { provider: "opencode-go", id: "kimi-k2.5" },
		userAllowsPaidOpencode: true,
	});
	assert.ok("error" in userEnabledLiveShape);
	assert.match(userEnabledLiveShape.error, /opencode-go\/kimi-k2\.5/);
	assert.match(userEnabledLiveShape.error, /spawn-time allowPaidOpencode: true/);

	const nonPaidLookingAlias = resolveRoute({
		harness: "pi",
		model: "zen/kimi-k2.5",
		resolvedModel: { provider: "opencode-go", id: "kimi-k2.5" },
	});
	assert.ok("error" in nonPaidLookingAlias);
	assert.match(nonPaidLookingAlias.error, /OpenCode is paid and disabled/);
});

await test("nested OpenCode spawns report that paid routing is unavailable by policy", () => {
	const nested = resolveRoute({
		harness: "pi",
		model: "opencode/gpt-5.4",
		userAllowsPaidOpencode: true,
		allowPaidOpencode: true,
		nestedSpawn: true,
	});
	assert.ok("error" in nested);
	assert.match(nested.error, /unavailable for nested subagent spawns by policy/);
	assert.doesNotMatch(nested.error, /set allowPaidOpencode/);
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
