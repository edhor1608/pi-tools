import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationController, SubagentSnapshot } from "./src/domain.ts";
import { createOrchestrationTools } from "./src/orchestration.ts";

const snapshot = (id: string): SubagentSnapshot => ({
	id,
	parentId: "sa-1",
	depth: 1,
	mode: "worker",
	backend: "pi",
	title: "worker",
	prompt: "work",
	cwd: process.cwd(),
	status: "done",
	waitingForChildren: false,
	createdAt: 1,
	settledAt: 2,
	meta: { backend: "pi", modelLabel: "openai-codex/gpt-test" },
	usage: {},
	transcript: [],
	liveTools: [],
	queued: [],
	finalText: "worker output",
	turns: 1,
});

type ToolHandler = (
	args: Record<string, unknown>,
	extra: unknown,
) => Promise<{
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}>;

function handler(tools: ReturnType<typeof createOrchestrationTools>, name: string): ToolHandler {
	const found = tools.find((entry) => entry.name === name);
	assert.ok(found);
	return found.handler as unknown as ToolHandler;
}

await test("Claude orchestration tools map all host controls", async () => {
	const calls: string[] = [];
	const child = snapshot("sa-2");
	const controller: OrchestrationController = {
		spawn: async (request) => {
			calls.push(`spawn:${request.harness}:${request.mode}:${request.workingDir}`);
			return child;
		},
		wait: async (ids) => {
			calls.push(`wait:${ids.join(",")}`);
			return [child];
		},
		cancel: async (ids) => {
			calls.push(`cancel:${ids.join(",")}`);
			return ids.map((id) => ({ id, title: "worker", status: "error", cancelled: true }));
		},
		send: async (id, text) => {
			calls.push(`send:${id}:${text}`);
		},
		get: async (id) => {
			calls.push(`check:${id}`);
			return id === child.id ? child : undefined;
		},
		list: async () => {
			calls.push("list");
			return [child];
		},
	};
	const tools = createOrchestrationTools(controller);
	assert.deepEqual(
		tools.map((entry) => entry.name),
		["subagent_spawn", "subagent_wait", "subagent_cancel", "subagent_send", "subagent_check", "subagent_list"],
	);

	const spawned = await handler(tools, "subagent_spawn")(
		{
			prompt: "do work",
			name: "worker",
			harness: "claude",
			working_dir: "slice",
			mode: "orchestrator",
		},
		{},
	);
	assert.equal(spawned.isError, undefined);
	assert.match(spawned.content[0]?.text ?? "", /sa-2/);
	await handler(tools, "subagent_wait")({ ids: ["sa-2"] }, {});
	await handler(tools, "subagent_cancel")({ ids: ["sa-2"] }, {});
	await handler(tools, "subagent_send")({ id: "sa-2", message: "revise" }, {});
	await handler(tools, "subagent_check")({ id: "sa-2" }, {});
	await handler(tools, "subagent_list")({}, {});

	assert.deepEqual(calls, ["spawn:claude:orchestrator:slice", "wait:sa-2", "cancel:sa-2", "send:sa-2:revise", "check:sa-2", "list"]);
});

await test("Claude orchestration tools return bounded tool errors", async () => {
	const controller: OrchestrationController = {
		spawn: async () => {
			throw new Error("denied");
		},
		wait: async () => [],
		cancel: async () => [],
		send: async () => {},
		get: async () => undefined,
		list: async () => [],
	};
	const tools = createOrchestrationTools(controller);
	const failed = await handler(tools, "subagent_spawn")({ prompt: "x", name: "x", harness: "pi" }, {});
	assert.equal(failed.isError, true);
	assert.match(failed.content[0]?.text ?? "", /denied/);

	const missing = await handler(tools, "subagent_check")({ id: "sa-404" }, {});
	assert.equal(missing.isError, true);
	assert.match(missing.content[0]?.text ?? "", /not found/);
});
