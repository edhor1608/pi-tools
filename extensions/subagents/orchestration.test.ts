import assert from "node:assert/strict";
import test from "node:test";
import { Duration, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, OrchestrationController, ParentContext, SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import { SendError } from "./src/domain.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const controllers = new Map<string, OrchestrationController>();

function createTestRuntime(
	options: {
		claudeCadence?: number;
		piCadence?: number;
		piSpawnDelay?: number;
		failClaudeSends?: boolean;
		claudeSendDelay?: number;
		closeClaudeAfterSettlement?: boolean;
	} = {},
) {
	const claudeStub = makeStubBackend({
		backend: "claude",
		defaultModelLabel: "claude/fable",
		contextWindow: 200_000,
		toolName: "Bash",
		cadenceMs: options.claudeCadence ?? 5,
	});
	const claudeBackend: SubagentBackend = {
		...claudeStub,
		spawn: (task) => {
			if (task.orchestration) controllers.set(task.title, task.orchestration);
			const session = claudeStub.spawn(task);
			if (!options.failClaudeSends && !options.claudeSendDelay && !options.closeClaudeAfterSettlement) return session;
			return session.pipe(
				Effect.map((spawned) => ({
					...spawned,
					events: options.closeClaudeAfterSettlement
						? spawned.events.pipe(Stream.takeUntil((event) => event._tag === "RunSettled"))
						: spawned.events,
					send: options.failClaudeSends
						? () => new SendError({ message: "injected send failure" })
						: options.claudeSendDelay
							? (text) => Effect.sleep(Duration.millis(options.claudeSendDelay ?? 0)).pipe(Effect.andThen(spawned.send(text)))
							: (text) => spawned.send(text),
				})),
			);
		},
	};
	const piStub = makeStubBackend({
		backend: "pi",
		defaultModelLabel: "openai-codex/gpt-test",
		contextWindow: 128_000,
		toolName: "Read",
		cadenceMs: options.piCadence ?? 80,
	});
	const piBackend: SubagentBackend = {
		...piStub,
		spawn: (task) =>
			options.piSpawnDelay
				? Effect.sleep(Duration.millis(options.piSpawnDelay)).pipe(Effect.andThen(piStub.spawn(task)))
				: piStub.spawn(task),
	};
	const registry = Layer.sync(BackendRegistry, () => {
		const backends: SubagentBackend[] = [piBackend, claudeBackend];
		return new Map<BackendName, SubagentBackend>(backends.map((backend) => [backend.name, backend]));
	});
	return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}
const parent: ParentContext = { parentCwd: process.cwd() };
const task = (title: string, mode: "worker" | "orchestrator" = "worker"): SpawnTask => ({
	prompt: `Run ${title}`,
	title,
	cwd: process.cwd(),
	mode,
	parent,
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for orchestration state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

await test("an orchestrator owns a visible descendant tree and receives unawaited results", async () => {
	controllers.clear();
	const runtime = createTestRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const delivered: string[] = [];
		manager.view.setOnSettled((snap) => delivered.push(snap.id));

		const root = await runTool(runtime, manager.spawn("claude", task("lead", "orchestrator")));
		const controller = controllers.get("lead");
		assert.ok(controller, "manager should inject host controls before the Claude backend starts");

		const child = await controller.spawn({
			harness: "pi",
			prompt: "Research the implementation",
			title: "researcher",
		});
		assert.equal(root.mode, "orchestrator");
		assert.equal(root.depth, 0);
		assert.equal(child.parentId, root.id);
		assert.equal(child.depth, 1);
		assert.equal(child.mode, "worker");
		assert.deepEqual(
			(await controller.list()).map((snap) => snap.id),
			[child.id],
		);

		await waitUntil(() => manager.view.get(root.id)?.waitingForChildren === true);
		assert.equal(manager.view.get(root.id)?.status, "running");
		assert.deepEqual(delivered, []);

		await waitUntil(() => manager.view.get(root.id)?.status === "done");
		const completed = manager.view.get(root.id);
		assert.equal(completed?.waitingForChildren, false);
		assert.match(completed?.finalText ?? "", new RegExp(`Subagent ${child.id}`));
		assert.deepEqual(delivered, [root.id]);
	} finally {
		await runtime.dispose();
	}
});

await test("a fast child cannot produce an intermediate root completion", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 80, piCadence: 5 });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const delivered: string[] = [];
		manager.view.setOnSettled((snap) => delivered.push(snap.id));
		const root = await runTool(runtime, manager.spawn("claude", task("slow-lead", "orchestrator")));
		const controller = controllers.get("slow-lead");
		assert.ok(controller);
		const child = await controller.spawn({ harness: "pi", prompt: "Fast result", title: "fast-worker" });

		await waitUntil(() => manager.view.get(root.id)?.status === "done", 15_000);
		assert.match(manager.view.get(root.id)?.finalText ?? "", new RegExp(`Subagent ${child.id}`));
		assert.deepEqual(delivered, [root.id]);
	} finally {
		await runtime.dispose();
	}
});

