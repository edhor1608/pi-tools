/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Context, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
	BackendName,
	LiveToolState,
	NestedCancelResult,
	NestedSpawnRequest,
	OrchestrationController,
	RunOutcome,
	SpawnTask,
	SubagentEvent,
	SubagentMeta,
	SubagentMode,
	SubagentSnapshot,
	SubagentStatus,
	TranscriptItem,
} from "./domain.ts";
import { BackendUnavailableError, SendError, SpawnError } from "./domain.ts";
import { resolveRoute } from "./routing-policy.ts";
export const MAX_TRACKED = 64;
export const MAX_ORCHESTRATOR_DEPTH = 8;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;
const NESTED_RESULT_MAX_LENGTH = 24 * 1_024;

function bounded(text: string) {
	return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

/** Mirror the Pi backend's model lookup so routing can guard the concrete provider before spawning. */
function resolvedModelForRouting(task: SpawnTask) {
	const registry = task.parent.modelRegistry;
	if (!task.model) return task.parent.inheritedModel;
	if (!registry) return undefined;

	const slash = task.model.indexOf("/");
	if (slash > 0) {
		const found = registry.find(task.model.slice(0, slash), task.model.slice(slash + 1));
		return found ? { provider: found.provider, id: found.id } : undefined;
	}
	if (task.parent.inheritedModel) {
		const found = registry.find(task.parent.inheritedModel.provider, task.model);
		if (found) return { provider: found.provider, id: found.id };
	}
	const matches = registry.getAll().filter((model) => model.id === task.model);
	return matches.length === 1 ? { provider: matches[0]!.provider, id: matches[0]!.id } : undefined;
}

function nestedResultMessage(snap: SubagentSnapshot) {
	const verb = snap.status === "error" ? "failed" : "finished";
	const output = (snap.finalText || "(no output)").slice(-NESTED_RESULT_MAX_LENGTH);
	return `Subagent ${snap.id} "${snap.title}" ${verb}.${snap.errorText ? `\nError: ${snap.errorText}` : ""}\n\n${output}`;
}

function boundedTranscriptText(text: string) {
	return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
	snapshot.transcript.push(item);
	if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
		snapshot.transcript.splice(0, snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS);
	}
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
	id: string;
	parentId?: string;
	depth: number;
	mode: SubagentMode;
	backend: BackendName;
	title: string;
	prompt: string;
	cwd: string;
	status: SubagentStatus;
	waitingForChildren: boolean;
	createdAt: number;
	settledAt?: number;
	errorText?: string;
	meta: SubagentMeta;
	usage: { tokens?: number; contextWindow?: number };
	transcript: TranscriptItem[];
	liveAssistant?: { text: string; thinking: string };
	liveTools: LiveToolState[];
	queued: SubagentSnapshot["queued"];
	finalText: string;
	turns: number;
}

