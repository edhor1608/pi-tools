import assert from "node:assert/strict";
import test from "node:test";
import { createFailureRecord, isAbortedFailure, redactSecrets, serializeFailureRecord } from "../extensions/lifecycle-failures.ts";

void test("failure records are shaped, clipped, and session ids are shortened", () => {
	const input = "x.".repeat(200);
	const error = "y-".repeat(300);
	const record = createFailureRecord({
		ts: "2026-08-01T12:00:00.000Z",
		tool: "bash",
		cwd: "/tmp/project",
		sessionId: "12345678-rest",
		input,
		error,
	});

	assert.deepEqual(record, {
		ts: "2026-08-01T12:00:00.000Z",
		tool: "bash",
		cwd: "/tmp/project",
		session: "12345678",
		input: input.slice(0, 300),
		error: error.slice(0, 500),
	});
	assert.ok(serializeFailureRecord(record)?.endsWith("\n"));
});

void test("likely secrets are redacted", () => {
	const secrets = [
		"sk-abcdefghij123456",
		"Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
		"AKIAABCDEFGHIJKLMNOP",
		"password=hunter2",
		Buffer.from("a".repeat(80)).toString("base64"),
	];
	const redacted = redactSecrets(secrets.join(" | "));

	assert.equal(redacted, Array(secrets.length).fill("[redacted]").join(" | "));
});

void test("aborts and user interruptions are skipped", () => {
	assert.equal(isAbortedFailure("Operation aborted"), true);
	assert.equal(isAbortedFailure("Command interrupted by user"), true);
	assert.equal(isAbortedFailure("request canceled"), true);
	assert.equal(isAbortedFailure("permission denied"), false);

	const controller = new AbortController();
	controller.abort();
	assert.equal(isAbortedFailure("unrelated failure", controller.signal), true);
});

void test("oversized serialized records are rejected", () => {
	const record = createFailureRecord({
		tool: "write",
		cwd: `/${"界".repeat(2_000)}`,
		sessionId: "abcdefgh",
		input: "file.ts",
		error: "failed",
	});
	assert.equal(serializeFailureRecord(record), undefined);
});
