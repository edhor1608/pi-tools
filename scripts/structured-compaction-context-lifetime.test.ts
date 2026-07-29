import assert from "node:assert/strict";
import test from "node:test";
import structuredCompactionExtension from "../extensions/structured-compaction/index.ts";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

await test("structured compaction hooks do not retain Pi context across async setup", async () => {
	const handlers = new Map<string, Handler>();
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		registerEntryRenderer() {},
	};
	structuredCompactionExtension(api as never);

	let closed = false;
	const context = {
		get cwd() {
			if (closed) throw new Error("stale context");
			return process.cwd();
		},
		get sessionManager() {
			if (closed) throw new Error("stale context");
			return { getBranch: () => [] };
		},
		get model() {
			if (closed) throw new Error("stale context");
			return undefined;
		},
	};

	const contextHandler = handlers.get("context");
	assert.ok(contextHandler, "missing context handler");
	const contextResult = Promise.resolve(contextHandler({ messages: [] }, context));
	closed = true;
	await assert.doesNotReject(contextResult);

	const providerHandler = handlers.get("before_provider_request");
	assert.ok(providerHandler, "missing before_provider_request handler");
	await assert.doesNotReject(Promise.resolve().then(() => providerHandler({ payload: {} }, context)));
});
