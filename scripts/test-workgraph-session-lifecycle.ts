import workgraphExtension from "../extensions/workgraph.ts";

const makeTheme = () => ({
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
});

const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const statuses = new Map<string, string | undefined>();
const widgets = new Map<string, unknown>();

const api = {
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		handlers.set(event, handler);
	},
	registerMessageRenderer() {},
	registerTool() {},
	registerCommand() {},
	appendEntry() {},
	sendMessage() {},
} as any;

workgraphExtension(api);

const branch = [
	{
		type: "custom",
		customType: "workgraph-state",
		data: {
			version: 2,
			nextId: 2,
			items: [
				{
					id: 1,
					text: "Sample issue",
					status: "pending",
					dependTo: [],
					createdAt: 1,
					updatedAt: 1,
					source: "user",
					execution: "local",
					kind: "work",
				},
			],
		},
	},
];

const ctx = {
	hasUI: true,
	ui: {
		theme: makeTheme(),
		setStatus(key: string, text: string | undefined) {
			statuses.set(key, text);
		},
		setWidget(key: string, content: unknown) {
			widgets.set(key, content);
		},
	},
	sessionManager: {
		getBranch() {
			return branch;
		},
	},
};

const sessionStart = handlers.get("session_start");
if (!sessionStart) throw new Error("Missing session_start handler");
await sessionStart({ type: "session_start", reason: "startup" }, ctx);

if (!statuses.get("workgraph")) throw new Error("Expected workgraph status to be set after session_start");
if (!widgets.get("workgraph")) throw new Error("Expected workgraph widget to be set after session_start");

const sessionShutdown = handlers.get("session_shutdown");
if (!sessionShutdown) throw new Error("Missing session_shutdown handler");
await sessionShutdown({ type: "session_shutdown" }, ctx);

if (statuses.get("workgraph") !== undefined) throw new Error("Expected workgraph status to clear on session_shutdown");
if (widgets.get("workgraph") !== undefined) throw new Error("Expected workgraph widget to clear on session_shutdown");

console.log("ok");
