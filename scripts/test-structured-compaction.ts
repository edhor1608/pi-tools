import { requestCodexRemoteCompaction } from "../extensions/structured-compaction/responses-adapter.ts";
import type { StructuredCompactionConfig } from "../extensions/structured-compaction/types.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

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
	request = { url: String(input), init: init ?? {} };
	return new Response(JSON.stringify({
		output: [{ type: "compaction_summary", encrypted_content: "opaque" }],
		usage: {
			input_tokens: 120,
			input_tokens_details: { cached_tokens: 20 },
			output_tokens: 10,
			output_tokens_details: { reasoning_tokens: 5 },
			total_tokens: 130,
		},
	}), { status: 200, headers: { "content-type": "application/json" } });
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

	assert(request, "expected a remote compact request");
	assert(request.url === "https://chatgpt.com/backend-api/codex/responses/compact", "expected the Codex compact endpoint");
	const headers = new Headers(request.init.headers);
	assert(headers.get("session-id") === "session-test", "expected Pi 0.82 session-id header spelling");
	assert(headers.get("session_id") === null, "expected the retired session_id header to be absent");
	assert(Boolean(headers.get("x-client-request-id")), "expected a per-request Codex ID");
	assert(headers.get("chatgpt-account-id") === "account-test", "expected the Codex account header");
	const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
	assert(body.prompt_cache_key === "session-test", "expected the prompt cache key in the official compact body");
	assert(!("stream" in body) && !("tools" in body) && !("reasoning" in body), "expected only compact-compatible request fields");
	assert(result.outputItems[0]?.type === "compaction_summary", "expected raw Codex replacement output to survive");
	assert(typeof result.usage === "object" && result.usage !== null, "expected remote usage to be persisted");

	console.log(JSON.stringify({
		url: request.url,
		headerNames: [...headers.keys()].sort(),
		body,
		outputTypes: result.outputItems.flatMap((item) => typeof item === "object" && item !== null && !Array.isArray(item) && typeof item.type === "string" ? [item.type] : []),
		hasUsage: result.usage !== undefined,
	}, null, 2));
} finally {
	globalThis.fetch = originalFetch;
}
