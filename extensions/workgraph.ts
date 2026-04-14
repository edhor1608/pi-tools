import { basename } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	WORKGRAPH_EXECUTION_MODES,
	WORKGRAPH_ITEM_KINDS,
	WORKGRAPH_STATE_ENTRY_TYPE,
	WORKGRAPH_STATUSES,
	areDependenciesResolved,
	bootstrapWorkgraph,
	clearResolvedWorkgraphItems,
	cloneWorkgraphState,
	createWorkgraphItem,
	emptyWorkgraphState,
	findWorkgraphItem,
	getCurrentFocusItem,
	isResolvedStatus,
	moveWorkgraphItem,
	normalizeText,
	readWorkgraphStateFromBranch,
	setWorkgraphItemDependencies,
	setWorkgraphItemExecution,
	setWorkgraphItemKind,
	setWorkgraphItemStatus,
	summarizeText,
	type WorkgraphExecutionMode,
	type WorkgraphItem,
	type WorkgraphItemKind,
	type WorkgraphMutationSource,
	type WorkgraphState,
	type WorkgraphStatus,
} from "./shared/workgraph-state.ts";

const TOOL_NAME = "workgraph";
const STATUS_KEY = "workgraph";
const WIDGET_KEY = "workgraph";
const SNAPSHOT_MESSAGE_TYPE = "workgraph-snapshot";
const MAX_WIDGET_PENDING = 4;
const MAX_SUMMARY_PER_BUCKET = 6;
const MOVE_DIRECTIONS = ["up", "down"] as const;
const TOOL_ACTIONS = [
	"list",
	"bootstrap",
	"add",
	"edit",
	"set_status",
	"set_active",
	"set_dependencies",
	"set_execution",
	"set_kind",
	"move",
	"clear_resolved",
] as const;

type WorkgraphMoveDirection = (typeof MOVE_DIRECTIONS)[number];
type WorkgraphToolAction = (typeof TOOL_ACTIONS)[number];

interface WorkgraphToolDetails {
	action: WorkgraphToolAction;
	message: string;
	state: WorkgraphState;
}

interface WorkgraphSnapshotMessageDetails {
	preview: string;
	timestamp: number;
}

const WorkgraphParams = Type.Object({
	action: StringEnum(TOOL_ACTIONS),
	text: Type.Optional(Type.String({ description: "Item text for add/edit" })),
	id: Type.Optional(Type.Number({ description: "Item id for edit/status/dependency/move" })),
	status: Type.Optional(StringEnum(WORKGRAPH_STATUSES)),
	blockedReason: Type.Optional(Type.String({ description: "Blocked reason when status is blocked" })),
	dependTo: Type.Optional(Type.Array(Type.Number(), { description: "Dependency ids" })),
	direction: Type.Optional(StringEnum(MOVE_DIRECTIONS)),
	activeText: Type.Optional(Type.String({ description: "Current active issue when bootstrapping a graph" })),
	pendingTexts: Type.Optional(Type.Array(Type.String(), { description: "Pending later issues when bootstrapping a graph" })),
	execution: Type.Optional(StringEnum(WORKGRAPH_EXECUTION_MODES)),
	kind: Type.Optional(StringEnum(WORKGRAPH_ITEM_KINDS)),
});

const extractTaskLikeLine = (value: string): string | undefined => {
	const lines = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("<"))
		.filter((line) => !line.startsWith("@"))
		.filter((line) => !line.startsWith("/"));
	const candidate = lines.find((line) => /[A-Za-z]/.test(line));
	if (!candidate) return undefined;
	const normalized = normalizeText(candidate);
	if (normalized.startsWith("<")) return undefined;
	if (normalized.startsWith("file ")) return undefined;
	return normalized;
};

