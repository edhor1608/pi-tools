import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { runStructuredCompactionBackend } from "../extensions/structured-compaction/backend.ts";
import { requestCodexRemoteCompaction } from "../extensions/structured-compaction/responses-adapter.ts";
import type { StructuredCompactionConfig } from "../extensions/structured-compaction/types.ts";

await test("Codex remote compaction uses the current endpoint contract", async () => {
	const config = {
		enabled: true,
		backend: {
			kind: "codex-remote",
			model: null,
			fallbackToActiveModel: true,
			maxTokens: 8192,
			reasoning: "high",
			remote: { endpointMode: "auto", originator: "pi" },
		},
		renderer: { kind: "compaction-summary", customType: "structured-compaction-summary", display: false },
		prompt: {},
		debug: { notify: false },
	} satisfies StructuredCompactionConfig;

	let request: { url: string; init: RequestInit } | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		request = { url, init: init ?? {} };
		return new Response(
			JSON.stringify({
				output: [{ type: "compaction_summary", encrypted_content: "opaque" }],
				usage: {
					input_tokens: 120,
					input_tokens_details: { cached_tokens: 20 },
					output_tokens: 10,
					output_tokens_details: { reasoning_tokens: 5 },
					total_tokens: 130,
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	try {
		const result = await requestCodexRemoteCompaction(
			{
				modelRegistry: {
					async getApiKeyAndHeaders() {
						return {
							ok: true,
							apiKey: "header.payload.signature",
							headers: { "chatgpt-account-id": "account-test" },
							env: { HTTPS_PROXY: "http://proxy.invalid" },
						};
					},
				},
			} as never,
			config,
			{
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				headers: {},
			} as never,
			"Keep decisions and current work.",
			[{ role: "user", content: [{ type: "input_text", text: "context" }] }],
			"session-test",
			new AbortController().signal,
		);

		const capturedRequest = request;
		assert.ok(capturedRequest, "expected a remote compact request");
		assert.equal(capturedRequest.url, "https://chatgpt.com/backend-api/codex/responses/compact");
		const headers = new Headers(capturedRequest.init.headers);
		assert.equal(headers.get("session-id"), "session-test");
		assert.equal(headers.get("session_id"), null);
		assert.ok(headers.get("x-client-request-id") !== null);
		assert.equal(headers.get("chatgpt-account-id"), "account-test");
		const requestBody = capturedRequest.init.body;
		assert.equal(typeof requestBody, "string");
		if (typeof requestBody !== "string") throw new TypeError("expected a JSON request body");
		const body: unknown = JSON.parse(requestBody);
		assert.ok(typeof body === "object" && body !== null);
		assert.ok("prompt_cache_key" in body && body.prompt_cache_key === "session-test");
		assert.ok(!("stream" in body) && !("tools" in body) && !("reasoning" in body));
		const firstOutput = result.outputItems[0];
		assert.ok(typeof firstOutput === "object" && firstOutput !== null && !Array.isArray(firstOutput));
		assert.equal(firstOutput.type, "compaction_summary");
		assert.ok(typeof result.usage === "object" && result.usage !== null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await test("Codex remote compaction preserves summary usage", async () => {
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "summary" }] });
	faux.setResponses([
		{
			...fauxAssistantMessage("Summary"),
			usage: {
				input: 11,
				output: 7,
				cacheRead: 3,
				cacheWrite: 0,
				totalTokens: 18,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	]);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ output: [{ type: "compaction_summary", encrypted_content: "opaque" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

	try {
		const result = await runStructuredCompactionBackend(
			{
				messagesToSummarize: [],
				turnPrefixMessages: [],
				readFiles: [],
				modifiedFiles: [],
				firstKeptEntryId: "entry-test",
				isSplitTurn: false,
				tokensBefore: 120,
				previousArtifact: {
					summary: "Previous summary",
					replacementMessages: [],
					remoteReplacement: {
						api: "openai-codex-responses",
						outputItems: [{ type: "compaction_summary", encrypted_content: "previous" }],
					},
				},
			} as never,
			{
				ctx: {
					model: {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						api: "openai-codex-responses",
						baseUrl: "https://chatgpt.com/backend-api",
						headers: {},
					},
					modelRegistry: {
						find: () => faux.getModel(),
						async getApiKeyAndHeaders() {
							return {
								ok: true,
								apiKey: "header.payload.signature",
								headers: { "chatgpt-account-id": "account-test" },
							};
						},
					},
					getSystemPrompt: () => "system",
					sessionManager: { getSessionId: () => "session-test" },
				} as never,
				config: {
					enabled: true,
					backend: {
						kind: "codex-remote",
						model: "faux/summary",
						fallbackToActiveModel: true,
						maxTokens: 8192,
						reasoning: "high",
						remote: { endpointMode: "auto", originator: "pi" },
					},
					renderer: {
						kind: "compaction-summary",
						customType: "structured-compaction-summary",
						display: false,
					},
					prompt: {},
					debug: { notify: false },
				},
				prompts: { system: "system", compact: "compact" },
				signal: new AbortController().signal,
			},
		);

		assert.ok(result.usage, "expected codex-remote backend to preserve summary usage");
	} finally {
		globalThis.fetch = originalFetch;
		faux.unregister();
	}
});
