import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { SubagentManager } from "./src/manager.ts";
import { claudeBackend } from "./src/backends/claude.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
	parentCwd: process.cwd(),
};

function task(prompt: string): SpawnTask {
	return {
		prompt,
		title: "live Claude test",
		cwd: process.cwd(),
		model: "haiku",
		reasoningEffort: "off",
		parent,
	};
}

async function claudeAvailable() {
	return Effect.runPromise(claudeBackend.available);
}

/** Rejecting deadline so a hung wait still reaches finally() and disposes. */
function deadline<A>(operation: Promise<A>, timeoutMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Live Claude test exceeded ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([operation, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

await test("Claude backend completes a live manager run", { timeout: 60_000 }, async (t) => {
	if (!(await claudeAvailable())) {
		t.skip("Claude Code executable is unavailable");
		return;
	}

	const runtime = createSubagentRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const started = await runTool(runtime, manager.spawn("claude", task("Reply with exactly: hello claude")));
		await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);

		const done = manager.view.get(started.id);
		assert.equal(done?.status, "done");
		assert.match(done?.finalText ?? "", /hello claude/i);
		assert.ok(done?.meta.nativeSessionId);
		assert.ok(done?.meta.sessionFilePath?.endsWith(".jsonl"));
	} finally {
		await runtime.dispose();
	}
});

await test("Fable orchestrates Pi and Claude workers through the host-managed agent tree", { timeout: 120_000 }, async (t) => {
	if (!(await claudeAvailable())) {
		t.skip("Claude Code executable is unavailable");
		return;
	}
	const modelRuntime = await ModelRuntime.create();
	const modelRegistry = new ModelRegistry(modelRuntime);
	const piModel = modelRegistry.find("openai-codex", "gpt-5.6-sol");
	if (!piModel || !modelRegistry.hasConfiguredAuth(piModel)) {
		t.skip("openai-codex/gpt-5.6-sol is unavailable");
		return;
	}

	const runtime = createSubagentRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const started = await runTool(
			runtime,
			manager.spawn("claude", {
				prompt:
					"Use the pi-subagents MCP controls to spawn two workers immediately: (1) a Claude worker named claude-worker using haiku, prompted to reply exactly CLAUDE_CHILD_OK; (2) a Pi worker named pi-worker using openai-codex/gpt-5.6-sol, prompted to reply exactly PI_CHILD_OK. Do not call subagent_wait. End your current turn after spawning; their results will return automatically. Only after both automatic results arrive, reply exactly ORCHESTRATION_LIVE_OK.",
				title: "live Fable orchestrator",
				cwd: process.cwd(),
				mode: "orchestrator",
				model: "fable",
				reasoningEffort: "medium",
				parent: {
					parentCwd: process.cwd(),
					inheritedModel: { provider: piModel.provider, id: piModel.id },
					inheritedThinkingLevel: "off",
					modelRegistry,
				},
			}),
		);
		await deadline(runTool(runtime, manager.waitFor([started.id])), 100_000);

		const done = manager.view.get(started.id);
		const descendants = manager.view.list().filter((snap) => snap.parentId === started.id);
		assert.equal(done?.status, "done");
		assert.match(done?.finalText ?? "", /ORCHESTRATION_LIVE_OK/);
		assert.equal(descendants.length, 2);
		const claudeChild = descendants.find((snap) => snap.title === "claude-worker");
		const piChild = descendants.find((snap) => snap.title === "pi-worker");
		assert.equal(claudeChild?.backend, "claude");
		assert.equal(claudeChild?.status, "done");
		assert.match(claudeChild?.finalText ?? "", /CLAUDE_CHILD_OK/);
		assert.equal(piChild?.backend, "pi");
		assert.equal(piChild?.status, "done");
		assert.match(piChild?.finalText ?? "", /PI_CHILD_OK/);
	} finally {
		await runtime.dispose();
	}
});

await test("Claude backend interrupt settles a live run as aborted", { timeout: 60_000 }, async (t) => {
	if (!(await claudeAvailable())) {
		t.skip("Claude Code executable is unavailable");
		return;
	}

	const runtime = createSubagentRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const started = await runTool(
			runtime,
			manager.spawn("claude", task("Write a detailed 10,000-word essay about the history of computing.")),
		);

		// Wait for streamed output so cancellation definitely lands mid-run and
		// exercises the SDK's normal interrupt receipt/result path.
		const streamDeadline = Date.now() + 15_000;
		while (
			manager.view.get(started.id)?.status === "running" &&
			!manager.view.get(started.id)?.liveAssistant?.text &&
			Date.now() < streamDeadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(manager.view.get(started.id)?.status, "running");
		assert.ok(manager.view.get(started.id)?.liveAssistant?.text);

		const report = await deadline(runTool(runtime, manager.cancel([started.id])), 20_000);

		assert.equal(report[0]?.cancelled, true);
		assert.equal(manager.view.get(started.id)?.status, "error");
		assert.equal(manager.view.get(started.id)?.errorText, "Run was aborted");
	} finally {
		await runtime.dispose();
	}
});