await test("a late parent wait claims a deferred nested result without automatic redelivery", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 80, piCadence: 5 });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const root = await runTool(runtime, manager.spawn("claude", task("waiting-lead", "orchestrator")));
		const controller = controllers.get("waiting-lead");
		assert.ok(controller);
		const child = await controller.spawn({ harness: "pi", prompt: "Fast result", title: "claimed-worker" });
		await waitUntil(() => manager.view.get(child.id)?.status === "done");
		const [claimed] = await controller.wait([child.id]);
		assert.equal(claimed?.id, child.id);

		await waitUntil(() => manager.view.get(root.id)?.status === "done", 10_000);
		const injected = manager.view
			.get(root.id)
			?.transcript.some((item) => item.kind === "user" && item.text.includes(`Subagent ${child.id}`));
		assert.equal(injected, false);
	} finally {
		await runtime.dispose();
	}
});

await test("restarting a settled child retracts its stale deferred result", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 80, piCadence: 5 });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const root = await runTool(runtime, manager.spawn("claude", task("restart-lead", "orchestrator")));
		const controller = controllers.get("restart-lead");
		assert.ok(controller);
		const child = await controller.spawn({ harness: "pi", prompt: "Old result", title: "restart-worker" });
		await waitUntil(() => manager.view.get(child.id)?.status === "done");
		await controller.send(child.id, "Current result");
		await waitUntil(() => manager.view.get(root.id)?.status === "done", 15_000);

		const resultMessages = manager.view
			.get(root.id)
			?.transcript.filter((item) => item.kind === "user" && item.text.includes(`Subagent ${child.id}`));
		assert.equal(resultMessages?.length, 1);
		assert.match(resultMessages?.[0]?.kind === "user" ? resultMessages[0].text : "", /Current result/);
		assert.doesNotMatch(resultMessages?.[0]?.kind === "user" ? resultMessages[0].text : "", /Old result/);
	} finally {
		await runtime.dispose();
	}
});

await test("automatic descendant delivery retracts a settled root generation before restart", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 5, piCadence: 5 });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const restarted: string[] = [];
		manager.view.setOnStarted((id) => restarted.push(id));
		const root = await runTool(runtime, manager.spawn("claude", task("settled-lead", "orchestrator")));
		const controller = controllers.get("settled-lead");
		assert.ok(controller);
		const child = await controller.spawn({ harness: "pi", prompt: "First result", title: "later-worker" });
		await controller.wait([child.id]);
		await waitUntil(() => manager.view.get(root.id)?.status === "done");

		await runTool(runtime, manager.send(child.id, "Second result"));
		await waitUntil(() => manager.view.get(root.id)?.status === "done" && restarted.includes(root.id), 10_000);
		assert.ok(restarted.includes(child.id));
		assert.ok(restarted.includes(root.id));
	} finally {
		await runtime.dispose();
	}
});

await test("a failed orchestrator cancels descendants before reporting failure", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 5, piCadence: 80, closeClaudeAfterSettlement: true });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const delivered: string[] = [];
		manager.view.setOnSettled((snap) => delivered.push(snap.id));
		const root = await runTool(
			runtime,
			manager.spawn("claude", { ...task("failing-lead", "orchestrator"), prompt: "FAIL: orchestrator failure" }),
		);
		const controller = controllers.get("failing-lead");
		assert.ok(controller);
		const child = await controller.spawn({ harness: "pi", prompt: "Slow work", title: "orphan-candidate" });

		await waitUntil(() => manager.view.get(root.id)?.status === "error", 10_000);
		assert.equal(manager.view.get(child.id)?.status, "error");
		assert.deepEqual(delivered, [root.id]);
	} finally {
		await runtime.dispose();
	}
});