interface Entry {
	snapshot: MutableSnapshot;
	session: SubagentSession;
	nativeRunning: boolean;
	startingTurn: boolean;
	cancelling: boolean;
	terminating: boolean;
	scope: Scope.Closeable;
	pump?: Fiber.Fiber<void>;
	deliveryFiber?: Fiber.Fiber<void>;
	liveToolMap: Map<string, LiveToolState>;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
	list(): ReadonlyArray<SubagentSnapshot>;
	get(id: string): SubagentSnapshot | undefined;
	size(): number;
	/** Any-change notification (footer status, dashboard). */
	subscribe(listener: () => void): () => void;
	/** Per-subagent notification (takeover view). */
	subscribeTo(id: string, listener: () => void): () => void;
	/** Fire-and-forget: steer/continue a subagent (takeover input). */
	requestSend(id: string, text: string): void;
	/** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
	requestAbort(id: string): void;
	/**
	 * Register the settle hook. `consumed` is true when an active
	 * subagent_wait/cancel is collecting the result (so it must not also be
	 * delivered as a follow-up message).
	 */
	setOnSettled(hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined): void;
	/** Retract a deferred root result when an idle session starts another turn. */
	setOnStarted(hook: ((id: string) => void) | undefined): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult extends NestedCancelResult {}

export interface SpawnOptions {
	readonly userAllowsPaidOpencode?: boolean;
	readonly allowPaidOpencode?: boolean;
	readonly paidOpencodeConfigPath?: string;
}

export interface SubagentManagerShape {
	spawn(
		backend: BackendName,
		task: SpawnTask,
		options?: SpawnOptions,
	): Effect.Effect<SubagentSnapshot, SpawnError | BackendUnavailableError>;
	/**
	 * Wait until all listed subagents are settled. Unknown ids are treated as
	 * settled (the tool layer validates ids first). While waiting, settles for
	 * these ids are marked "consumed". Interruption (tool abort) releases the
	 * interest and leaves the subagents running.
	 */
	waitFor(ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void): Effect.Effect<void>;
	/** Cancel running subagents; resolves when they have settled. */
	cancel(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CancelResult>>;
	send(id: string, text: string): Effect.Effect<void, SendError>;
	get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
	readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
	readonly disposeAll: Effect.Effect<void>;
	readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<SubagentManager, SubagentManagerShape>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
	const registry = yield* BackendRegistry;
	const effectContext = yield* Effect.context();
	// Detached runners preserve the manager's services instead of using the
	// global runtime. Promise execution powers the in-process Claude MCP tools.
	const runDetached = Effect.runForkWith(effectContext);
	const runPromise = Effect.runPromiseWith(effectContext);

	const entries = new Map<string, Entry>();
	const waitInterest = new Map<string, number>();
	const pendingDeliveries = new Map<string, Array<{ sourceId: string; message: string }>>();
	const controllerOperations = new Map<AbortController, string>();
	const controllerPromises = new Map<Promise<unknown>, string>();
	const inFlightParents = new Map<string, string | undefined>();
	const cancelledSpawns = new Set<string>();
	const listeners = new Set<() => void>();
	/** One-shot nextChange waiters, swapped out before invocation so waiters
	 * re-registering during notification are not visited in the same sweep. */
	let changeWaiters: Array<() => void> = [];
	const idListeners = new Map<string, Set<() => void>>();
	const cleanups = new Set<Fiber.Fiber<unknown>>();
	let modelCounter = 0;
	let disposed = false;
	let onSettled: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;
	let onStarted: ((id: string) => void) | undefined;

	const notify = (id?: string) => {
		const waiters = changeWaiters;
		changeWaiters = [];
		for (const waiter of waiters) waiter();
		for (const listener of Array.from(listeners)) {
			try {
				listener();
			} catch {
				// A failed status/render listener must not corrupt lifecycle state.
			}
		}
		if (id) {
			for (const listener of idListeners.get(id) ?? []) {
				try {
					listener();
				} catch {
					// Same.
				}
			}
		}
	};

	/** Resolves on the next state change. Interruption unregisters the waiter. */
	const nextChange = Effect.callback<void>((resume) => {
		const waiter = () => resume(Effect.void);
		changeWaiters.push(waiter);
		return Effect.sync(() => {
			const index = changeWaiters.indexOf(waiter);
			if (index >= 0) changeWaiters.splice(index, 1);
		});
	});

	const interestKey = (recipientId: string | undefined, id: string) => `${recipientId ?? "root"}:${id}`;
	const addInterest = (ids: ReadonlyArray<string>, recipientId?: string) => {
		for (const id of ids) {
			const key = interestKey(recipientId, id);
			waitInterest.set(key, (waitInterest.get(key) ?? 0) + 1);
		}
	};
	const releaseInterest = (ids: ReadonlyArray<string>, recipientId?: string) => {
		for (const id of ids) {
			const key = interestKey(recipientId, id);
			const count = (waitInterest.get(key) ?? 1) - 1;
			if (count <= 0) waitInterest.delete(key);
			else waitInterest.set(key, count);
		}
	};

	const claimPendingDeliveries = (recipientId: string, ids: ReadonlyArray<string>) => {
		const pending = pendingDeliveries.get(recipientId);
		if (!pending) return;
		const claimed = new Set(ids);
		const remaining = pending.filter((delivery) => !claimed.has(delivery.sourceId));
		if (remaining.length > 0) pendingDeliveries.set(recipientId, remaining);
		else pendingDeliveries.delete(recipientId);
	};
	const hasPendingDeliveries = (recipientId: string) => (pendingDeliveries.get(recipientId)?.length ?? 0) > 0;
	let dispatchPendingDeliveries: (entry: Entry) => void;
	let stopInFlightBelow: (ids: ReadonlyArray<string>) => ReadonlyArray<Promise<unknown>>;
	let terminateWithDescendants: (entry: Entry, outcome: RunOutcome) => void;

	const closeEntryScope = (entry: Entry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

	const isDescendant = (id: string, ancestorId: string) => {
		let current = entries.get(id)?.snapshot.parentId ?? inFlightParents.get(id);
		while (current) {
			if (current === ancestorId) return true;
			current = entries.get(current)?.snapshot.parentId ?? inFlightParents.get(current);
		}
		return false;
	};
	const descendantsOf = (ancestorId: string) => [...entries.values()].filter((entry) => isDescendant(entry.snapshot.id, ancestorId));
	const hasTrackedChild = (id: string) => [...entries.values()].some((entry) => entry.snapshot.parentId === id);
	const hasWaitInterest = (id: string) => [...waitInterest.keys()].some((key) => key.endsWith(`:${id}`));

	const pruneSettled = () => {
		while (entries.size > MAX_TRACKED) {
			const candidate = [...entries.values()]
				.filter(
					(entry) => entry.snapshot.status !== "running" && !hasWaitInterest(entry.snapshot.id) && !hasTrackedChild(entry.snapshot.id),
				)
				.sort((a, b) => (a.snapshot.settledAt ?? a.snapshot.createdAt) - (b.snapshot.settledAt ?? b.snapshot.createdAt))[0];
			if (!candidate) return;
			entries.delete(candidate.snapshot.id);
			const fiber = runDetached(closeEntryScope(candidate));
			cleanups.add(fiber);
			fiber.addObserver(() => cleanups.delete(fiber));
		}
	};

	const settle = (entry: Entry, outcome: RunOutcome) => {
		const s = entry.snapshot;
		if (s.status !== "running") return;
		entry.nativeRunning = false;
		entry.startingTurn = false;
		s.waitingForChildren = false;
		if (outcome._tag !== "Completed") pendingDeliveries.delete(s.id);
		s.settledAt = Date.now();
		switch (outcome._tag) {
			case "Completed":
				s.status = "done";
				s.errorText = undefined;
				s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
				break;
			case "Failed":
				s.status = "error";
				s.errorText = bounded(outcome.errorText);
				// Never let a failed run report the previous run's successful output.
				s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH);
				break;
			case "Interrupted":
				s.status = "error";
				s.errorText = "Run was aborted";
				s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH);
				break;
		}
		s.liveAssistant = undefined;
		entry.liveToolMap.clear();
		s.liveTools = [];
		s.queued = [];
		const recipientId = s.parentId;
		const consumed = (waitInterest.get(interestKey(recipientId, s.id)) ?? 0) > 0;
		notify(s.id);
		if (!disposed && recipientId) {
			const parentEntry = entries.get(recipientId);
			if (!consumed && parentEntry && parentEntry.snapshot.status !== "error" && !parentEntry.cancelling) {
				const pending = pendingDeliveries.get(recipientId) ?? [];
				pending.push({ sourceId: s.id, message: nestedResultMessage(s) });
				pendingDeliveries.set(recipientId, pending);
				if (!parentEntry.nativeRunning && !parentEntry.startingTurn) dispatchPendingDeliveries(parentEntry);
			}
		} else if (!disposed) {
			try {
				onSettled?.(s, consumed);
			} catch {
				// The root Pi session may be unavailable; settlement stays final.
			}
		}
		pruneSettled();
	};

