import assert from "node:assert/strict";
import test from "node:test";
import stashExtension from "../extensions/stash.ts";

await test("stash releases prompts in mode and queue order", async () => {
	const branch: Array<Record<string, unknown>> = [];
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const notifications: string[] = [];
	const sentUserMessages: string[] = [];
	const statuses = new Map<string, string | undefined>();
	let editorText = "";

	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, spec.handler);
		},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		sendMessage() {},
		sendUserMessage(content: string) {
			sentUserMessages.push(content);
		},
	};

	stashExtension(api as never);

	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_token: string, text: string) => text,
				bold: (text: string) => text,
			},
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
			setEditorText(text: string) {
				editorText = text;
			},
			getEditorText() {
				return editorText;
			},
			select: async () => undefined,
			editor: async () => undefined,
			custom: async () => null,
		},
		sessionManager: {
			getBranch: () => branch,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	};

	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart, "missing session_start handler");
	await sessionStart({ type: "session_start", reason: "startup" }, ctx);

	const stash = commands.get("stash");
	assert.ok(stash, "missing /stash command");
	await stash("add manual Prompt 1", ctx);
	await stash("add send Prompt 2", ctx);

	const agentEnd = handlers.get("agent_end");
	assert.ok(agentEnd, "missing agent_end handler");
	await agentEnd(
		{
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
		},
		ctx,
	);
	assert.deepEqual(sentUserMessages, [], "manual head item should block later send item");

	await stash("move 2 up", ctx);
	await agentEnd(
		{
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
		},
		ctx,
	);
	assert.deepEqual(sentUserMessages, ["Prompt 2"], "expected top send item to auto-send on ready");

	await stash("add draft Prompt 3", ctx);
	await stash("drop 1", ctx);
	await agentEnd(
		{
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Can you confirm?" }], stopReason: "stop" }],
		},
		ctx,
	);
	assert.equal(editorText, "", "question-ending should not release draft stash item");

	await agentEnd(
		{
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "All set." }], stopReason: "stop" }],
		},
		ctx,
	);
	assert.equal(editorText, "Prompt 3", "expected draft item to be loaded into editor on ready");

	const state = branch.filter((entry) => entry.customType === "stash-state").at(-1)?.data;
	assert.ok(typeof state === "object" && state !== null && "items" in state && Array.isArray(state.items));
	assert.equal(state.items.length, 0, "expected stash to be empty after releases");
	assert.equal(statuses.get("stash"), undefined, "expected stash status to clear after the stash is emptied");
	assert.ok(
		notifications.some((message) => message.includes("Sent stash")),
		"expected a send notification",
	);
	assert.ok(
		notifications.some((message) => message.includes("Loaded stash")),
		"expected an editor-load notification",
	);
});