await test("a descendant-delivery failure cancels remaining work before reporting failure", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 5, piCadence: 80, failClaudeSends: true });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const delivered: string[] = [];
		manager.view.setOnSettled((snap) => delivered.push(snap.id));
		const root = await runTool(runtime, manager.spawn("claude", task("delivery-failure", "orchestrator")));
		const controller = controllers.get("delivery-failure");
		assert.ok(controller);
		await controller.spawn({ harness: "claude", prompt: "Fast result", title: "fast-result" });
		const slow = await controller.spawn({ harness: "pi", prompt: "Slow work", title: "cancelled-remainder" });

		await waitUntil(() => manager.view.get(root.id)?.status === "error", 10_000);
		assert.equal(manager.view.get(slow.id)?.status, "error");
		assert.match(manager.view.get(root.id)?.errorText ?? "", /deliver descendant results/);
		assert.deepEqual(delivered, [root.id]);
	} finally {
		await runtime.dispose();
	}
});

await test("cancellation cannot resurrect an orchestrator with a pending result turn", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 5, piCadence: 40, claudeSendDelay: 300 });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const root = await runTool(runtime, manager.spawn("claude", task("pending-turn", "orchestrator")));
		const controller = controllers.get("pending-turn");
		assert.ok(controller);
		const child = await controller.spawn({ harness: "pi", prompt: "Return later", title: "turn-trigger" });
		await waitUntil(() => manager.view.get(child.id)?.status === "done");
		await runTool(runtime, manager.cancel([root.id]));
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(manager.view.get(root.id)?.status, "error");
		assert.equal(manager.view.get(root.id)?.errorText, "Run was aborted");
	} finally {
		await runtime.dispose();
	}
});

await test("cancellation closes a descendant spawn already in flight", async () => {
	controllers.clear();
	const runtime = createTestRuntime({ claudeCadence: 80, piSpawnDelay: 500 });
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const root = await runTool(runtime, manager.spawn("claude", task("cancelled-lead", "orchestrator")));
		const controller = controllers.get("cancelled-lead");
		assert.ok(controller);
		const spawning = controller.spawn({ harness: "pi", prompt: "Never start", title: "in-flight" });
		const spawnRejected = spawning.then(
			() => false,
			() => true,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await runTool(runtime, manager.cancel([root.id]));
		assert.equal(await spawnRejected, true);
		assert.equal(
			manager.view.list().some((snap) => snap.parentId === root.id && snap.status === "running"),
			false,
		);
	} finally {
		await runtime.dispose();
	}
});

await test("nested orchestrator capability has a mechanical depth guard", async () => {
	controllers.clear();
	const runtime = createTestRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const root = await runTool(runtime, manager.spawn("claude", task("depth-0", "orchestrator")));
		let controller = controllers.get("depth-0");
		assert.ok(controller);
		for (let depth = 1; depth <= 8; depth++) {
			const title = `depth-${depth}`;
			const child: SubagentSnapshot = await controller.spawn({
				harness: "claude",
				prompt: `Lead depth ${depth}`,
				title,
				mode: "orchestrator",
			});
			assert.equal(child.depth, depth);
			controller = controllers.get(title);
			assert.ok(controller);
		}
		await assert.rejects(
			controller.spawn({ harness: "claude", prompt: "Too deep", title: "depth-9", mode: "orchestrator" }),
			/depth cannot exceed 8/,
		);
		await runTool(runtime, manager.cancel([root.id]));
	} finally {
		await runtime.dispose();
	}
});

await test("orchestrator controls are descendant-scoped and cancellation tears down a subtree", async () => {
	controllers.clear();
	const runtime = createTestRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const root = await runTool(runtime, manager.spawn("claude", task("root", "orchestrator")));
		const sibling = await runTool(runtime, manager.spawn("claude", task("sibling")));
		const rootController = controllers.get("root");
		assert.ok(rootController);

		const branch = await rootController.spawn({
			harness: "claude",
			prompt: "Lead a branch",
			title: "branch",
			mode: "orchestrator",
		});
		const branchController = controllers.get("branch");
		assert.ok(branchController);
		const leaf = await branchController.spawn({
			harness: "pi",
			prompt: "Long leaf task",
			title: "leaf",
		});

		assert.equal(await rootController.get(sibling.id), undefined);
		await assert.rejects(rootController.send(sibling.id, "not yours"), /not a descendant/);
		assert.deepEqual(
			(await rootController.list()).map((snap) => snap.id),
			[branch.id, leaf.id],
		);

		await runTool(runtime, manager.cancel([root.id]));
		assert.equal(manager.view.get(root.id)?.status, "error");
		assert.equal(manager.view.get(branch.id)?.status, "error");
		assert.equal(manager.view.get(leaf.id)?.status, "error");
	} finally {
		await runtime.dispose();
	}
});
