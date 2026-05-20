import notifyExtension from "../extensions/notify.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

interface NotifyTestContext {
	hasUI: boolean;
	hasPendingMessages: () => boolean;
	ui: {
		setTitle: (title: string) => void;
		setWorkingIndicator: (options?: unknown) => void;
		setWorkingMessage: (message?: string) => void;
	};
}

type Handler = (event: unknown, ctx: NotifyTestContext) => Promise<void> | void;

const handlers = new Map<string, Handler[]>();
const titles: string[] = [];
const workingIndicators: unknown[] = [];
const workingMessages: unknown[] = [];

const api = {
	getSessionName: () => undefined,
	on(event: string, handler: Handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
};

const ctx: NotifyTestContext = {
	hasUI: true,
	hasPendingMessages: () => false,
	ui: {
		setTitle(title: string) {
			titles.push(title);
		},
		setWorkingIndicator(options?: unknown) {
			workingIndicators.push(options);
		},
		setWorkingMessage(message?: string) {
			workingMessages.push(message);
		},
	},
};

notifyExtension(api as Parameters<typeof notifyExtension>[0]);

const sessionStart = handlers.get("session_start")?.[0];
const agentStart = handlers.get("agent_start")?.[0];
const agentEnd = handlers.get("agent_end")?.[0];
assert(sessionStart, "expected session_start handler");
assert(agentStart, "expected agent_start handler");
assert(agentEnd, "expected agent_end handler");

await sessionStart({}, ctx);
await agentStart({}, ctx);
await agentEnd({ messages: [] }, ctx);

const appliedIndicator = workingIndicators.find((options): options is { frames: string[]; intervalMs: number } => {
	return typeof options === "object" && options !== null && Array.isArray((options as { frames?: unknown }).frames);
});
assert(appliedIndicator, "expected notify to set a custom Pi working indicator");
assert(appliedIndicator.frames.length > 0, "expected custom working indicator frames");
assert(appliedIndicator.intervalMs === 80, "expected custom working indicator cadence");
assert(workingMessages.includes("Working..."), "expected notify to set a working message while active");
assert(workingIndicators.at(-1) === undefined, "expected notify to restore Pi's default working indicator");
assert(workingMessages.at(-1) === undefined, "expected notify to restore Pi's default working message");

console.log(
	JSON.stringify(
		{
			workingIndicatorFrames: appliedIndicator.frames.length,
			workingMessageSet: workingMessages.includes("Working..."),
			restoredIndicator: workingIndicators.at(-1) === undefined,
			titleUpdates: titles.length,
		},
		null,
		2,
	),
);
