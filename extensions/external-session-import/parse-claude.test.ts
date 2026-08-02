import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ClaudeParser } from "./parse-claude.ts";
import { INPUT_CAP } from "./types.ts";

const line = (value: unknown): string => JSON.stringify(value);

const parse = (records: string[]) => {
	const parser = new ClaudeParser({ sourcePath: "/fixtures/claude-session.jsonl", fallbackTimestamp: 1_700_000_000_000 });
	for (const record of records) parser.push(record);
	return parser.finish();
};

void describe("ClaudeParser", () => {
	void test("imports string and array text while extracting cwd and model", () => {
		const conversation = parse([
			line({ type: "user", cwd: "/work/app", timestamp: "2025-01-01T00:00:00Z", message: { content: "hello" } }),
			line({
				type: "assistant",
				timestamp: "2025-01-01T00:00:01Z",
				message: { model: "claude-test", content: [{ type: "text", text: "hi" }] },
			}),
			line({ type: "user", timestamp: "2025-01-01T00:00:02Z", message: { content: [{ type: "text", text: "again" }] } }),
		]);
		assert.equal(conversation.sourceSessionId, "claude-session");
		assert.equal(conversation.sourceCwd, "/work/app");
		assert.equal(conversation.sourceModel, "claude-test");
		assert.deepEqual(
			conversation.events.map((event) => [event.kind, event.text]),
			[
				["user", "hello"],
				["assistant", "hi"],
				["user", "again"],
			],
		);
	});

	void test("pairs tool results identically in either record order", () => {
		const call = line({
			type: "assistant",
			timestamp: "2025-01-01T00:00:00Z",
			message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }] },
		});
		const result = line({
			type: "user",
			timestamp: "2025-01-01T00:00:01Z",
			message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "/work", is_error: false }] },
		});
		const normal = parse([call, result]);
		const reversed = parse([result, call]);
		assert.deepEqual(normal.events, reversed.events);
		const assistant = normal.events[0];
		assert.equal(assistant?.kind, "assistant");
		if (assistant?.kind === "assistant") {
			assert.deepEqual(assistant.toolCalls, [{ name: "Bash", input: '{"command":"pwd"}', output: "/work", isError: false }]);
		}
	});

	void test("excludes thinking and non-conversation records, merges assistant chunks, and counts malformed input", () => {
		const conversation = parse([
			"not-json",
			line({ type: "queue-operation", message: { content: "ignored" } }),
			line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sidechain" }] } }),
			line({ type: "assistant", isMeta: true, message: { content: [{ type: "text", text: "meta" }] } }),
			line({
				type: "assistant",
				timestamp: "invalid",
				message: {
					content: [
						{ type: "thinking", thinking: "secret" },
						{ type: "text", text: "first" },
					],
				},
			}),
			line({ type: "assistant", timestamp: "invalid", message: { content: [{ type: "text", text: "second" }] } }),
		]);
		assert.equal(conversation.skippedRecords, 1);
		assert.deepEqual(conversation.events, [{ kind: "assistant", text: "first\n\nsecond", timestamp: 1_700_000_000_000, toolCalls: [] }]);
		assert.equal(JSON.stringify(conversation).includes("secret"), false);
	});

	void test("bounds tool input and counts an unmatched result at finish", () => {
		const conversation = parse([
			line({
				type: "assistant",
				message: { content: [{ type: "tool_use", id: "large", name: "Write", input: { content: "x".repeat(INPUT_CAP * 2) } }] },
			}),
			line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }] } }),
		]);
		const assistant = conversation.events[0];
		assert.equal(assistant?.kind, "assistant");
		if (assistant?.kind === "assistant") {
			const toolCall = assistant.toolCalls[0];
			assert.ok(toolCall);
			assert.ok(toolCall.input.length <= INPUT_CAP);
		}
		assert.equal(conversation.skippedRecords, 1);
	});
});
