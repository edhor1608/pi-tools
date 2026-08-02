import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CodexParser, parseCodexLegacyFile, parseCodexLegacySession } from "./parse-codex.ts";
import { ImportParseError, LEGACY_MAX_BYTES } from "./types.ts";

const line = (value: unknown): string => JSON.stringify(value);
const response = (payload: Record<string, unknown>, timestamp = "2025-01-01T00:00:01Z"): string =>
	line({ type: "response_item", timestamp, payload });

const parse = (records: string[]) => {
	const parser = new CodexParser({ sourcePath: "/fixtures/rollout-test.jsonl", fallbackTimestamp: 1_700_000_000_000 });
	for (const record of records) parser.push(record);
	return parser.finish();
};

void describe("CodexParser", () => {
	void test("extracts metadata, canonical messages, and model while excluding wrappers and duplicate events", () => {
		const conversation = parse([
			line({ type: "session_meta", payload: { id: "codex-id", cwd: "/work/codex", timestamp: "2025-01-01T00:00:00Z" } }),
			line({ type: "turn_context", payload: { model: "gpt-test" } }),
			line({ type: "event_msg", payload: { type: "user_message", message: "duplicate user text" } }),
			response({
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "<user_instructions>ignore" },
					{ type: "input_text", text: "<environment_context>ignore" },
					{ type: "input_text", text: "actual request" },
				],
			}),
			response({ type: "reasoning", summary: "private" }),
			response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }),
		]);
		assert.equal(conversation.sourceSessionId, "codex-id");
		assert.equal(conversation.sourceCwd, "/work/codex");
		assert.equal(conversation.sourceModel, "gpt-test");
		assert.deepEqual(
			conversation.events.map((event) => [event.kind, event.text]),
			[
				["user", "actual request"],
				["assistant", "answer"],
			],
		);
		assert.equal(JSON.stringify(conversation).includes("duplicate user text"), false);
		assert.equal(JSON.stringify(conversation).includes("private"), false);
	});

	void test("pairs function output identically before or after its call", () => {
		const call = response({ type: "function_call", name: "shell", arguments: '{ "command": "git status" }', call_id: "call-1" });
		const output = response({ type: "function_call_output", call_id: "call-1", output: "clean" });
		const normal = parse([call, output]);
		const reversed = parse([output, call]);
		assert.deepEqual(normal.events, reversed.events);
		const assistant = normal.events[0];
		assert.equal(assistant?.kind, "assistant");
		if (assistant?.kind === "assistant") {
			assert.deepEqual(assistant.toolCalls, [{ name: "shell", input: '{"command":"git status"}', output: "clean", isError: false }]);
		}
	});

	void test("normalizes web search calls and falls back to the file timestamp", () => {
		const conversation = parse([response({ type: "web_search_call", id: "web-1", action: { query: "pi docs" } }, "invalid")]);
		assert.deepEqual(conversation.events, [
			{
				kind: "assistant",
				text: "",
				timestamp: 1_700_000_000_000,
				toolCalls: [{ name: "web_search", input: '{"query":"pi docs"}' }],
			},
		]);
	});
});

void describe("parseCodexLegacySession", () => {
	void test("maps legacy session metadata and response items", () => {
		const conversation = parseCodexLegacySession(
			{
				session: { id: "legacy-id", cwd: "/legacy", model: "legacy-model", timestamp: "2025-01-01T00:00:00Z" },
				items: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "legacy request" }] },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "legacy answer" }] },
				],
			},
			"/fixtures/legacy.json",
			1,
		);
		assert.equal(conversation.sourceSessionId, "legacy-id");
		assert.equal(conversation.sourceCwd, "/legacy");
		assert.equal(conversation.sourceModel, "legacy-model");
		assert.equal(conversation.events.length, 2);
	});

	void test("rejects oversized files before attempting to read them", async () => {
		await assert.rejects(
			parseCodexLegacyFile("/synthetic/file-does-not-exist.json", LEGACY_MAX_BYTES + 1, 1, new AbortController().signal),
			(error: unknown) => error instanceof ImportParseError && error.message.includes("limit 32MB"),
		);
	});

	void test("rejects unsupported legacy shapes", () => {
		assert.throws(() => parseCodexLegacySession({ session: {} }, "/fixtures/bad.json", 1), ImportParseError);
	});
});