	dispatchPendingDeliveries = (entry) => {
		const s = entry.snapshot;
		const pending = pendingDeliveries.get(s.id);
		if (!pending || pending.length === 0 || entry.nativeRunning || entry.startingTurn || entry.cancelling || s.status === "error") return;
		pendingDeliveries.delete(s.id);
		const restarted = s.status !== "running";
		entry.startingTurn = true;
		s.status = "running";
		s.waitingForChildren = false;
		s.settledAt = undefined;
		if (restarted) onStarted?.(s.id);
		notify(s.id);
		const message = pending.map((delivery) => delivery.message).join("\n\n---\n\n");
		const fiber = runDetached(
			Effect.gen(function* () {
				const delivered = yield* entry.session.send(message).pipe(Effect.result);
				if (Result.isFailure(delivered)) {
					yield* Effect.sync(() => {
						entry.startingTurn = false;
						terminateWithDescendants(entry, {
							_tag: "Failed",
							errorText: "Could not deliver descendant results to orchestrator",
						});
					});
				}
			}),
		);
		entry.deliveryFiber = fiber;
		fiber.addObserver(() => {
			if (entry.deliveryFiber === fiber) entry.deliveryFiber = undefined;
		});
	};

	const foldEvent = (entry: Entry, event: SubagentEvent) => {
		const s = entry.snapshot;
		switch (event._tag) {
			case "RunStarted": {
				const restarted = s.status !== "running";
				entry.nativeRunning = true;
				entry.startingTurn = false;
				if (entry.cancelling) {
					runDetached(entry.session.interrupt.pipe(Effect.ignore));
					break;
				}
				s.status = "running";
				s.waitingForChildren = false;
				s.settledAt = undefined;
				s.errorText = undefined;
				if (restarted) onStarted?.(s.id);
				break;
			}
			case "RunSettled": {
				entry.nativeRunning = false;
				const activeDescendants = descendantsOf(s.id).filter((child) => child.snapshot.status === "running");
				if (event.outcome._tag === "Completed" && s.mode === "orchestrator") {
					s.finalText = event.outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
					if (hasPendingDeliveries(s.id) || activeDescendants.length > 0) {
						s.waitingForChildren = true;
						s.liveAssistant = undefined;
						entry.liveToolMap.clear();
						s.liveTools = [];
						s.queued = [];
						notify(s.id);
						dispatchPendingDeliveries(entry);
						return;
					}
				}
				if (event.outcome._tag !== "Completed") terminateWithDescendants(entry, event.outcome);
				else settle(entry, event.outcome);
				return; // settle() already notified
			}
			case "UserMessage":
				appendTranscript(s, {
					kind: "user",
					text: boundedTranscriptText(event.text),
				});
				break;
			case "AssistantDelta": {
				const live = s.liveAssistant ?? { text: "", thinking: "" };
				s.liveAssistant =
					event.kind === "text"
						? {
								...live,
								text: (live.text + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH),
							}
						: {
								...live,
								thinking: (live.thinking + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH),
							};
				break;
			}
			case "AssistantMessage":
				appendTranscript(s, {
					kind: "assistant",
					parts: event.parts.map((part) =>
						part.type === "toolCall"
							? {
									...part,
									argsPreview: part.argsPreview ? boundedTranscriptText(part.argsPreview) : undefined,
								}
							: { ...part, text: boundedTranscriptText(part.text) },
					),
				});
				s.liveAssistant = undefined;
				s.turns++;
				break;
			case "ToolStart":
				entry.liveToolMap.set(event.toolId, {
					toolId: event.toolId,
					name: event.name,
					argsPreview: event.argsPreview ? boundedTranscriptText(event.argsPreview) : undefined,
				});
				s.liveTools = [...entry.liveToolMap.values()];
				break;
			case "ToolUpdate": {
				const current = entry.liveToolMap.get(event.toolId);
				if (current) {
					entry.liveToolMap.set(event.toolId, {
						...current,
						outputPreview: event.outputPreview ? boundedTranscriptText(event.outputPreview) : current.outputPreview,
					});
					s.liveTools = [...entry.liveToolMap.values()];
				}
				break;
			}
			case "ToolEnd":
				entry.liveToolMap.delete(event.toolId);
				s.liveTools = [...entry.liveToolMap.values()];
				appendTranscript(s, {
					kind: "toolResult",
					toolId: event.toolId,
					name: event.name,
					isError: event.isError,
					outputPreview: event.outputPreview ? boundedTranscriptText(event.outputPreview) : undefined,
				});
				break;
			case "QueueChanged":
				s.queued = event.queued;
				break;
			case "UsageChanged":
				s.usage = {
					tokens: event.tokens ?? s.usage.tokens,
					contextWindow: event.contextWindow ?? s.usage.contextWindow,
				};
				break;
			case "MetaChanged":
				s.meta = { ...s.meta, ...event.meta };
				break;
			case "BackendError":
				s.errorText = bounded(event.message);
				break;
		}
		notify(s.id);
	};

