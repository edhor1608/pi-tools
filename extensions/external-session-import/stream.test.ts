import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CodexParser } from "./parse-codex.ts";
import { parseJsonlStream } from "./stream.ts";
import { ImportAbortedError, MAX_LINE_BYTES, type JsonlParser, type NormalizedConversation } from "./types.ts";

const withTempFile = async (content: string, run: (path: string) => Promise<void>): Promise<void> => {
	const directory = await mkdtemp(join(tmpdir(), "external-import-stream-"));
	const path = join(directory, "session.jsonl");
	try {
		await writeFile(path, content);
		await run(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const conversation = (path: string, skippedRecords = 0): NormalizedConversation => ({
	source: "codex",
	sourceSessionId: "test",
	sourcePath: path,
	skippedRecords,
	events: [],
});

void describe("parseJsonlStream", () => {
	void test("feeds complete CRLF-delimited lines incrementally", async () => {
		const records = [
			JSON.stringify({ type: "session_meta", payload: { id: "stream-id" } }),
			JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			}),
		];
		await withTempFile(`${records.join("\r\n")}\r\n`, async (path) => {
			const result = await parseJsonlStream(
				path,
				new CodexParser({ sourcePath: path, fallbackTimestamp: 1 }),
				new AbortController().signal,
			);
			assert.equal(result.sourceSessionId, "stream-id");
			assert.deepEqual(
				result.events.map((event) => event.text),
				["hello"],
			);
		});
	});

	void test("destroys the stream and throws ImportAbortedError without further pushes", async () => {
		await withTempFile(Array.from({ length: 1000 }, (_, index) => JSON.stringify({ index })).join("\n"), async (path) => {
			const controller = new AbortController();
			class AbortAfterParser implements JsonlParser {
				pushCount = 0;
				push(): void {
					this.pushCount++;
					if (this.pushCount === 5) controller.abort();
				}
				skip(): void {}
				finish(): NormalizedConversation {
					return conversation(path);
				}
			}
			const parser = new AbortAfterParser();
			await assert.rejects(parseJsonlStream(path, parser, controller.signal), ImportAbortedError);
			assert.equal(parser.pushCount, 5);
		});
	});

	void test("drops and counts an oversized line before parsing later records", async () => {
		const valid = JSON.stringify({
			type: "response_item",
			payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "after large line" }] },
		});
		await withTempFile(`${"x".repeat(MAX_LINE_BYTES + 1)}\n${valid}\n`, async (path) => {
			const result = await parseJsonlStream(
				path,
				new CodexParser({ sourcePath: path, fallbackTimestamp: 1 }),
				new AbortController().signal,
			);
			assert.equal(result.skippedRecords, 1);
			assert.deepEqual(
				result.events.map((event) => event.text),
				["after large line"],
			);
		});
	});
});
