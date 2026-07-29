import assert from "node:assert/strict";
import test from "node:test";
import { codexUsageFromResponse } from "../extensions/statusline.ts";

void test("Codex account usage response becomes footer usage", () => {
	const usage = codexUsageFromResponse(
		{
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 4.2,
					limit_window_seconds: 604800,
					reset_at: 1785911787,
				},
			},
			rate_limit_reset_credits: {
				available_count: 3,
				applicable_available_count: 0,
			},
		},
		1000,
	);

	assert.deepEqual(usage, {
		windows: [
			{
				label: "7d",
				usedPercent: 4,
				resetAt: 1785911787000,
				windowSeconds: 604800,
			},
		],
		planType: "pro",
		creditsAvailable: 0,
		fetchedAt: 1000,
	});
});

void test("Codex account usage response includes 5h and weekly windows", () => {
	const usage = codexUsageFromResponse(
		{
			rate_limit: {
				primary_window: {
					used_percent: 8,
					limit_window_seconds: 604800,
					reset_at: 1785911787,
				},
				secondary_window: {
					used_percent: 42,
					limit_window_seconds: 18000,
					reset_at: 1785360000,
				},
			},
		},
		1000,
	);

	assert.deepEqual(usage?.windows, [
		{
			label: "5h",
			usedPercent: 42,
			resetAt: 1785360000000,
			windowSeconds: 18000,
		},
		{
			label: "7d",
			usedPercent: 8,
			resetAt: 1785911787000,
			windowSeconds: 604800,
		},
	]);
});

void test("Codex account usage parser rejects unrelated payloads", () => {
	assert.equal(codexUsageFromResponse({ ok: true }, 1000), undefined);
});
