/**
 * Domain model for subagents.
 *
 * Everything downstream of a backend (manager, tools, UI) speaks only these
 * types. Backends translate Pi session events and Claude Agent SDK messages
 * into the normalized `SubagentEvent` union.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";

export const BACKEND_NAMES = ["pi", "claude"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export const SUBAGENT_MODES = ["worker", "orchestrator"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

/**
 * Shared reasoning-effort scale (Pi's thinking levels). Pi uses it directly
 * and Claude translates it to a thinking budget. Omitted means backend
 * default; Pi inherits the parent level.
 */
export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "error";

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
	readonly parentCwd: string;
	/** Parent pi model, for the pi backend's "inherit" default. */
	readonly inheritedModel?: { readonly provider: string; readonly id: string };
	readonly inheritedThinkingLevel?: string;
	/** Parent model registry; required by the pi backend to resolve models. */
	readonly modelRegistry?: ModelRegistry;
}

export interface NestedSpawnRequest {
	readonly prompt: string;
	readonly title: string;
	readonly harness: BackendName;
	readonly workingDir?: string;
	readonly model?: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly mode?: SubagentMode;
}

export interface NestedCancelResult {
	readonly id: string;
	readonly title: string;
	readonly status: SubagentStatus;
	readonly cancelled: boolean;
}

/** Host controls bound to one orchestrator's descendant tree. */
export interface OrchestrationController {
	spawn(request: NestedSpawnRequest, signal?: AbortSignal): Promise<SubagentSnapshot>;
	wait(ids: ReadonlyArray<string>, signal?: AbortSignal): Promise<ReadonlyArray<SubagentSnapshot>>;
	cancel(ids: ReadonlyArray<string>, signal?: AbortSignal): Promise<ReadonlyArray<NestedCancelResult>>;
	send(id: string, text: string, signal?: AbortSignal): Promise<void>;
	get(id: string): Promise<SubagentSnapshot | undefined>;
	list(): Promise<ReadonlyArray<SubagentSnapshot>>;
}

export interface SpawnTask {
	readonly prompt: string;
	readonly title: string;
	readonly cwd: string;
	readonly mode?: SubagentMode;
	/**
	 * Generic model hint, interpreted per backend:
	 * pi: "provider/model-id" or bare model id; claude: model alias.
	 * Omitted = backend default / inherit.
	 */
	readonly model?: string;
	/** Shared effort scale; each backend maps it to its native equivalent. */
	readonly reasoningEffort?: ReasoningEffort;
	readonly parent: ParentContext;
	/** Manager-injected controls; only present for orchestrated Claude sessions. */
	readonly orchestration?: OrchestrationController;
}

export interface SubagentMeta {
	readonly backend: BackendName;
	/** Display label, e.g. "openai-codex/gpt-5.6-sol" or "claude-opus-4-6". */
	readonly modelLabel?: string;
	/** Context window capacity for utilization display, when known. */
	readonly contextWindow?: number;
	/** Pi session file or Claude projects JSONL. */
	readonly sessionFilePath?: string;
	/** Claude session id. */
	readonly nativeSessionId?: string;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "thinking";
			readonly text: string;
			readonly redacted?: boolean;
	  }
	| {
			readonly type: "toolCall";
			readonly toolId: string;
			readonly name: string;
			readonly argsPreview?: string;
	  };

export type TranscriptItem =
	| { readonly kind: "user"; readonly text: string }
	| {
			readonly kind: "assistant";
			readonly parts: ReadonlyArray<TranscriptPart>;
	  }
	| {
			readonly kind: "toolResult";
			readonly toolId: string;
			readonly name: string;
			readonly isError: boolean;
			readonly outputPreview?: string;
	  };

export interface LiveToolState {
	readonly toolId: string;
	readonly name: string;
	readonly argsPreview?: string;
	readonly outputPreview?: string;
	readonly done?: boolean;
	readonly isError?: boolean;
}

export interface QueuedMessage {
	readonly text: string;
	readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
	| { readonly _tag: "Completed"; readonly finalText: string }
	| {
			readonly _tag: "Failed";
			readonly errorText: string;
			readonly partialText?: string;
	  }
	| { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
	// lifecycle (a session can run multiple turns via send())
	| { readonly _tag: "RunStarted" }
	| { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
	// transcript building blocks
	| { readonly _tag: "UserMessage"; readonly text: string }
	| {
			readonly _tag: "AssistantDelta";
			readonly kind: "text" | "thinking";
			readonly delta: string;
	  }
	| {
			readonly _tag: "AssistantMessage";
			readonly parts: ReadonlyArray<TranscriptPart>;
	  }
	| {
			readonly _tag: "ToolStart";
			readonly toolId: string;
			readonly name: string;
			readonly argsPreview?: string;
	  }
	| {
			readonly _tag: "ToolUpdate";
			readonly toolId: string;
			readonly outputPreview?: string;
	  }
	| {
			readonly _tag: "ToolEnd";
			readonly toolId: string;
			readonly name: string;
			readonly isError: boolean;
			readonly outputPreview?: string;
	  }
	// bookkeeping
	| {
			readonly _tag: "QueueChanged";
			readonly queued: ReadonlyArray<QueuedMessage>;
	  }
	| {
			readonly _tag: "UsageChanged";
			readonly tokens?: number;
			readonly contextWindow?: number;
	  }
	| { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
	/** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
	| { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
	readonly id: string;
	readonly parentId?: string;
	readonly depth: number;
	readonly mode: SubagentMode;
	readonly backend: BackendName;
	readonly title: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly status: SubagentStatus;
	/** The native turn is idle while active descendants are still returning. */
	readonly waitingForChildren: boolean;
	readonly createdAt: number;
	readonly settledAt?: number;
	readonly errorText?: string;
	readonly meta: SubagentMeta;
	readonly usage: { readonly tokens?: number; readonly contextWindow?: number };
	readonly transcript: ReadonlyArray<TranscriptItem>;
	/** Streaming assistant buffers, cleared when the finalized message lands. */
	readonly liveAssistant?: { readonly text: string; readonly thinking: string };
	readonly liveTools: ReadonlyArray<LiveToolState>;
	readonly queued: ReadonlyArray<QueuedMessage>;
	/** Final text of the most recent completed run (v1 `finalOutput`). */
	readonly finalText: string;
	/** Count of finalized assistant messages (for subagent_check). */
	readonly turns: number;
}

/** Parent-first tree order while preserving spawn order between siblings. */
export function orderSubagentTree<T extends Pick<SubagentSnapshot, "id" | "parentId">>(snapshots: ReadonlyArray<T>) {
	const children = new Map<string | undefined, T[]>();
	for (const snap of snapshots) {
		const siblings = children.get(snap.parentId) ?? [];
		siblings.push(snap);
		children.set(snap.parentId, siblings);
	}
	const ids = new Set(snapshots.map((snap) => snap.id));
	const seen = new Set<string>();
	const ordered: T[] = [];
	const visit = (snap: T) => {
		if (seen.has(snap.id)) return;
		seen.add(snap.id);
		ordered.push(snap);
		for (const child of children.get(snap.id) ?? []) visit(child);
	};
	for (const root of snapshots.filter((snap) => !snap.parentId || !ids.has(snap.parentId))) visit(root);
	for (const snap of snapshots) visit(snap);
	return ordered;
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
	const live = snap.liveAssistant?.text.trim();
	if (live) return live;
	return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
	const end = snap.settledAt ?? Date.now();
	const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
	readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError("BackendUnavailableError")<{
	readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
	readonly message: string;
}> {}
