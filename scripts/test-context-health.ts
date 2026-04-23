import contextHealthExtension from "../extensions/context-health.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const sentMessages: any[] = [];

const api = {
	registerMessageRenderer() {},
	registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
		commands.set(name, spec);
	},
	on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	sendMessage(message: any) {
		sentMessages.push(message);
	},
} as any;

contextHealthExtension(api);

const command = commands.get("context-health")?.handler;
const afterProviderResponse = handlers.get("after_provider_response")?.[0];
assert(command, "expected /context-health command to register");
assert(afterProviderResponse, "expected after_provider_response handler to register");

const branch = [
	{
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 400,
				cacheRead: 600,
				cacheWrite: 0,
				totalTokens: 1200,
				cost: { total: 0.42 },
			},
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		},
	},
];

const ctx = {
	sessionManager: {
		getBranch: () => branch,
	},
	model: {
		provider: "openai-codex",
		id: "gpt-5.4",
		contextWindow: 200000,
	},
	modelRegistry: {
		isUsingOAuth: () => false,
	},
	getContextUsage: () => ({ percent: 12.5, contextWindow: 200000 }),
};

await afterProviderResponse(
	{
		status: 429,
		headers: {
			"retry-after": "12",
			"x-request-id": "req_123",
			"content-type": "text/event-stream",
		},
	},
	ctx,
);

const originalDebugEnv = process.env.PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG;
try {
	delete process.env.PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG;
	sentMessages.length = 0;
	await command("", ctx);
	const defaultMessage = sentMessages.at(-1);
	assert(defaultMessage, "expected /context-health to send a message without provider debug enabled");
	assert(!String(defaultMessage.content).includes("Provider Response Debug"), "expected provider response details to stay hidden by default");

	process.env.PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG = "1";
	sentMessages.length = 0;
	await command("", ctx);
	const debugMessage = sentMessages.at(-1);
	assert(debugMessage, "expected /context-health to send a message with provider debug enabled");
	assert(String(debugMessage.content).includes("Provider Response Debug"), "expected provider response debug section when the env flag is enabled");
	assert(String(debugMessage.content).includes("- last provider status: 429"), "expected provider status to be captured from after_provider_response");
	assert(String(debugMessage.content).includes("retry-after=12"), "expected interesting provider headers to be included in debug output");
	assert(String(debugMessage.content).includes("x-request-id=req_123"), "expected request ids to be included in debug output");
	assert(!String(debugMessage.content).includes("content-type=text/event-stream"), "expected non-interesting headers to stay out of debug output");

	console.log(
		JSON.stringify(
			{
				defaultHasProviderDebug: String(defaultMessage.content).includes("Provider Response Debug"),
				debugHasProviderDebug: String(debugMessage.content).includes("Provider Response Debug"),
				debugContent: String(debugMessage.content),
			},
			null,
			2,
		),
	);
} finally {
	if (originalDebugEnv === undefined) delete process.env.PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG;
	else process.env.PI_TOOLS_CONTEXT_HEALTH_PROVIDER_DEBUG = originalDebugEnv;
}
