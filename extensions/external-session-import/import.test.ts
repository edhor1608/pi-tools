import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { importConversation, summarizeToolCalls } from "./import.ts";
import { SUMMARY_LINE_CAP, SUMMARY_TOOLS_PER_TURN, type NormalizedConversation, type NormalizedToolCall } from "./types.ts";

const FIXTURE_TOOL_CALLS: NormalizedToolCall[] = [
	{
		name: "Bash",
		input: '{"command":"git status --short"}',
		output: "M file.ts\nfull payload must stay non-contextual",
		isError: false,
	},
	{ name: "Edit", input: '{"path":"foo.ts"}', output: "old_string not found", isError: true },
];

const fixtureConversation = (): NormalizedConversation => ({
	source: "claude",
	sourceSessionId: "source-id",
	sourcePath: "/synthetic/source.jsonl",
	sourceCwd: "/synthetic/source-cwd",
	sourceModel: "claude-fixture",
	skippedRecords: 2,
	events: [
		{ kind: "user", text: "Please inspect the repo", timestamp: 100 },
		{
			kind: "assistant",
			text: "I inspected it.",
			timestamp: 200,
			toolCalls: FIXTURE_TOOL_CALLS,
		},
		{ kind: "assistant", text: "Done.", timestamp: 300, toolCalls: [] },
	],
});

void describe("summarizeToolCalls", () => {
	void test("produces an exact deterministic summary", () => {
		assert.equal(
			summarizeToolCalls(FIXTURE_TOOL_CALLS),
			[
				"[Imported tool activity — 2 call(s)]",
				'- Bash(git status --short) → ok: "M file.ts"',
				'- Edit(foo.ts) → error: "old_string not found"',
			].join("\n"),
		);
	});

	void test("bounds lines and tool count", () => {
		const summary = summarizeToolCalls(
			Array.from({ length: SUMMARY_TOOLS_PER_TURN + 3 }, (_, index) => ({
				name: `Tool${index}`,
				input: JSON.stringify({ command: "x".repeat(500) }),
				output: "y".repeat(500),
			})),
		);
		assert.equal(summary.split("\n").length, SUMMARY_TOOLS_PER_TURN + 2);
		assert.equal(summary.endsWith("(+3 more calls)"), true);
		assert.equal(
			summary.split("\n").every((line) => line.length <= SUMMARY_LINE_CAP),
			true,
		);
	});
});

void describe("importConversation", () => {
	void test("writes native messages plus contextual summaries and non-contextual full activity", () => {
		const sessionManager = SessionManager.inMemory("/synthetic/target");
		const result = importConversation(sessionManager, fixtureConversation(), 400);
		assert.deepEqual(result, { messageCount: 3, toolCallCount: 2 });

		const entries = sessionManager.getEntries();
		assert.deepEqual(
			entries.map((entry) => entry.type),
			["custom", "session_info", "message", "message", "custom", "custom_message", "message"],
		);
		assert.equal(entries[0]?.type, "custom");
		if (entries[0]?.type === "custom") {
			assert.equal(entries[0].customType, "external-import");
			assert.deepEqual(entries[0].data, {
				version: 1,
				source: "claude",
				sourceSessionId: "source-id",
				sourcePath: "/synthetic/source.jsonl",
				sourceCwd: "/synthetic/source-cwd",
				sourceModel: "claude-fixture",
				importedAt: 400,
				skippedRecords: 2,
			});
		}
		assert.equal(entries[4]?.type, "custom");
		if (entries[4]?.type === "custom") {
			assert.equal(entries[4].customType, "external-import:tools");
			assert.deepEqual(entries[4].data, {
				version: 1,
				turnIndex: 0,
				toolCalls: FIXTURE_TOOL_CALLS,
			});
		}
		assert.equal(entries[5]?.type, "custom_message");
		if (entries[5]?.type === "custom_message") {
			assert.equal(entries[5].customType, "external-import:tool-summary");
			assert.equal(entries[5].display, true);
		}

		const assistantEntries = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		for (const entry of assistantEntries) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				assert.equal(
					entry.message.content.every((block) => block.type === "text"),
					true,
				);
			}
		}

		const context = sessionManager.buildSessionContext();
		const contextJson = JSON.stringify(context.messages);
		assert.equal(contextJson.includes("Please inspect the repo"), true);
		assert.equal(contextJson.includes("I inspected it."), true);
		assert.equal(contextJson.includes("[Imported tool activity"), true);
		assert.equal(contextJson.includes("full payload must stay non-contextual"), false);
		assert.equal(contextJson.includes("/synthetic/source.jsonl"), false);
		const llmMessages = convertToLlm(context.messages);
		assert.equal(
			llmMessages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("[Imported tool activity")),
			true,
		);
	});
});
