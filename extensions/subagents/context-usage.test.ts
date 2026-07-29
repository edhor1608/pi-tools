import assert from "node:assert/strict";
import test from "node:test";
import { contextOccupancyTokens } from "./src/backends/claude.ts";

await test("Claude occupancy sums one request's input, cache, and output tokens", () => {
	assert.equal(
		contextOccupancyTokens({
			input_tokens: 12,
			cache_read_input_tokens: 45_000,
			cache_creation_input_tokens: 3_000,
			output_tokens: 700,
		}),
		48_712,
	);
});

await test("Claude occupancy treats null cache/output counts as zero", () => {
	assert.equal(
		contextOccupancyTokens({
			input_tokens: 9_000,
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
			output_tokens: 250,
		}),
		9_250,
	);
});

await test("Claude occupancy is unknown without a usable per-request usage", () => {
	assert.equal(contextOccupancyTokens(undefined), undefined);
	assert.equal(contextOccupancyTokens(null), undefined);
	assert.equal(contextOccupancyTokens({ input_tokens: null, output_tokens: 5 }), undefined);
});

await test("Claude occupancy uses the last request rather than aggregate usage", () => {
	const perRequest = {
		input_tokens: 500,
		cache_read_input_tokens: 150_000,
		cache_creation_input_tokens: 0,
		output_tokens: 400,
	};
	const aggregate = {
		input_tokens: 500 * 10,
		cache_read_input_tokens: 150_000 * 10,
		cache_creation_input_tokens: 0,
		output_tokens: 400 * 10,
	};
	const occupancy = contextOccupancyTokens(perRequest);
	assert.ok(occupancy !== undefined && occupancy < 200_000);
	const misleading = contextOccupancyTokens(aggregate);
	assert.ok(misleading !== undefined && misleading > 200_000);
});
