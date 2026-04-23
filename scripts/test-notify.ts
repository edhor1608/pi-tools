import notifyExtension from "../extensions/notify.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();

const api = {
	on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	getSessionName() {
		return undefined;
	},
} as any;

notifyExtension(api);

const sessionStart = handlers.get("session_start")?.[0];
const agentStart = handlers.get("agent_start")?.[0];
const agentEnd = handlers.get("agent_end")?.[0];
const sessionShutdown = handlers.get("session_shutdown")?.[0];
assert(sessionStart, "expected session_start handler");
assert(agentStart, "expected agent_start handler");
assert(agentEnd, "expected agent_end handler");
assert(sessionShutdown, "expected session_shutdown handler");

const indicatorCalls: Array<{ frames: string[]; intervalMs?: number } | undefined> = [];
const titles: string[] = [];
const ctx = {
	hasUI: true,
	ui: {
		theme: {
			fg: (_token: string, text: string) => text,
		},
		setTitle(title: string) {
			titles.push(title);
		},
		setWorkingIndicator(options?: { frames: string[]; intervalMs?: number }) {
			indicatorCalls.push(options);
		},
	},
	hasPendingMessages() {
		return false;
	},
} as any;

await sessionStart({ type: "session_start", reason: "startup" }, ctx);
await agentStart({ type: "agent_start" }, ctx);
await agentEnd(
	{
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
	},
	ctx,
);
await sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);

assert(indicatorCalls.length >= 4, "expected notify extension to manage the working indicator across lifecycle events");
assert(indicatorCalls[0] === undefined, "expected session_start to restore Pi's default working indicator");
assert(indicatorCalls[1]?.frames?.[0]?.includes("●"), "expected agent_start to enable a custom in-app working indicator");
assert(indicatorCalls[2] === undefined, "expected agent_end to restore Pi's default working indicator");
assert(indicatorCalls.at(-1) === undefined, "expected session_shutdown to restore Pi's default working indicator");
assert(titles.some((title) => title.startsWith("✓ ")), "expected ready title prefix after agent_end");

const ctxWithoutIndicator = {
	hasUI: true,
	ui: {
		theme: {
			fg: (_token: string, text: string) => text,
		},
		setTitle() {},
	},
	hasPendingMessages() {
		return false;
	},
} as any;

await sessionStart({ type: "session_start", reason: "startup" }, ctxWithoutIndicator);
await agentStart({ type: "agent_start" }, ctxWithoutIndicator);
await agentEnd(
	{
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
	},
	ctxWithoutIndicator,
);
await sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctxWithoutIndicator);

console.log(
	JSON.stringify(
		{
			indicatorCalls: indicatorCalls.map((call) => (call ? call.frames : null)),
			lastTitle: titles.at(-1),
			fallbackWithoutIndicator: true,
		},
		null,
		2,
	),
);
