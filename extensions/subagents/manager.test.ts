import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager, SubagentManagerLive, type SubagentManagerShape } from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
	const backends: SubagentBackend[] = [
		piBackend,
		makeStubBackend({
			backend: "claude",
			defaultModelLabel: "claude/sonnet",
			contextWindow: 200_000,
			toolName: "Bash",
			cadenceMs: 40,
		}),
	];
	return new Map<BackendName, SubagentBackend>(backends.map((backend) => [backend.name, backend]));
});

const createTestRuntime = () => ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)));

const parent: ParentContext = {
	parentCwd: process.cwd(),
};

function task(prompt: string): SpawnTask {
	return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(run: (manager: SubagentManagerShape, runtime: ReturnType<typeof createTestRuntime>) => Promise<void>) {
	const runtime = createTestRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		await run(manager, runtime);
	} finally {
		await runtime.dispose();
	}
}

await test("stub subagent completes and delivers a final result", async () => {
	await withManager(async (manager, runtime) => {
		const settled: Array<{ id: string; consumed: boolean }> = [];
		manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

		const snap = await runTool(runtime, manager.spawn("claude", task("Say hello to the tests")));
		assert.equal(snap.status, "running");
		assert.equal(snap.backend, "claude");
		assert.ok(snap.meta.sessionFilePath);

		await runTool(runtime, manager.waitFor([snap.id]));
		const done = manager.view.get(snap.id);
		assert.ok(done);
		assert.equal(done.status, "done");
		assert.match(done.finalText, /\[stub:claude\] completed: Say hello to the tests/);
		assert.ok(done.turns >= 2);
		assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
		assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
	});
});

await test("failed prompts settle as errors and unconsumed results are delivered", async () => {
	await withManager(async (manager, runtime) => {
		const settled: Array<{ id: string; consumed: boolean }> = [];
		manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

		const snap = await runTool(runtime, manager.spawn("claude", task("FAIL: blow up please")));
		while (manager.view.get(snap.id)?.status === "running") {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const failed = manager.view.get(snap.id);
		assert.equal(failed?.status, "error");
		assert.match(failed?.errorText ?? "", /task failed/);
		assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
	});
});

await test("cancel interrupts a running subagent", async () => {
	await withManager(async (manager, runtime) => {
		const snap = await runTool(runtime, manager.spawn("claude", task("Long running task")));
		const report = await runTool(runtime, manager.cancel([snap.id]));
		assert.deepEqual(report, [{ id: snap.id, title: "test", status: "error", cancelled: true }]);
		assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
	});
});

await test("the manager imposes no subagent concurrency limit", async () => {
	await withManager(async (manager, runtime) => {
		const spawns = await runTool(
			runtime,
			Effect.forEach(
				Array.from({ length: 8 }, (_, index) => index + 1),
				(number) => manager.spawn("claude", task(`Task ${number}`)),
				{
					concurrency: "unbounded",
				},
			),
		);
		assert.equal(spawns.length, 8);
		assert.equal(manager.view.list().filter((snapshot) => snapshot.status === "running").length, 8);
		await runTool(runtime, manager.cancel(spawns.map((snapshot) => snapshot.id)));
	});
});

await test("Claude models requested through Pi route to Claude Code", async () => {
	await withManager(async (manager, runtime) => {
		const snap = await runTool(runtime, manager.spawn("pi", { ...task("review this"), model: "opencode/claude-fable-5" }));
		assert.equal(snap.backend, "claude");
		assert.equal(snap.meta.modelLabel, "claude-fable-5");
		await runTool(runtime, manager.cancel([snap.id]));
	});
});

await test("Claude Code model aliases requested through Pi route to Claude Code", async () => {
	await withManager(async (manager, runtime) => {
		for (const requested of ["fable", "opencode/haiku", "anthropic/opus", "other/sonnet"]) {
			const snap = await runTool(runtime, manager.spawn("pi", { ...task("review this"), model: requested }));
			assert.equal(snap.backend, "claude");
			assert.equal(snap.meta.modelLabel, requested.split("/").at(-1));
			await runTool(runtime, manager.cancel([snap.id]));
		}
	});
});

await test("inherited Claude models route Pi spawns to Claude Code", async () => {
	await withManager(async (manager, runtime) => {
		const snap = await runTool(
			runtime,
			manager.spawn("pi", {
				...task("review this"),
				parent: {
					parentCwd: process.cwd(),
					inheritedModel: { provider: "opencode", id: "claude-opus-4-6" },
				},
			}),
		);
		assert.equal(snap.backend, "claude");
		assert.equal(snap.meta.modelLabel, "claude-opus-4-6");
		await runTool(runtime, manager.cancel([snap.id]));
	});
});

await test("explicit Claude harness normalizes provider-qualified Claude models", async () => {
	await withManager(async (manager, runtime) => {
		const snap = await runTool(runtime, manager.spawn("claude", { ...task("review this"), model: "opencode/claude-fable-5" }));
		assert.equal(snap.meta.modelLabel, "claude-fable-5");
		await runTool(runtime, manager.cancel([snap.id]));
	});
});

await test("explicit Claude harness keeps Claude Code defaults when model is omitted", async () => {
	await withManager(async (manager, runtime) => {
		const snap = await runTool(
			runtime,
			manager.spawn("claude", {
				...task("review this"),
				parent: {
					parentCwd: process.cwd(),
					inheritedModel: { provider: "anthropic", id: "claude-opus-4-6" },
				},
			}),
		);
		assert.equal(snap.meta.modelLabel, "claude/sonnet");
		await runTool(runtime, manager.cancel([snap.id]));
	});
});

await test("orchestrator mode requires an effective Claude backend", async () => {
	await withManager(async (manager, runtime) => {
		await assert.rejects(runTool(runtime, manager.spawn("pi", { ...task("lead"), mode: "orchestrator" })), /Claude backend/);
		const routed = await runTool(runtime, manager.spawn("pi", { ...task("lead"), mode: "orchestrator", model: "fable" }));
		assert.equal(routed.backend, "claude");
		assert.equal(routed.mode, "orchestrator");
		await runTool(runtime, manager.cancel([routed.id]));
	});
});

await test("pi spawn fails clearly without the parent model registry", async () => {
	await withManager(async (manager, runtime) => {
		await assert.rejects(runTool(runtime, manager.spawn("pi", task("needs a registry"))), /model registry/);
		const snap = await runTool(runtime, manager.spawn("claude", task("ok")));
		assert.equal(snap.backend, "claude");
	});
});

await test("send steers an idle subagent into another turn and retracts its settled result", async () => {
	await withManager(async (manager, runtime) => {
		const restarted: string[] = [];
		manager.view.setOnStarted((id) => restarted.push(id));
		const snap = await runTool(runtime, manager.spawn("claude", task("First turn")));
		await runTool(runtime, manager.waitFor([snap.id]));
		assert.equal(manager.view.get(snap.id)?.status, "done");

		await runTool(runtime, manager.send(snap.id, "Second turn"));
		while (manager.view.get(snap.id)?.status !== "running") {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.deepEqual(restarted, [snap.id]);
		await runTool(runtime, manager.waitFor([snap.id]));
		const afterSecond = manager.view.get(snap.id);
		assert.equal(afterSecond?.status, "done");
		assert.match(afterSecond?.finalText ?? "", /Second turn/);
	});
});