const extractTextFromMessage = (message: AgentMessage): string => {
	switch (message.role) {
		case "user": {
			if (typeof message.content === "string") return normalizeText(message.content);
			return normalizeText(
				message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		}
		case "assistant": {
			return normalizeText(
				message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		}
		case "compactionSummary":
		case "branchSummary":
			return normalizeText(message.summary);
		case "custom": {
			if (typeof message.content === "string") return normalizeText(message.content);
			return normalizeText(
				message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		}
		default:
			return "";
	}
};

const inferCurrentIssue = (ctx: ExtensionContext): string | undefined => {
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName && normalizeText(sessionName).length > 0) return summarizeText(sessionName, 120);
	const branch = ctx.sessionManager.getBranch();
	for (const entry of [...branch].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractTextFromMessage(entry.message);
		const candidate = extractTaskLikeLine(text);
		if (candidate) return summarizeText(candidate, 120);
	}
	return undefined;
};

const maybeBootstrapFocusFromContext = (state: WorkgraphState, ctx: ExtensionContext): WorkgraphItem | undefined => {
	if (getCurrentFocusItem(state)) return undefined;
	const inferred = inferCurrentIssue(ctx);
	if (!inferred) return undefined;
	const normalized = inferred.toLowerCase();
	if (state.items.some((item) => normalizeText(item.text).toLowerCase() === normalized)) return undefined;
	return createWorkgraphItem(state, inferred, "active", "system");
};

const ensureHybridAdd = (
	state: WorkgraphState,
	ctx: ExtensionContext | undefined,
	text: string,
	source: WorkgraphMutationSource,
	execution: WorkgraphExecutionMode,
	kind: WorkgraphItemKind,
): { item: WorkgraphItem; bootstrapped?: WorkgraphItem } => {
	const bootstrapped = ctx ? maybeBootstrapFocusFromContext(state, ctx) : undefined;
	const item = createWorkgraphItem(state, text, "pending", source, { execution, kind });
	return { item, bootstrapped };
};

const formatDependTo = (dependTo: number[]): string =>
	dependTo.length === 0 ? "" : ` depends on ${dependTo.map((id) => `#${id}`).join(", ")}`;

const formatItemLabel = (item: WorkgraphItem): string => {
	const tags: string[] = [];
	if (item.kind === "merge") tags.push("merge");
	if (item.execution === "parallel") tags.push("parallel");
	if (item.preparedAt && item.worktreePath) tags.push(`prepared:${basename(item.worktreePath)}`);
	const prefix = tags.length > 0 ? `[${tags.join(",")}] ` : "";
	const blocked = item.status === "blocked" && item.blockedReason ? ` [${summarizeText(item.blockedReason, 48)}]` : "";
	return `#${item.id} ${prefix}${summarizeText(item.text)}${blocked}${formatDependTo(item.dependTo)}`;
};

const statusEmoji = (status: WorkgraphStatus): string =>
	status === "active"
		? "→"
		: status === "pending"
			? "○"
			: status === "blocked"
				? "!"
				: status === "done"
					? "✓"
					: "×";

const summarizeItemsByStatus = (state: WorkgraphState, status: WorkgraphStatus): string[] =>
	state.items
		.filter((item) => item.status === status)
		.slice(0, MAX_SUMMARY_PER_BUCKET)
		.map((item) => `- ${formatItemLabel(item)}`);

const buildPromptAppend = (state: WorkgraphState): string => {
	const lines = [
		"## Workgraph",
		`A sparse issue-style workgraph is available through the ${TOOL_NAME} tool.`,
		"Use it for non-trivial multi-step work, blocked work, or when later work/ideas need to be parked outside the chat flow.",
		"Do not use it for trivial one-step work or when there is only one obvious task.",
		"Prefer one broad active issue. It is fine for that issue to stay active for a long time while real work happens under it.",
		"Do not decompose one small feature into inspect/implement/test/docs items. Keep the graph sparse and issue-like.",
		"Use pending items mainly to park genuinely separate later issues or ideas, not to mirror every implementation step.",
		"When you first introduce a multi-item graph, prefer bootstrap over a long series of add calls.",
		"If a later issue appears while current work is unresolved, add it as pending instead of assuming it should run next.",
		"If you are blocked by a user decision, question, or investigation, keep the current item blocked instead of marking it done.",
		"Use dependTo when an item must wait for other items to finish before it can become active.",
		"Use execution=parallel only for genuinely independent work that can be prepared in a separate git worktree.",
		"Represent merges as explicit kind=merge items that depend on the branches they combine.",
	];
	if (state.items.length === 0) return lines.join("\n");
	const active = summarizeItemsByStatus(state, "active");
	const blocked = summarizeItemsByStatus(state, "blocked");
	const pending = summarizeItemsByStatus(state, "pending");
	const doneCount = state.items.filter((item) => item.status === "done").length;
	const cancelledCount = state.items.filter((item) => item.status === "cancelled").length;
	lines.push("", "Current workgraph state:");
	if (active.length > 0) lines.push("Active:", ...active);
	if (blocked.length > 0) lines.push("Blocked:", ...blocked);
	if (pending.length > 0) lines.push("Pending:", ...pending);
	if (doneCount > 0 || cancelledCount > 0) {
		lines.push(`Resolved: ${doneCount} done, ${cancelledCount} cancelled.`);
	}
	return lines.join("\n");
};

const buildSnapshotText = (state: WorkgraphState): string => {
	if (state.items.length === 0) return "Workgraph\n- no workgraph items";
	const lines = ["Workgraph"];
	for (const status of WORKGRAPH_STATUSES) {
		const items = state.items.filter((item) => item.status === status);
		if (items.length === 0) continue;
		lines.push(`${status[0].toUpperCase()}${status.slice(1)}:`);
		for (const item of items) {
			lines.push(`- ${formatItemLabel(item)}`);
		}
	}
	return lines.join("\n");
};

const buildSnapshotPreview = (state: WorkgraphState): string => {
	if (state.items.length === 0) return "- no workgraph items";
	const counts = WORKGRAPH_STATUSES.map((status) => `${status}: ${state.items.filter((item) => item.status === status).length}`)
		.filter((part) => !part.endsWith(": 0"));
	const parallelCount = state.items.filter((item) => item.execution === "parallel").length;
	if (parallelCount > 0) counts.push(`parallel: ${parallelCount}`);
	return counts.map((part) => `- ${part}`).join("\n");
};

const buildStatusLine = (ctx: ExtensionContext, state: WorkgraphState): string | undefined => {
	if (state.items.length === 0) return undefined;
	const theme = ctx.ui.theme;
	const counts = {
		active: state.items.filter((item) => item.status === "active").length,
		pending: state.items.filter((item) => item.status === "pending").length,
		blocked: state.items.filter((item) => item.status === "blocked").length,
		parallel: state.items.filter((item) => item.execution === "parallel").length,
	};
	const parts = [theme.fg("accent", "graph")];
	if (counts.active) parts.push(theme.fg("success", `A${counts.active}`));
	if (counts.blocked) parts.push(theme.fg("error", `B${counts.blocked}`));
	if (counts.pending) parts.push(theme.fg("warning", `P${counts.pending}`));
	if (counts.parallel) parts.push(theme.fg("accent", `∥${counts.parallel}`));
	return parts.join(" ");
};

const buildWidgetLines = (ctx: ExtensionContext, state: WorkgraphState): string[] | undefined => {
	if (state.items.length === 0) return undefined;
	const theme = ctx.ui.theme;
	const lines = [theme.fg("accent", theme.bold("Workgraph"))];
	const focus = getCurrentFocusItem(state);
	if (focus) {
		const color = focus.status === "blocked" ? "error" : "success";
		lines.push(`${theme.fg(color, statusEmoji(focus.status))} ${formatItemLabel(focus)}`);
	}
	const pending = state.items.filter((item) => item.status === "pending");
	for (const item of pending.slice(0, MAX_WIDGET_PENDING)) {
		lines.push(`${theme.fg("warning", statusEmoji(item.status))} ${formatItemLabel(item)}`);
	}
	if (pending.length > MAX_WIDGET_PENDING) {
		lines.push(theme.fg("dim", `… ${pending.length - MAX_WIDGET_PENDING} more pending`));
	}
	return lines;
};

const updateUi = (ctx: ExtensionContext, state: WorkgraphState) => {
	ctx.ui.setStatus(STATUS_KEY, buildStatusLine(ctx, state));
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, state));
};

