import stashExtension from "../extensions/stash.ts";

const branch: any[] = [];
const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
const notifications: string[] = [];
const sentUserMessages: string[] = [];
const statuses = new Map<string, string | undefined>();
let editorText = "";

const api = {
	on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
		handlers.set(event, handler);
	},
	registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
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
} as any;

stashExtension(api);

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
		select() {
			return Promise.resolve(undefined);
		},
		editor() {
			return Promise.resolve(undefined);
		},
		custom() {
			return Promise.resolve(null);
		},
	},
	sessionManager: {
		getBranch() {
			return branch;
		},
	},
	isIdle() {
		return true;
	},
	hasPendingMessages() {
		return false;
	},
};

const sessionStart = handlers.get("session_start");
if (!sessionStart) throw new Error("missing session_start handler");
await sessionStart({ type: "session_start", reason: "startup" }, ctx);

const stash = commands.get("stash");
if (!stash) throw new Error("missing /stash command");

await stash("add manual Prompt 1", ctx);
await stash("add send Prompt 2", ctx);

const agentEnd = handlers.get("agent_end");
if (!agentEnd) throw new Error("missing agent_end handler");
await agentEnd(
	{
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
	},
	ctx,
);

if (sentUserMessages.length !== 0) throw new Error("manual head item should block later send item");

await stash("move 2 up", ctx);
await agentEnd(
	{
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
	},
	ctx,
);

if (sentUserMessages.length !== 1 || sentUserMessages[0] !== "Prompt 2") {
	throw new Error("expected top send item to auto-send on ready");
}

await stash("add draft Prompt 3", ctx);
await stash("drop 1", ctx);
await agentEnd(
	{
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Can you confirm?" }], stopReason: "stop" }],
	},
	ctx,
);

if (editorText.length > 0) throw new Error("question-ending should not release draft stash item");

await agentEnd(
	{
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "All set." }], stopReason: "stop" }],
	},
	ctx,
);

if (editorText !== "Prompt 3") throw new Error("expected draft item to be loaded into editor on ready");

const state = branch.filter((entry) => entry.customType === "stash-state").at(-1)?.data;
if (!state || !Array.isArray(state.items) || state.items.length !== 0) {
	throw new Error("expected stash to be empty after releases");
}
if (statuses.get("stash") !== undefined) {
	throw new Error("expected stash status to clear after the stash is emptied");
}
if (!notifications.some((message) => message.includes("Sent stash")) || !notifications.some((message) => message.includes("Loaded stash"))) {
	throw new Error("expected stash release notifications to be emitted");
}

console.log(
	JSON.stringify(
		{
			sentUserMessages,
			editorText,
			notifications,
			status: statuses.get("stash") ?? null,
		},
		null,
		2,
	),
);