	const requireDescendants = (ownerId: string, ids: ReadonlyArray<string>) => {
		const unique = [...new Set(ids)];
		const denied = unique.filter((id) => !isDescendant(id, ownerId));
		if (denied.length > 0) throw new Error(`Subagent ${denied.join(", ")} is not a descendant of ${ownerId}.`);
		return unique;
	};

	let spawnOwned: (
		backend: BackendName,
		task: SpawnTask,
		parentId?: string,
		options?: SpawnOptions,
	) => Effect.Effect<SubagentSnapshot, SpawnError | BackendUnavailableError>;
	let waitForOwned: (ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void, recipientId?: string) => Effect.Effect<void>;
	let cancelOwned: (ids: ReadonlyArray<string>, recipientId?: string) => Effect.Effect<ReadonlyArray<CancelResult>>;

	const makeController = (ownerId: string, ownerTask: SpawnTask, ready: Promise<void>): OrchestrationController => {
		const execute = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => {
			const operation = new AbortController();
			controllerOperations.set(operation, ownerId);
			const operationSignal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
			const promise = runPromise(effect, { signal: operationSignal });
			controllerPromises.set(promise, ownerId);
			return promise.finally(() => {
				controllerOperations.delete(operation);
				controllerPromises.delete(promise);
			});
		};
		return {
			spawn: async (request: NestedSpawnRequest, signal?: AbortSignal) => {
				await ready;
				const cwd = path.resolve(ownerTask.cwd, request.workingDir ?? ".");
				if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
					throw new Error(`working_dir is not a directory: ${cwd}`);
				}
				return execute(
					spawnOwned(
						request.harness,
						{
							prompt: request.prompt,
							title: request.title.trim().slice(0, 160) || "subagent",
							cwd,
							mode: request.mode,
							model: request.model,
							reasoningEffort: request.reasoningEffort,
							parent: ownerTask.parent,
						},
						ownerId,
					),
					signal,
				);
			},
			wait: async (ids, signal) => {
				await ready;
				const owned = requireDescendants(ownerId, ids);
				await execute(waitForOwned(owned, undefined, ownerId), signal);
				return owned.map((id) => entries.get(id)?.snapshot).filter((snap): snap is MutableSnapshot => snap !== undefined);
			},
			cancel: async (ids, signal) => {
				await ready;
				return execute(cancelOwned(requireDescendants(ownerId, ids), ownerId), signal);
			},
			send: async (id, text, signal) => {
				await ready;
				requireDescendants(ownerId, [id]);
				await execute(send(id, text), signal);
			},
			get: async (id) => {
				await ready;
				return isDescendant(id, ownerId) ? entries.get(id)?.snapshot : undefined;
			},
			list: async () => {
				await ready;
				return descendantsOf(ownerId).map((entry) => entry.snapshot);
			},
		};
	};