const clearUi = (ctx: ExtensionContext) => {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
};

const sendSnapshotMessage = (pi: ExtensionAPI, state: WorkgraphState) => {
	pi.sendMessage({
		customType: SNAPSHOT_MESSAGE_TYPE,
		content: buildSnapshotText(state),
		display: true,
		details: {
			preview: buildSnapshotPreview(state),
			timestamp: Date.now(),
		} satisfies WorkgraphSnapshotMessageDetails,
	});
};

const parseDependencyInput = (value: string): number[] =>
	[...new Set(value.split(/[\s,]+/).map((part) => Number(part)).filter((id) => Number.isInteger(id) && id > 0))];

function workgraphExtension(pi: ExtensionAPI) {
	let state = emptyWorkgraphState();
	let mutationQueue: Promise<unknown> = Promise.resolve();

	const persistState = () => {
		pi.appendEntry(WORKGRAPH_STATE_ENTRY_TYPE, cloneWorkgraphState(state));
	};

	const reconstructState = (ctx: ExtensionContext) => {
		state = readWorkgraphStateFromBranch(ctx.sessionManager.getBranch());
		updateUi(ctx, state);
	};

	const resetRuntimeState = (ctx: ExtensionContext) => {
		state = emptyWorkgraphState();
		clearUi(ctx);
	};

	const runSerialized = async <T>(operation: () => Promise<T> | T): Promise<T> => {
		const next = mutationQueue.then(operation);
		mutationQueue = next.then(() => undefined, () => undefined);
		return next;
	};

	const mutateState = async <T>(ctx: ExtensionContext | undefined, operation: (draft: WorkgraphState) => T): Promise<T> =>
		runSerialized(async () => {
			const draft = cloneWorkgraphState(state);
			const result = operation(draft);
			state = draft;
			persistState();
			if (ctx) updateUi(ctx, state);
			return result;
		});

	const workgraphPromptAppend = (): string => buildPromptAppend(state);

	const showItemPicker = async (ctx: ExtensionCommandContext): Promise<string | null> => {
		const items: SelectItem[] = [
			{ value: "add-local", label: "+ Add local item", description: "Add a parked local work item" },
			{ value: "add-parallel", label: "+ Add parallel item", description: "Add a parked item that can later run in a worktree" },
			{ value: "add-merge", label: "+ Add merge item", description: "Add an explicit merge item" },
		];
		for (const item of state.items) {
			items.push({
				value: `item:${item.id}`,
				label: `${statusEmoji(item.status)} ${formatItemLabel(item)}`,
				description: item.status,
			});
		}
		if (state.items.some((item) => isResolvedStatus(item.status))) {
			items.push({ value: "clear", label: "Clear resolved items", description: "Remove done and cancelled items" });
		}
		items.push({ value: "close", label: "Close", description: "Exit workgraph editor" });

		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Workgraph")), 1, 0));
			container.addChild(new Text(theme.fg("dim", buildSnapshotPreview(state)), 1, 0));
			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	const showItemActions = async (ctx: ExtensionCommandContext, item: WorkgraphItem): Promise<string | undefined> => {
		const options = [
			"Edit text",
			"Mark active",
			"Mark pending",
			"Mark blocked",
			"Mark done",
			"Mark cancelled",
			"Set local execution",
			"Set parallel execution",
			"Set work item",
			"Set merge item",
			"Edit dependencies",
			"Move up",
			"Move down",
			"Back",
		];
		return ctx.ui.select(`Item #${item.id}`, options);
	};

	const promptForItemText = async (ctx: ExtensionCommandContext, title: string): Promise<string | undefined> => {
		const text = await ctx.ui.editor(title, "");
		if (!text || !normalizeText(text)) return undefined;
		return text;
	};

	const openGraphUi = async (ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) {
			sendSnapshotMessage(pi, state);
			return;
		}
		while (true) {
			const picked = await showItemPicker(ctx);
			if (!picked || picked === "close") return;
			if (picked === "add-local" || picked === "add-parallel" || picked === "add-merge") {
				const text = await promptForItemText(
					ctx,
					picked === "add-merge"
						? "Add merge item"
						: picked === "add-parallel"
							? "Add parallel item"
							: "Add local item",
				);
				if (!text) continue;
				await mutateState(ctx, (draft) => {
					ensureHybridAdd(
						draft,
						ctx,
						text,
						"user",
						picked === "add-parallel" ? "parallel" : "local",
						picked === "add-merge" ? "merge" : "work",
					);
				});
				continue;
			}
			if (picked === "clear") {
				await mutateState(ctx, (draft) => {
					clearResolvedWorkgraphItems(draft);
				});
				continue;
			}
			if (!picked.startsWith("item:")) continue;
			const id = Number(picked.slice(5));
			const item = findWorkgraphItem(state, id);
			if (!item) continue;
			const action = await showItemActions(ctx, item);
			if (!action || action === "Back") continue;
			if (action === "Edit text") {
				const text = await ctx.ui.editor(`Edit item #${id}`, item.text);
				if (!text || !normalizeText(text)) continue;
				await mutateState(ctx, (draft) => {
					const target = findWorkgraphItem(draft, id);
					if (!target) throw new Error(`Item #${id} not found`);
					target.text = normalizeText(text);
					target.updatedAt = Date.now();
					delete target.workerPrompt;
				});
				continue;
			}
			if (action === "Mark blocked") {
				const reason = await ctx.ui.editor(`Blocked reason for #${id}`, item.blockedReason || "");
				if (reason === undefined) continue;
				await mutateState(ctx, (draft) => {
					setWorkgraphItemStatus(draft, id, "blocked", reason || "Blocked");
				});
				continue;
			}
			if (action === "Edit dependencies") {
				const next = await ctx.ui.input(`Dependencies for #${id}`, item.dependTo.join(", "));
				if (next === undefined) continue;
				await mutateState(ctx, (draft) => {
					setWorkgraphItemDependencies(draft, id, parseDependencyInput(next));
				});
				continue;
			}
			await mutateState(ctx, (draft) => {
				if (action === "Mark active") setWorkgraphItemStatus(draft, id, "active");
				else if (action === "Mark pending") setWorkgraphItemStatus(draft, id, "pending");
				else if (action === "Mark done") setWorkgraphItemStatus(draft, id, "done");
				else if (action === "Mark cancelled") setWorkgraphItemStatus(draft, id, "cancelled");
				else if (action === "Set local execution") setWorkgraphItemExecution(draft, id, "local");
				else if (action === "Set parallel execution") setWorkgraphItemExecution(draft, id, "parallel");
				else if (action === "Set work item") setWorkgraphItemKind(draft, id, "work");
				else if (action === "Set merge item") setWorkgraphItemKind(draft, id, "merge");
				else if (action === "Move up") moveWorkgraphItem(draft, id, "up");
				else if (action === "Move down") moveWorkgraphItem(draft, id, "down");
			});
		}
	};

	const handleGraphCommand = async (_args: string, ctx: ExtensionCommandContext) => {
		await openGraphUi(ctx);
	};

	pi.registerMessageRenderer(SNAPSHOT_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as WorkgraphSnapshotMessageDetails | undefined;
		const box = new Container();
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		box.addChild(new Text(theme.fg("accent", theme.bold("Workgraph")), 1, 0));
		box.addChild(new Text(options.expanded ? String(message.content) : details?.preview ?? String(message.content), 1, 0));
		box.addChild(new Text(theme.fg("dim", options.expanded ? "Live snapshot" : "Expand for full graph state"), 1, 0));
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return box;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Workgraph",
		description:
			"Manage a sparse issue-style workgraph for non-trivial multi-step work. Use it to park later work, track dependencies, and mark items as local or parallel.",
		promptSnippet: "Manage the sparse workgraph for multi-step, blocked, or parked-later work.",
		promptGuidelines: [
			"Use the workgraph only for non-trivial multi-step work, blocked work, or later issues that need to be parked.",
			"Keep the graph sparse. Prefer one broad active issue and a few parked later issues instead of implementation-step subtasks.",
			"If another issue appears for later, add it as pending instead of assuming it should run next.",
			"If blocked on user input, a decision, an error, or investigation, keep the current item blocked instead of marking it done.",
			"Use execution=parallel only for genuinely independent work that can be prepared in a separate git worktree.",
			"Represent merges as explicit kind=merge items with dependencies on the work they combine.",
		],
		parameters: WorkgraphParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runSerialized(async () => {
				if (params.action === "list") {
					return {
						message: state.items.length === 0 ? "No workgraph items" : buildSnapshotText(state),
						state: cloneWorkgraphState(state),
					};
				}

				const draft = cloneWorkgraphState(state);
				let message = "Updated workgraph";

				if (params.action === "bootstrap") {
					if (!params.activeText || normalizeText(params.activeText).length === 0) {
						throw new Error("activeText is required for bootstrap");
					}
					const pendingTexts = (params.pendingTexts || []).map(normalizeText).filter((text) => text.length > 0);
					const bootstrapped = bootstrapWorkgraph(draft, params.activeText, pendingTexts, "agent");
					message = `Bootstrapped workgraph with active #${bootstrapped.active.id}`;
				} else if (params.action === "add") {
					if (!params.text || normalizeText(params.text).length === 0) {
						throw new Error("text is required for add");
					}
					const execution = params.execution ?? "local";
					const kind = params.kind ?? "work";
					const { item, bootstrapped } = ensureHybridAdd(draft, ctx, params.text, "agent", execution, kind);
					message = bootstrapped
						? `Added pending item #${item.id} and inferred active #${bootstrapped.id}`
						: `Added item #${item.id}`;
				} else if (params.action === "edit") {
					if (params.id === undefined || !params.text || normalizeText(params.text).length === 0) {
						throw new Error("id and text are required for edit");
					}
					const item = findWorkgraphItem(draft, params.id);
					if (!item) throw new Error(`Item #${params.id} not found`);
					item.text = normalizeText(params.text);
					item.updatedAt = Date.now();
					delete item.workerPrompt;
					message = `Edited item #${item.id}`;
				} else if (params.action === "set_status") {
					if (params.id === undefined || !params.status) {
						throw new Error("id and status are required for set_status");
					}
					const item = setWorkgraphItemStatus(draft, params.id, params.status, params.blockedReason);
					message = `Marked item #${item.id} as ${item.status}`;
				} else if (params.action === "set_active") {
					if (params.id === undefined) throw new Error("id is required for set_active");
					const item = setWorkgraphItemStatus(draft, params.id, "active");
					message = `Activated item #${item.id}`;
				} else if (params.action === "set_dependencies") {
					if (params.id === undefined || !params.dependTo) {
						throw new Error("id and dependTo are required for set_dependencies");
					}
					const item = setWorkgraphItemDependencies(draft, params.id, params.dependTo);
					message = `Updated dependencies for item #${item.id}`;
				} else if (params.action === "set_execution") {
					if (params.id === undefined || !params.execution) {
						throw new Error("id and execution are required for set_execution");
					}
					const item = setWorkgraphItemExecution(draft, params.id, params.execution);
					message = `Set execution for item #${item.id} to ${item.execution}`;
				} else if (params.action === "set_kind") {
					if (params.id === undefined || !params.kind) {
						throw new Error("id and kind are required for set_kind");
					}
					const item = setWorkgraphItemKind(draft, params.id, params.kind);
					message = `Set kind for item #${item.id} to ${item.kind}`;
				} else if (params.action === "move") {
					if (params.id === undefined || !params.direction) {
						throw new Error("id and direction are required for move");
					}
					const item = moveWorkgraphItem(draft, params.id, params.direction);
					message = `Moved item #${item.id} ${params.direction}`;
				} else if (params.action === "clear_resolved") {
					const removed = clearResolvedWorkgraphItems(draft);
					message = removed > 0 ? `Cleared ${removed} resolved items` : "No resolved items to clear";
				}

				state = draft;
				persistState();
				updateUi(ctx, state);
				return { message, state: cloneWorkgraphState(state) };
			});

			return {
				content: [{ type: "text", text: result.message }],
				details: {
					action: params.action,
					message: result.message,
					state: result.state,
				} satisfies WorkgraphToolDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `“${summarizeText(args.text, 42)}”`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as WorkgraphToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const stateText = options.expanded ? buildSnapshotText(details.state) : buildSnapshotPreview(details.state);
			return new Text(`${theme.fg("success", "✓")} ${details.message}\n${theme.fg("muted", stateText)}`, 0, 0);
		},
	});

	pi.registerCommand("graph", {
		description: "Open the editable workgraph",
		handler: handleGraphCommand,
	});

	pi.registerCommand("workgraph", {
		description: "Alias for /graph",
		handler: handleGraphCommand,
	});

	pi.registerCommand("item", {
		description: "Manage workgraph items (usage: /item [add|merge|activate|block|done|cancel|edit|depend|execution|kind|move|clear-resolved])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await openGraphUi(ctx);
				return;
			}
			const [command, ...rest] = trimmed.split(/\s+/);
			try {
				if (command === "add") {
					let execution: WorkgraphExecutionMode = "local";
					let text = rest.join(" ").trim();
					if (rest[0] === "local" || rest[0] === "parallel") {
						execution = rest[0];
						text = rest.slice(1).join(" ").trim();
					}
					if (!text) throw new Error("Usage: /item add [local|parallel] <text>");
					await mutateState(ctx, (draft) => {
						ensureHybridAdd(draft, ctx, text, "user", execution, "work");
					});
					ctx.ui.notify("Workgraph item saved", "info");
					return;
				}
				if (command === "merge") {
					const text = rest.join(" ").trim();
					if (!text) throw new Error("Usage: /item merge <text>");
					await mutateState(ctx, (draft) => {
						ensureHybridAdd(draft, ctx, text, "user", "local", "merge");
					});
					ctx.ui.notify("Merge item saved", "info");
					return;
				}
				if (command === "activate") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /item activate <id>");
					await mutateState(ctx, (draft) => {
						setWorkgraphItemStatus(draft, id, "active");
					});
					return;
				}
				if (command === "done") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /item done <id>");
					await mutateState(ctx, (draft) => {
						setWorkgraphItemStatus(draft, id, "done");
					});
					return;
				}
				if (command === "cancel") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /item cancel <id>");
					await mutateState(ctx, (draft) => {
						setWorkgraphItemStatus(draft, id, "cancelled");
					});
					return;
				}
				if (command === "block") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /item block <id> [reason]");
					const reason = rest.slice(1).join(" ").trim() || "Blocked";
					await mutateState(ctx, (draft) => {
						setWorkgraphItemStatus(draft, id, "blocked", reason);
					});
					return;
				}
				if (command === "edit") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /item edit <id> <text>");
					const text = rest.slice(1).join(" ").trim();
					if (!text) throw new Error("Usage: /item edit <id> <text>");
					await mutateState(ctx, (draft) => {
						const item = findWorkgraphItem(draft, id);
						if (!item) throw new Error(`Item #${id} not found`);
						item.text = normalizeText(text);
						item.updatedAt = Date.now();
						delete item.workerPrompt;
					});
					return;
				}
				if (command === "depend") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id) || rest.length < 2) throw new Error("Usage: /item depend <id> <depIds>");
					const dependencies = parseDependencyInput(rest.slice(1).join(" "));
					await mutateState(ctx, (draft) => {
						setWorkgraphItemDependencies(draft, id, dependencies);
					});
					return;
				}
				if (command === "execution") {
					const id = Number(rest[0]);
					const execution = rest[1] as WorkgraphExecutionMode | undefined;
					if (!Number.isInteger(id) || (execution !== "local" && execution !== "parallel")) {
						throw new Error("Usage: /item execution <id> <local|parallel>");
					}
					await mutateState(ctx, (draft) => {
						setWorkgraphItemExecution(draft, id, execution);
					});
					return;
				}
				if (command === "kind") {
					const id = Number(rest[0]);
					const kind = rest[1] as WorkgraphItemKind | undefined;
					if (!Number.isInteger(id) || (kind !== "work" && kind !== "merge")) {
						throw new Error("Usage: /item kind <id> <work|merge>");
					}
					await mutateState(ctx, (draft) => {
						setWorkgraphItemKind(draft, id, kind);
					});
					return;
				}
				if (command === "move") {
					const id = Number(rest[0]);
					const direction = rest[1] as WorkgraphMoveDirection | undefined;
					if (!Number.isInteger(id) || (direction !== "up" && direction !== "down")) {
						throw new Error("Usage: /item move <id> <up|down>");
					}
					await mutateState(ctx, (draft) => {
						moveWorkgraphItem(draft, id, direction);
					});
					return;
				}
				if (command === "clear-resolved") {
					await mutateState(ctx, (draft) => {
						clearResolvedWorkgraphItems(draft);
					});
					return;
				}
				if (command === "list") {
					sendSnapshotMessage(pi, state);
					return;
				}
				throw new Error("Unknown subcommand");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		resetRuntimeState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetRuntimeState(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${workgraphPromptAppend()}`,
		};
	});
}

export default workgraphExtension;
