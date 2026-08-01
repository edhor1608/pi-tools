/**
 * Reviewer execution for the review loop.
 *
 * Reviews run through the EXISTING subagent execution plane, consumed behind
 * the narrow `ReviewerBackend` interface below. Two implementations of the
 * plane are used, in preference order:
 *
 * 1. The LIVE manager of the subagents extension, published on globalThis
 *    under `Symbol.for("pi-tools.subagent-plane.v1")` (same cross-jiti
 *    sharing pattern as extensions/shared/status-bus.ts). Reviewers then
 *    appear in `/subagents`, share the manager's routing invariants, and can
 *    be cancelled through the same control plane.
 * 2. Fallback only when that handle is absent (e.g. isolated tests): a
 *    private runtime composed from the exported manager layer, using the
 *    smallest possible surface — `spawn`, `waitFor`, `cancel`, `view.get`.
 *
 * Model routing invariants (Claude-family models -> Claude Code backend,
 * never OpenCode) are enforced inside `manager.spawn` in both paths. A
 * backend failure surfaces as `ok: false` and becomes FSM state "blocked";
 * there is NO provider fallback of any kind.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { BackendName, SubagentSnapshot } from "../subagents/src/domain.ts";
import { SubagentManager, type SubagentManagerShape } from "../subagents/src/manager.ts";
import { createSubagentRuntime, runTool, type SubagentRuntime } from "../subagents/src/runtime.ts";

// --- Shared control-plane handle -------------------------------------------

/**
 * Narrow handle over the LIVE subagent manager, published by
 * extensions/subagents/index.ts. Structural contract only — no shared import
 * in the publisher, so the dependency direction stays subagents-agnostic.
 */
export interface SubagentPlane {
	spawn(
		backend: BackendName,
		request: {
			prompt: string;
			title: string;
			cwd: string;
			model?: string;
		},
	): Promise<SubagentSnapshot>;
	waitFor(ids: readonly string[]): Promise<void>;
	cancel(ids: readonly string[]): Promise<void>;
	send(id: string, text: string): Promise<void>;
	get(id: string): SubagentSnapshot | undefined;
}

const PLANE_KEY = Symbol.for("pi-tools.subagent-plane.v1");

export function getSubagentPlane(): SubagentPlane | undefined {
	return (globalThis as { [PLANE_KEY]?: SubagentPlane })[PLANE_KEY];
}

// --- Reviewer backend -------------------------------------------------------

export interface ReviewRequest {
	prompt: string;
	title: string;
	cwd: string;
	backend: BackendName;
	/** Model hint; omitted = backend default. Claude aliases reroute to Claude Code. */
	model?: string;
}

export interface ReviewerRunResult {
	ok: boolean;
	/** Raw final text of the reviewer (empty when the run failed). */
	raw: string;
	error?: string;
	subagentId?: string;
	modelLabel?: string;
	/** True when the run ended because it was cancelled (mode off / teardown). */
	cancelled?: boolean;
}

/** The ONLY surface the review loop needs from any execution plane. */
export interface ReviewerBackend {
	runReview(request: ReviewRequest): Promise<ReviewerRunResult>;
	/** Cancel every in-flight reviewer (mode off, session switch, teardown). */
	cancelActive(): Promise<void>;
	dispose(): Promise<void>;
}

/** Session context the pi backend needs to resolve models; provided lazily by index.ts. */
export interface ReviewerSpawnContext {
	parentCwd: string;
	inheritedModel?: { provider: string; id: string };
	inheritedThinkingLevel?: string;
	modelRegistry?: ModelRegistry;
}

export function createSubagentReviewerBackend(getSpawnContext: () => ReviewerSpawnContext): ReviewerBackend {
	let runtime: SubagentRuntime | undefined;
	let managerPromise: Promise<SubagentManagerShape> | undefined;
	const activeIds = new Set<string>();
	/** Ids torn down via cancelActive; their runs report `cancelled: true`. */
	const cancelledIds = new Set<string>();

	const getManager = () => {
		runtime ??= createSubagentRuntime();
		managerPromise ??= runtime.runPromise(SubagentManager);
		return managerPromise;
	};

	const settledResult = (settled: SubagentSnapshot | undefined, cancelled: boolean): ReviewerRunResult => {
		if (!settled) return { ok: false, raw: "", error: "reviewer disappeared from the subagent registry" };
		if (cancelled || settled.status === "error") {
			return {
				ok: false,
				raw: settled.finalText,
				error: cancelled ? "reviewer cancelled" : (settled.errorText ?? "reviewer failed"),
				cancelled,
				subagentId: settled.id,
				modelLabel: settled.meta.modelLabel,
			};
		}
		return { ok: true, raw: settled.finalText, subagentId: settled.id, modelLabel: settled.meta.modelLabel };
	};

	const runViaPlane = async (plane: SubagentPlane, request: ReviewRequest): Promise<ReviewerRunResult> => {
		const snap = await plane.spawn(request.backend, {
			prompt: request.prompt,
			title: request.title,
			cwd: request.cwd,
			model: request.model,
		});
		activeIds.add(snap.id);
		try {
			await plane.waitFor([snap.id]);
		} finally {
			activeIds.delete(snap.id);
		}
		return settledResult(plane.get(snap.id), cancelledIds.delete(snap.id));
	};

	const runViaOwnRuntime = async (request: ReviewRequest): Promise<ReviewerRunResult> => {
		const manager = await getManager();
		const active = runtime;
		if (!active) throw new Error("reviewer runtime already disposed");
		const snap = await runTool(
			active,
			manager.spawn(request.backend, {
				prompt: request.prompt,
				title: request.title,
				cwd: request.cwd,
				mode: "worker",
				model: request.model,
				parent: getSpawnContext(),
			}),
			{ interruptMessage: "Reviewer spawn aborted." },
		);
		activeIds.add(snap.id);
		try {
			await runTool(active, manager.waitFor([snap.id]), { interruptMessage: "Reviewer wait aborted." });
		} finally {
			activeIds.delete(snap.id);
		}
		return settledResult(manager.view.get(snap.id), cancelledIds.delete(snap.id));
	};

	return {
		async runReview(request) {
			try {
				const plane = getSubagentPlane();
				return plane ? await runViaPlane(plane, request) : await runViaOwnRuntime(request);
			} catch (error) {
				return { ok: false, raw: "", error: error instanceof Error ? error.message : String(error) };
			}
		},
		async cancelActive() {
			const ids = [...activeIds];
			activeIds.clear();
			if (ids.length === 0) return;
			for (const id of ids) cancelledIds.add(id);
			try {
				const plane = getSubagentPlane();
				if (plane) {
					await plane.cancel(ids);
					return;
				}
				if (runtime && managerPromise) {
					const manager = await managerPromise;
					await runTool(runtime, manager.cancel(ids), { interruptMessage: "Reviewer cancel aborted." });
				}
			} catch {
				// Cancellation is best-effort teardown; a failure here must not
				// break mode-off or session shutdown.
			}
		},
		async dispose() {
			await this.cancelActive();
			const closing = runtime;
			runtime = undefined;
			managerPromise = undefined;
			await closing?.dispose();
		},
	};
}