	spawnOwned = (requestedBackend, requestedTask, parentId, options) =>
		Effect.gen(function* () {
			const bareModelProviders =
				requestedTask.model && !requestedTask.model.includes("/")
					? requestedTask.parent.modelRegistry
							?.getAll()
							.filter((model) => model.id === requestedTask.model)
							.map((model) => model.provider)
					: undefined;
			const route = resolveRoute({
				harness: requestedBackend,
				model: requestedTask.model,
				inheritedModel: requestedTask.parent.inheritedModel,
				resolvedModel: resolvedModelForRouting(requestedTask),
				bareModelProviders,
				userAllowsPaidOpencode: options?.userAllowsPaidOpencode,
				allowPaidOpencode: options?.allowPaidOpencode,
				paidOpencodeConfigPath: options?.paidOpencodeConfigPath,
				nestedSpawn: parentId !== undefined,
			});
			if ("error" in route) return yield* new SpawnError({ message: route.error });
			const backendName = route.backend;
			const routedTask: SpawnTask = { ...requestedTask, model: route.model };
			const mode = routedTask.mode ?? "worker";
			if (disposed) {
				return yield* new SpawnError({ message: "Subagent manager is shutting down." });
			}
			if (mode === "orchestrator" && backendName !== "claude") {
				return yield* new SpawnError({ message: "Orchestrator mode requires the Claude backend." });
			}
			const parentEntry = parentId ? entries.get(parentId) : undefined;
			if (parentId && !parentEntry) {
				return yield* new SpawnError({ message: `Parent subagent "${parentId}" is no longer tracked.` });
			}
			const depth = (parentEntry?.snapshot.depth ?? -1) + 1;
			if (mode === "orchestrator" && depth > MAX_ORCHESTRATOR_DEPTH) {
				return yield* new SpawnError({ message: `Orchestrator depth cannot exceed ${MAX_ORCHESTRATOR_DEPTH}.` });
			}

			const backend: SubagentBackend | undefined = registry.get(backendName);
			if (!backend) {
				return yield* new BackendUnavailableError({ message: `Unknown backend "${backendName}".` });
			}
			const available = yield* backend.available;
			if (!available) {
				return yield* new BackendUnavailableError({
					message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
				});
			}

			const id = `sa-${++modelCounter}`;
			inFlightParents.set(id, parentId);
			let markReady: (() => void) | undefined;
			const ready = new Promise<void>((resolve) => {
				markReady = resolve;
			});
			const task: SpawnTask = {
				...routedTask,
				mode,
				orchestration: mode === "orchestrator" ? makeController(id, routedTask, ready) : undefined,
			};
			const scope = yield* Scope.make();
			const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
				Effect.onError(() =>
					Effect.sync(() => {
						inFlightParents.delete(id);
						cancelledSpawns.delete(id);
					}).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
				),
			);
			inFlightParents.delete(id);
			const parentUnavailable = parentEntry && (parentEntry.snapshot.status === "error" || parentEntry.cancelling);
			if (disposed || cancelledSpawns.delete(id) || parentUnavailable) {
				yield* Scope.close(scope, Exit.void);
				return yield* new SpawnError({
					message: disposed ? "Subagent manager shut down while spawning." : `Parent subagent "${parentId}" stopped while spawning.`,
				});
			}

			const meta = yield* session.meta;
			const entry: Entry = {
				snapshot: {
					id,
					parentId,
					depth,
					mode,
					backend: backendName,
					title: task.title,
					prompt: task.prompt,
					cwd: task.cwd,
					status: "running",
					waitingForChildren: false,
					createdAt: Date.now(),
					meta,
					usage: { contextWindow: meta.contextWindow },
					transcript: [],
					liveTools: [],
					queued: [],
					finalText: "",
					turns: 0,
				},
				session,
				nativeRunning: true,
				startingTurn: false,
				cancelling: false,
				terminating: false,
				scope,
				liveToolMap: new Map(),
			};
			entries.set(id, entry);

			const pump = Stream.runForEach(session.events, (event) => Effect.sync(() => foldEvent(entry, event))).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						if (entry.snapshot.status === "running") {
							terminateWithDescendants(entry, { _tag: "Failed", errorText: "Backend event stream ended unexpectedly" });
						}
					}),
				),
			);
			entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
			markReady?.();
			notify(id);
			return entry.snapshot as SubagentSnapshot;
		});

	const spawn = (requestedBackend: BackendName, requestedTask: SpawnTask, options?: SpawnOptions) =>
		spawnOwned(requestedBackend, requestedTask, undefined, options);

	waitForOwned = (ids, onPending, recipientId) =>
		Effect.suspend(() => {
			const unique = [...new Set(ids)];
			if (recipientId) claimPendingDeliveries(recipientId, unique);
			addInterest(unique, recipientId);
			const loop = Effect.gen(function* () {
				while (true) {
					const pending = unique.filter((id) => entries.get(id)?.snapshot.status === "running");
					if (pending.length === 0) return;
					onPending?.(pending);
					yield* nextChange;
				}
			});
			return loop.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						releaseInterest(unique, recipientId);
						pruneSettled();
					}),
				),
			);
		});
	const waitFor = (ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void) => waitForOwned(ids, onPending);

	/** Interrupt one running entry, force-closing its scope after 5s. */
	const abortEntry = (entry: Entry) =>
		Effect.gen(function* () {
			if (entry.snapshot.status !== "running") return;
			entry.cancelling = true;
			if (entry.deliveryFiber) {
				const deliveryFiber = entry.deliveryFiber;
				entry.deliveryFiber = undefined;
				yield* Fiber.interrupt(deliveryFiber);
				entry.startingTurn = false;
				settle(entry, { _tag: "Interrupted" });
				return;
			}
			if (!entry.nativeRunning && !entry.startingTurn) {
				settle(entry, { _tag: "Interrupted" });
				return;
			}
			const graceful = yield* entry.session.interrupt.pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.result);
			if (Result.isFailure(graceful)) {
				// Settle before closing the scope so the pump's stream-ended
				// fallback ("Backend event stream ended unexpectedly") cannot win
				// the race and report the wrong terminal reason.
				yield* Effect.sync(() => {
					settle(entry, { _tag: "Interrupted" });
					entry.snapshot.errorText = "Abort deadline exceeded; session was force-disposed";
					notify(entry.snapshot.id);
				});
				// Bound the close like disposeAll does: a stuck backend finalizer
				// must not hang cancel after the run is already settled.
				yield* closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
			}
		});

	stopInFlightBelow = (ids) => {
		for (const [id] of inFlightParents) {
			if (ids.some((target) => id === target || isDescendant(id, target))) cancelledSpawns.add(id);
		}
		for (const [operation, ownerId] of controllerOperations) {
			if (ids.some((target) => ownerId === target || isDescendant(ownerId, target))) operation.abort();
		}
		return [...controllerPromises]
			.filter(([, ownerId]) => ids.some((target) => ownerId === target || isDescendant(ownerId, target)))
			.map(([promise]) => promise);
	};

	cancelOwned = (ids, recipientId) =>
		Effect.suspend(() => {
			const unique = [...new Set(ids)];
			const operations = stopInFlightBelow(unique);
			const requestedRunningIds = unique.filter((id) => entries.get(id)?.snapshot.status === "running");
			const subtree = [...entries.values()].filter(
				(entry) =>
					entry.snapshot.status === "running" && unique.some((id) => entry.snapshot.id === id || isDescendant(entry.snapshot.id, id)),
			);
			for (const entry of subtree) {
				entry.cancelling = true;
				pendingDeliveries.delete(entry.snapshot.id);
			}
			addInterest(requestedRunningIds, recipientId);
			const work = Effect.gen(function* () {
				yield* Effect.promise(() => Promise.allSettled(operations)).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
				yield* Effect.forEach(subtree, abortEntry, { concurrency: "unbounded" });
				while (subtree.some((entry) => entry.snapshot.status === "running")) yield* nextChange;
			});
			return work.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						releaseInterest(requestedRunningIds, recipientId);
						pruneSettled();
					}),
				),
				Effect.map(
					(): ReadonlyArray<CancelResult> =>
						unique.map((id) => {
							const snapshot = entries.get(id)?.snapshot;
							return {
								id,
								title: snapshot?.title ?? "?",
								status: snapshot?.status ?? "error",
								cancelled: requestedRunningIds.includes(id),
							};
						}),
				),
			);
		});
	const cancel = (ids: ReadonlyArray<string>) => cancelOwned(ids);

	terminateWithDescendants = (entry, outcome) => {
		const s = entry.snapshot;
		if (s.status !== "running" || entry.terminating) return;
		const activeDescendants = descendantsOf(s.id).filter((child) => child.snapshot.status === "running");
		const hasInFlightDescendants = [...inFlightParents.keys()].some((id) => isDescendant(id, s.id));
		if (entry.cancelling || (activeDescendants.length === 0 && !hasInFlightDescendants)) {
			settle(entry, outcome);
			return;
		}
		entry.terminating = true;
		entry.cancelling = true;
		s.waitingForChildren = true;
		pendingDeliveries.delete(s.id);
		const operations = stopInFlightBelow([s.id]);
		const directChildren = activeDescendants.filter((child) => child.snapshot.parentId === s.id).map((child) => child.snapshot.id);
		runDetached(
			Effect.gen(function* () {
				yield* Effect.promise(() => Promise.allSettled(operations)).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
				yield* cancelOwned(directChildren, s.id);
				yield* Effect.sync(() => settle(entry, outcome));
			}).pipe(Effect.ignore),
		);
		notify(s.id);
	};

	const send = (id: string, text: string) =>
		Effect.suspend((): Effect.Effect<void, SendError> => {
			const entry = entries.get(id);
			if (!entry || disposed) {
				return new SendError({ message: `Subagent "${id}" is no longer tracked.` });
			}
			if (entry.cancelling && entry.snapshot.status === "running") {
				return new SendError({ message: `Subagent "${id}" is being cancelled.` });
			}
			if (entry.snapshot.status !== "running") {
				if (entry.snapshot.parentId) claimPendingDeliveries(entry.snapshot.parentId, [id]);
				pendingDeliveries.delete(id);
				entry.cancelling = false;
				entry.terminating = false;
			}
			return entry.session.send(text);
		});

	const disposeAll = Effect.gen(function* () {
		disposed = true;
		for (const operation of controllerOperations.keys()) operation.abort();
		yield* Effect.promise(() => Promise.allSettled(controllerPromises.keys())).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
		const all = [...entries.values()];
		yield* Effect.forEach(all, (entry) => (entry.deliveryFiber ? Fiber.interrupt(entry.deliveryFiber) : Effect.void), {
			concurrency: "unbounded",
		}).pipe(Effect.ignore);
		entries.clear();
		pendingDeliveries.clear();
		inFlightParents.clear();
		cancelledSpawns.clear();
		yield* Effect.forEach(all, (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore), {
			concurrency: "unbounded",
		});
		// Pruning cleanups are detached; bound them like everything else so a
		// stuck backend finalizer cannot block runtime shutdown indefinitely.
		yield* Effect.forEach([...cleanups], (fiber) => Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore), {
			concurrency: "unbounded",
		}).pipe(Effect.ignore);
		yield* Effect.sync(() => notify());
	});

	const view: SubagentReadModel = {
		list: () => [...entries.values()].map((entry) => entry.snapshot),
		get: (id) => entries.get(id)?.snapshot,
		size: () => entries.size,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		subscribeTo: (id, listener) => {
			let set = idListeners.get(id);
			if (!set) {
				set = new Set();
				idListeners.set(id, set);
			}
			set.add(listener);
			return () => {
				set.delete(listener);
				if (set.size === 0) idListeners.delete(id);
			};
		},
		requestSend: (id, text) => {
			runDetached(send(id, text).pipe(Effect.ignore));
		},
		requestAbort: (id) => {
			if (!entries.has(id)) return;
			// A distinct recipient keeps UI cancellation unconsumed, so the failed
			// root/child result still reaches its normal parent after the subtree stops.
			runDetached(cancelOwned([id], "ui").pipe(Effect.ignore));
		},
		setOnSettled: (hook) => {
			onSettled = hook;
		},
		setOnStarted: (hook) => {
			onStarted = hook;
		},
	};

	// Safety net: disposing the ManagedRuntime tears everything down even if
	// the extension forgot to call disposeAll explicitly.
	yield* Effect.addFinalizer(() => disposeAll);

	return SubagentManager.of({
		spawn,
		waitFor,
		cancel,
		send,
		get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
		list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
		disposeAll,
		view,
	});
});

export const SubagentManagerLive: Layer.Layer<SubagentManager, never, BackendRegistry> = Layer.effect(SubagentManager, makeManager);
