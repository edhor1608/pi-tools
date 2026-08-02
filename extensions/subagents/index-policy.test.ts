import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "./index.ts";

type CapturedTool = {
	name: string;
	parameters: { properties?: Record<string, unknown> };
	prepareArguments?: (args: unknown) => unknown;
};

await test("subagent_spawn advertises only the OpenRouter paid opt-in and prepares legacy session arguments", async () => {
	const tools: CapturedTool[] = [];
	let shutdown: (() => Promise<void>) | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_shutdown") shutdown = handler as () => Promise<void>;
		},
		registerTool(tool: unknown) {
			tools.push(tool as CapturedTool);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		getThinkingLevel() {
			return "high";
		},
		sendMessage() {},
	} as unknown as ExtensionAPI;

	subagentsExtension(pi);
	const spawn = tools.find((tool) => tool.name === "subagent_spawn");
	assert.ok(spawn);
	assert.ok(spawn.parameters.properties?.allowPaidOpenrouter !== undefined);
	assert.equal(spawn.parameters.properties?.allowPaidOpencode, undefined);
	assert.ok(spawn.prepareArguments);
	assert.deepEqual(
		spawn.prepareArguments({
			prompt: "continue old session",
			name: "legacy",
			harness: "pi",
			allowPaidOpencode: true,
		}),
		{
			prompt: "continue old session",
			name: "legacy",
			harness: "pi",
		},
	);

	await shutdown?.();
});
