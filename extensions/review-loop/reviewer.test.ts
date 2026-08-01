import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import { PLANE_KEY } from "./plane-claim.ts";
import { createSubagentReviewerBackend, type SubagentPlane, waitForNewTurn } from "./reviewer.ts";

const snapshot = (over: Partial<SubagentSnapshot> & { id: string }): SubagentSnapshot => ({
	depth: 0,
	mode: "worker",
	backend: "pi",
	title: "reviewer",
	prompt: "p",
	cwd: "/tmp",
	status: "done",
	waitingForChildren: false,
	createdAt: 0,
	meta: { backend: "pi" },
	usage: {},
	transcript: [],
	liveTools: [],
	queued: [],
	finalText: "",
	turns: 1,
	...over,
});

type PlaneSlot = { [PLANE_KEY]?: SubagentPlane };

void describe("cancel during pending spawn", () => {
	void test("a spawn resolving AFTER cancelActive is cancelled on resolution, not left running", async () => {
		const cancelled: string[][] = [];
		let resolveSpawn: ((snap: SubagentSnapshot) => void) | undefined;
		const spawned = snapshot({ id: "r1", status: "running" });
		const plane: SubagentPlane = {
			spawn: () => new Promise((resolve) => (resolveSpawn = resolve)),
			waitFor: async () => {
				throw new Error("waitFor must not be reached for a cancelled spawn");
			},
			cancel: async (ids) => {
				cancelled.push([...ids]);
			},
			send: async () => undefined,
			get: () => spawned,
		};
		const host = globalThis as PlaneSlot;
		host[PLANE_KEY] = plane;
		try {
			const backend = createSubagentReviewerBackend(() => ({ parentCwd: "/tmp" }));
			const run = backend.runReview({ prompt: "p", title: "t", cwd: "/tmp", backend: "pi" });
			// mode-off races the pending spawn: id is not yet in activeIds.
			await backend.cancelActive();
			assert.equal(cancelled.length, 0, "nothing to cancel yet — the spawn is still pending");
			resolveSpawn?.(spawned);
			const result = await run;
			assert.equal(result.cancelled, true);
			assert.equal(result.ok, false);
			assert.deepEqual(cancelled, [["r1"]], "the late-resolving reviewer was cancelled on resolution");
		} finally {
			delete host[PLANE_KEY];
		}
	});

	void test("without an intervening cancel the spawn proceeds normally", async () => {
		const done = snapshot({ id: "r2", status: "done", finalText: "verdict" });
		const plane: SubagentPlane = {
			spawn: async () => done,
			waitFor: async () => undefined,
			cancel: async () => undefined,
			send: async () => undefined,
			get: () => done,
		};
		const host = globalThis as PlaneSlot;
		host[PLANE_KEY] = plane;
		try {
			const backend = createSubagentReviewerBackend(() => ({ parentCwd: "/tmp" }));
			const result = await backend.runReview({ prompt: "p", title: "t", cwd: "/tmp", backend: "pi" });
			assert.equal(result.ok, true);
			assert.equal(result.raw, "verdict");
		} finally {
			delete host[PLANE_KEY];
		}
	});
});

void describe("waitForNewTurn (settled-owner fix race)", () => {
	const FAST = { timeoutMs: 500, pollMs: 5 };

	void test("observes the new turn once the snapshot goes running", async () => {
		let polls = 0;
		const get = () => snapshot({ id: "s1", status: polls++ < 2 ? "done" : "running", settledAt: 10, turns: 3 });
		assert.equal(await waitForNewTurn(get, "s1", { settledAt: 10, turns: 3 }, FAST), "observed");
	});

	void test("a fast turn that settled BETWEEN polls still counts (settledAt/turns moved)", async () => {
		const get = () => snapshot({ id: "s1", status: "done", settledAt: 99, turns: 4 });
		assert.equal(await waitForNewTurn(get, "s1", { settledAt: 10, turns: 3 }, FAST), "observed");
	});

	void test("an unchanged stale 'done' snapshot times out — never a silent pass", async () => {
		const get = () => snapshot({ id: "s1", status: "done", settledAt: 10, turns: 3 });
		assert.equal(await waitForNewTurn(get, "s1", { settledAt: 10, turns: 3 }, { timeoutMs: 30, pollMs: 5 }), "timeout");
	});

	void test("a disappeared owner reports gone", async () => {
		assert.equal(await waitForNewTurn(() => undefined, "s1", { settledAt: 10, turns: 3 }, FAST), "gone");
	});
});
