import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const TOOL_NAME = "workflow_todos";
const STATUS_KEY = "workflow-todos";
const WIDGET_KEY = "workflow-todos";
const STATE_ENTRY_TYPE = "workflow-todos-state";
const SNAPSHOT_MESSAGE_TYPE = "workflow-todos-snapshot";
const MAX_WIDGET_PENDING = 4;
const MAX_SUMMARY_PER_BUCKET = 6;

const TODO_STATUSES = ["active", "pending", "blocked", "done", "cancelled"] as const;
const MOVE_DIRECTIONS = ["up", "down"] as const;
const TOOL_ACTIONS = [
	"list",
	"bootstrap",
	"add",
	"edit",
	"set_status",
	"set_active",
	"set_dependencies",
	"move",
	"clear_completed",
] as const;

type WorkflowTodoStatus = (typeof TODO_STATUSES)[number];
type WorkflowMoveDirection = (typeof MOVE_DIRECTIONS)[number];
type WorkflowToolAction = (typeof TOOL_ACTIONS)[number];
type WorkflowMutationSource = "user" | "agent" | "system";

interface WorkflowTodo {
	id: number;
	text: string;
	status: WorkflowTodoStatus;
	dependTo: number[];
	blockedReason?: string;
	createdAt: number;
	updatedAt: number;
	source: WorkflowMutationSource;
}

interface WorkflowTodoState {
	version: 1;
	nextId: number;
	todos: WorkflowTodo[];
}

interface WorkflowToolDetails {
	action: WorkflowToolAction;
	message: string;
	state: WorkflowTodoState;
}

interface WorkflowSnapshotMessageDetails {
	preview: string;
	timestamp: number;
}

const WorkflowTodosParams = Type.Object({
	action: StringEnum(TOOL_ACTIONS),
	text: Type.Optional(Type.String({ description: "Todo text for add/edit" })),
	id: Type.Optional(Type.Number({ description: "Todo id for edit/status/dependency/move" })),
	status: Type.Optional(StringEnum(TODO_STATUSES)),
	blockedReason: Type.Optional(Type.String({ description: "Blocked reason when status is blocked" })),
	dependTo: Type.Optional(Type.Array(Type.Number(), { description: "Dependency ids" })),
	direction: Type.Optional(StringEnum(MOVE_DIRECTIONS)),
	activeText: Type.Optional(Type.String({ description: "Current active task text when bootstrapping a workflow" })),
	pendingTexts: Type.Optional(Type.Array(Type.String(), { description: "Pending todo texts when bootstrapping" })),
});

const emptyState = (): WorkflowTodoState => ({
	version: 1,
	nextId: 1,
	todos: [],
});

const cloneState = (state: WorkflowTodoState): WorkflowTodoState => ({
	version: 1,
	nextId: state.nextId,
	todos: state.todos.map((todo) => ({
		...todo,
		dependTo: [...todo.dependTo],
	})),
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isStatus = (value: unknown): value is WorkflowTodoStatus =>
	typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const summarizeText = (value: string, max = 96): string => {
	const normalized = normalizeText(value);
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
};

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

const formatDependTo = (dependTo: number[]): string =>
	dependTo.length === 0 ? "" : ` depends on ${dependTo.map((id) => `#${id}`).join(", ")}`;

const formatTodoLabel = (todo: WorkflowTodo): string => {
	const base = `#${todo.id} ${summarizeText(todo.text)}`;
	const blocked = todo.status === "blocked" && todo.blockedReason ? ` [${summarizeText(todo.blockedReason, 48)}]` : "";
	return `${base}${blocked}${formatDependTo(todo.dependTo)}`;
};

const statusEmoji = (status: WorkflowTodoStatus): string =>
	status === "active"
		? "→"
		: status === "pending"
			? "○"
			: status === "blocked"
				? "!"
				: status === "done"
					? "✓"
					: "×";

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

const getCurrentFocusTodo = (state: WorkflowTodoState): WorkflowTodo | undefined =>
	state.todos.find((todo) => todo.status === "active" || todo.status === "blocked");

const isResolvedStatus = (status: WorkflowTodoStatus): boolean => status === "done" || status === "cancelled";

const areDependenciesResolved = (state: WorkflowTodoState, todo: WorkflowTodo): boolean =>
	todo.dependTo.every((id) => {
		const dependency = state.todos.find((candidate) => candidate.id === id);
		return dependency ? isResolvedStatus(dependency.status) : false;
	});

const promoteNextEligibleTodo = (state: WorkflowTodoState): WorkflowTodo | undefined => {
	if (getCurrentFocusTodo(state)) return undefined;
	const candidate = state.todos.find((todo) => todo.status === "pending" && areDependenciesResolved(state, todo));
	if (!candidate) return undefined;
	candidate.status = "active";
	candidate.blockedReason = undefined;
	candidate.updatedAt = Date.now();
	return candidate;
};

const createTodo = (
	state: WorkflowTodoState,
	text: string,
	status: WorkflowTodoStatus,
	source: WorkflowMutationSource,
	dependTo: number[] = [],
	blockedReason?: string,
): WorkflowTodo => {
	const timestamp = Date.now();
	const todo: WorkflowTodo = {
		id: state.nextId++,
		text: normalizeText(text),
		status,
		dependTo: [...new Set(dependTo.filter((id) => Number.isInteger(id) && id > 0))],
		blockedReason: blockedReason ? normalizeText(blockedReason) : undefined,
		createdAt: timestamp,
		updatedAt: timestamp,
		source,
	};
	state.todos.push(todo);
	return todo;
};

const findTodo = (state: WorkflowTodoState, id: number): WorkflowTodo | undefined =>
	state.todos.find((todo) => todo.id === id);

const setTodoStatus = (
	state: WorkflowTodoState,
	id: number,
	status: WorkflowTodoStatus,
	blockedReason?: string,
): WorkflowTodo => {
	const todo = findTodo(state, id);
	if (!todo) throw new Error(`Todo #${id} not found`);
	const focus = getCurrentFocusTodo(state);
	if ((status === "active" || status === "blocked") && focus && focus.id !== todo.id) {
		focus.status = "pending";
		focus.blockedReason = undefined;
		focus.updatedAt = Date.now();
	}
	todo.status = status;
	todo.updatedAt = Date.now();
	todo.blockedReason = status === "blocked" ? normalizeText(blockedReason || todo.blockedReason || "Blocked") : undefined;
	if (status === "active" && !areDependenciesResolved(state, todo)) {
		todo.status = "blocked";
		todo.blockedReason = `Waiting on ${todo.dependTo.map((dependencyId) => `#${dependencyId}`).join(", ")}`;
	}
	if (isResolvedStatus(status) || status === "pending") {
		todo.blockedReason = undefined;
	}
	if (isResolvedStatus(status)) {
		promoteNextEligibleTodo(state);
	}
	return todo;
};

const moveTodo = (state: WorkflowTodoState, id: number, direction: WorkflowMoveDirection): WorkflowTodo => {
	const index = state.todos.findIndex((todo) => todo.id === id);
	if (index === -1) throw new Error(`Todo #${id} not found`);
	const nextIndex = direction === "up" ? index - 1 : index + 1;
	if (nextIndex < 0 || nextIndex >= state.todos.length) {
		throw new Error(`Todo #${id} cannot move ${direction}`);
	}
	const current = state.todos[index];
	const next = state.todos[nextIndex];
	if (!current || !next) throw new Error(`Todo #${id} cannot move ${direction}`);
	state.todos[index] = next;
	state.todos[nextIndex] = current;
	current.updatedAt = Date.now();
	return current;
};

const setTodoDependencies = (state: WorkflowTodoState, id: number, dependTo: number[]): WorkflowTodo => {
	const todo = findTodo(state, id);
	if (!todo) throw new Error(`Todo #${id} not found`);
	const normalized = [...new Set(dependTo.filter((candidate) => Number.isInteger(candidate) && candidate > 0 && candidate !== id))];
	for (const dependencyId of normalized) {
		if (!findTodo(state, dependencyId)) {
			throw new Error(`Dependency #${dependencyId} not found`);
		}
	}
	todo.dependTo = normalized;
	todo.updatedAt = Date.now();
	if (todo.status === "active" && !areDependenciesResolved(state, todo)) {
		todo.status = "blocked";
		todo.blockedReason = `Waiting on ${todo.dependTo.map((dependencyId) => `#${dependencyId}`).join(", ")}`;
	}
	return todo;
};

const clearCompletedTodos = (state: WorkflowTodoState): number => {
	const before = state.todos.length;
	state.todos = state.todos.filter((todo) => !isResolvedStatus(todo.status));
	return before - state.todos.length;
};

const inferCurrentTask = (ctx: ExtensionContext): string | undefined => {
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

const maybeBootstrapFocusFromContext = (state: WorkflowTodoState, ctx: ExtensionContext): WorkflowTodo | undefined => {
	if (getCurrentFocusTodo(state)) return undefined;
	const inferred = inferCurrentTask(ctx);
	if (!inferred) return undefined;
	const normalized = inferred.toLowerCase();
	if (state.todos.some((todo) => normalizeText(todo.text).toLowerCase() === normalized)) return undefined;
	return createTodo(state, inferred, "active", "system");
};

const ensureHybridAdd = (
	state: WorkflowTodoState,
	ctx: ExtensionContext | undefined,
	text: string,
	source: WorkflowMutationSource,
): { todo: WorkflowTodo; bootstrapped?: WorkflowTodo } => {
	const bootstrapped = ctx ? maybeBootstrapFocusFromContext(state, ctx) : undefined;
	const todo = createTodo(state, text, "pending", source);
	return { todo, bootstrapped };
};

const bootstrapWorkflow = (
	state: WorkflowTodoState,
	activeText: string,
	pendingTexts: string[],
	source: WorkflowMutationSource,
): { active: WorkflowTodo; pending: WorkflowTodo[] } => {
	if (state.todos.length > 0) {
		throw new Error("Workflow already exists; use add/edit/status actions instead of bootstrap");
	}
	const active = createTodo(state, activeText, "active", source);
	const pending = pendingTexts.map((text) => createTodo(state, text, "pending", source));
	return { active, pending };
};

const isWorkflowTodo = (value: unknown): value is WorkflowTodo =>
	isObject(value) &&
	typeof value.id === "number" &&
	typeof value.text === "string" &&
	isStatus(value.status) &&
	Array.isArray(value.dependTo) &&
	value.dependTo.every((id) => typeof id === "number") &&
	typeof value.createdAt === "number" &&
	typeof value.updatedAt === "number" &&
	(value.blockedReason === undefined || typeof value.blockedReason === "string") &&
	(value.source === "user" || value.source === "agent" || value.source === "system");

const isWorkflowTodoState = (value: unknown): value is WorkflowTodoState =>
	isObject(value) && value.version === 1 && typeof value.nextId === "number" && Array.isArray(value.todos) && value.todos.every(isWorkflowTodo);

const summarizeTodosByStatus = (state: WorkflowTodoState, status: WorkflowTodoStatus): string[] =>
	state.todos
		.filter((todo) => todo.status === status)
		.slice(0, MAX_SUMMARY_PER_BUCKET)
		.map((todo) => `- ${formatTodoLabel(todo)}`);

const buildPromptAppend = (state: WorkflowTodoState): string => {
	const lines = [
		"## Workflow Todos",
		`A workflow todo system is available through the ${TOOL_NAME} tool.`,
		"Use it only when work is genuinely multi-step, blocked, or the user wants to park future work for later.",
		"Do not create workflow todos for trivial one-step work or when there is only one obvious task.",
		"If a later task appears while current work is unresolved, add it as pending instead of assuming it should run next.",
		"If you are blocked by a user decision, question, or investigation, keep the current todo blocked instead of marking it done.",
		"Use dependTo when a todo must wait for other todos to finish before it can become active.",
	];
	if (state.todos.length === 0) return lines.join("\n");
	const active = summarizeTodosByStatus(state, "active");
	const blocked = summarizeTodosByStatus(state, "blocked");
	const pending = summarizeTodosByStatus(state, "pending");
	const doneCount = state.todos.filter((todo) => todo.status === "done").length;
	const cancelledCount = state.todos.filter((todo) => todo.status === "cancelled").length;
	lines.push("", "Current workflow state:");
	if (active.length > 0) lines.push("Active:", ...active);
	if (blocked.length > 0) lines.push("Blocked:", ...blocked);
	if (pending.length > 0) lines.push("Pending:", ...pending);
	if (doneCount > 0 || cancelledCount > 0) {
		lines.push(`Resolved: ${doneCount} done, ${cancelledCount} cancelled.`);
	}
	return lines.join("\n");
};

const buildSnapshotText = (state: WorkflowTodoState): string => {
	if (state.todos.length === 0) return "Workflow Todos\n- no workflow todos";
	const lines = ["Workflow Todos"];
	for (const status of TODO_STATUSES) {
		const todos = state.todos.filter((todo) => todo.status === status);
		if (todos.length === 0) continue;
		lines.push(`${status[0].toUpperCase()}${status.slice(1)}:`);
		for (const todo of todos) {
			lines.push(`- ${formatTodoLabel(todo)}`);
		}
	}
	return lines.join("\n");
};

const buildSnapshotPreview = (state: WorkflowTodoState): string => {
	if (state.todos.length === 0) return "- no workflow todos";
	const counts = TODO_STATUSES.map((status) => `${status}: ${state.todos.filter((todo) => todo.status === status).length}`)
		.filter((part) => !part.endsWith(": 0"));
	return counts.map((part) => `- ${part}`).join("\n");
};

const buildStatusLine = (ctx: ExtensionContext, state: WorkflowTodoState): string | undefined => {
	if (state.todos.length === 0) return undefined;
	const theme = ctx.ui.theme;
	const counts = {
		active: state.todos.filter((todo) => todo.status === "active").length,
		pending: state.todos.filter((todo) => todo.status === "pending").length,
		blocked: state.todos.filter((todo) => todo.status === "blocked").length,
		done: state.todos.filter((todo) => todo.status === "done").length,
		cancelled: state.todos.filter((todo) => todo.status === "cancelled").length,
	};
	const parts = [theme.fg("accent", "todo")];
	if (counts.active) parts.push(theme.fg("success", `A${counts.active}`));
	if (counts.blocked) parts.push(theme.fg("error", `B${counts.blocked}`));
	if (counts.pending) parts.push(theme.fg("warning", `P${counts.pending}`));
	if (counts.done) parts.push(theme.fg("dim", `D${counts.done}`));
	if (counts.cancelled) parts.push(theme.fg("dim", `C${counts.cancelled}`));
	return parts.join(" ");
};

const buildWidgetLines = (ctx: ExtensionContext, state: WorkflowTodoState): string[] | undefined => {
	if (state.todos.length === 0) return undefined;
	const theme = ctx.ui.theme;
	const lines = [theme.fg("accent", theme.bold("Workflow Todos"))];
	const focus = getCurrentFocusTodo(state);
	if (focus) {
		const color = focus.status === "blocked" ? "error" : "success";
		lines.push(`${theme.fg(color, statusEmoji(focus.status))} ${formatTodoLabel(focus)}`);
	}
	const pending = state.todos.filter((todo) => todo.status === "pending");
	for (const todo of pending.slice(0, MAX_WIDGET_PENDING)) {
		lines.push(`${theme.fg("warning", statusEmoji(todo.status))} ${formatTodoLabel(todo)}`);
	}
	if (pending.length > MAX_WIDGET_PENDING) {
		lines.push(theme.fg("dim", `… ${pending.length - MAX_WIDGET_PENDING} more pending`));
	}
	const resolved = state.todos.filter((todo) => todo.status === "done" || todo.status === "cancelled").length;
	if (resolved > 0) {
		lines.push(theme.fg("dim", `${resolved} resolved`));
	}
	return lines;
};

const updateUi = (ctx: ExtensionContext, state: WorkflowTodoState) => {
	ctx.ui.setStatus(STATUS_KEY, buildStatusLine(ctx, state));
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(ctx, state));
};

const sendSnapshotMessage = (pi: ExtensionAPI, state: WorkflowTodoState) => {
	pi.sendMessage({
		customType: SNAPSHOT_MESSAGE_TYPE,
		content: buildSnapshotText(state),
		display: true,
		details: {
			preview: buildSnapshotPreview(state),
			timestamp: Date.now(),
		} satisfies WorkflowSnapshotMessageDetails,
	});
};

const parseDependencyInput = (value: string): number[] =>
	[...new Set(value.split(/[\s,]+/).map((part) => Number(part)).filter((id) => Number.isInteger(id) && id > 0))];

function workflowTodosExtension(pi: ExtensionAPI) {
	let state = emptyState();
	let mutationQueue: Promise<unknown> = Promise.resolve();

	const persistState = () => {
		pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
	};

	const reconstructState = (ctx: ExtensionContext) => {
		const lastSnapshot = ctx.sessionManager
			.getBranch()
			.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
			.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
			.map((entry) => entry.data)
			.reverse()
			.find(isWorkflowTodoState);
		state = lastSnapshot ? cloneState(lastSnapshot) : emptyState();
		updateUi(ctx, state);
	};

	const runSerialized = async <T>(operation: () => Promise<T> | T): Promise<T> => {
		const next = mutationQueue.then(operation);
		mutationQueue = next.then(() => undefined, () => undefined);
		return next;
	};

	const mutateState = async <T>(ctx: ExtensionContext | undefined, operation: (draft: WorkflowTodoState) => T): Promise<T> =>
		runSerialized(async () => {
			const draft = cloneState(state);
			const result = operation(draft);
			state = draft;
			persistState();
			if (ctx) updateUi(ctx, state);
			return result;
		});

	const workflowPromptAppend = (): string => buildPromptAppend(state);

	const showTodoPicker = async (ctx: ExtensionCommandContext): Promise<string | null> => {
		const items: SelectItem[] = [
			{ value: "add", label: "+ Add workflow todo", description: "Park a next task without sending it to the agent" },
		];
		for (const todo of state.todos) {
			items.push({
				value: `todo:${todo.id}`,
				label: `${statusEmoji(todo.status)} ${formatTodoLabel(todo)}`,
				description: todo.status,
			});
		}
		if (state.todos.some((todo) => isResolvedStatus(todo.status))) {
			items.push({ value: "clear", label: "Clear resolved todos", description: "Remove done and cancelled items" });
		}
		items.push({ value: "close", label: "Close", description: "Exit workflow todo editor" });

		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Workflow Todos")), 1, 0));
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
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0),
			);
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

	const showTodoActions = async (ctx: ExtensionCommandContext, todo: WorkflowTodo): Promise<string | undefined> => {
		const options = [
			"Edit text",
			"Mark active",
			"Mark pending",
			"Mark blocked",
			"Mark done",
			"Mark cancelled",
			"Edit dependencies",
			"Move up",
			"Move down",
			"Back",
		];
		return ctx.ui.select(`Todo #${todo.id}`, options);
	};

	const openTodosUi = async (ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) {
			sendSnapshotMessage(pi, state);
			return;
		}
		while (true) {
			const picked = await showTodoPicker(ctx);
			if (!picked || picked === "close") return;
			if (picked === "add") {
				const text = await ctx.ui.editor("Add workflow todo", "");
				if (!text || !normalizeText(text)) continue;
				await mutateState(ctx, (draft) => {
					ensureHybridAdd(draft, ctx, text, "user");
				});
				continue;
			}
			if (picked === "clear") {
				await mutateState(ctx, (draft) => {
					clearCompletedTodos(draft);
				});
				continue;
			}
			if (!picked.startsWith("todo:")) continue;
			const id = Number(picked.slice(5));
			const todo = findTodo(state, id);
			if (!todo) continue;
			const action = await showTodoActions(ctx, todo);
			if (!action || action === "Back") continue;
			if (action === "Edit text") {
				const text = await ctx.ui.editor(`Edit todo #${id}`, todo.text);
				if (!text || !normalizeText(text)) continue;
				await mutateState(ctx, (draft) => {
					const target = findTodo(draft, id);
					if (!target) throw new Error(`Todo #${id} not found`);
					target.text = normalizeText(text);
					target.updatedAt = Date.now();
				});
				continue;
			}
			if (action === "Mark blocked") {
				const reason = await ctx.ui.editor(`Blocked reason for #${id}`, todo.blockedReason || "");
				if (reason === undefined) continue;
				await mutateState(ctx, (draft) => {
					setTodoStatus(draft, id, "blocked", reason || "Blocked");
				});
				continue;
			}
			if (action === "Edit dependencies") {
				const next = await ctx.ui.input(`Dependencies for #${id}`, todo.dependTo.join(", "));
				if (next === undefined) continue;
				await mutateState(ctx, (draft) => {
					setTodoDependencies(draft, id, parseDependencyInput(next));
				});
				continue;
			}
			await mutateState(ctx, (draft) => {
				if (action === "Mark active") setTodoStatus(draft, id, "active");
				else if (action === "Mark pending") setTodoStatus(draft, id, "pending");
				else if (action === "Mark done") setTodoStatus(draft, id, "done");
				else if (action === "Mark cancelled") setTodoStatus(draft, id, "cancelled");
				else if (action === "Move up") moveTodo(draft, id, "up");
				else if (action === "Move down") moveTodo(draft, id, "down");
			});
		}
	};

	pi.registerMessageRenderer(SNAPSHOT_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as WorkflowSnapshotMessageDetails | undefined;
		const box = new Container();
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		box.addChild(new Text(theme.fg("accent", theme.bold("Workflow Todos")), 1, 0));
		box.addChild(new Text(options.expanded ? String(message.content) : details?.preview ?? String(message.content), 1, 0));
		box.addChild(new Text(theme.fg("dim", options.expanded ? "Live snapshot" : "Expand for full workflow state"), 1, 0));
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return box;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Workflow Todos",
		description:
			"Manage workflow todos for non-trivial multi-step work. Use to create active/pending/blocked/done/cancelled todos and dependency links. Do not use for trivial one-step work.",
		promptSnippet: "Manage workflow todos for multi-step or blocked work.",
		promptGuidelines: [
			"Use workflow todos only for non-trivial multi-step work, blocked work, or when future tasks need to be parked.",
			"Do not create workflow todos for trivial one-step work or when there is only one obvious task.",
			"If another task appears for later, add it as pending instead of assuming it should run next.",
			"If blocked on user input, a decision, an error, or investigation, keep the current todo blocked instead of marking it done.",
		],
		parameters: WorkflowTodosParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await runSerialized(async () => {
				if (params.action === "list") {
					return {
						message: state.todos.length === 0 ? "No workflow todos" : buildSnapshotText(state),
						state: cloneState(state),
					};
				}

				const draft = cloneState(state);
				let message = "Updated workflow todos";

				if (params.action === "bootstrap") {
					if (!params.activeText || normalizeText(params.activeText).length === 0) {
						throw new Error("activeText is required for bootstrap");
					}
					const pendingTexts = (params.pendingTexts || []).map(normalizeText).filter((text) => text.length > 0);
					const bootstrapped = bootstrapWorkflow(draft, params.activeText, pendingTexts, "agent");
					message = `Bootstrapped workflow with active #${bootstrapped.active.id}`;
				} else if (params.action === "add") {
					if (!params.text || normalizeText(params.text).length === 0) {
						throw new Error("text is required for add");
					}
					const { todo, bootstrapped } = ensureHybridAdd(draft, ctx, params.text, "agent");
					message = bootstrapped
						? `Added pending todo #${todo.id} and inferred active #${bootstrapped.id}`
						: `Added todo #${todo.id}`;
				} else if (params.action === "edit") {
					if (params.id === undefined || !params.text || normalizeText(params.text).length === 0) {
						throw new Error("id and text are required for edit");
					}
					const todo = findTodo(draft, params.id);
					if (!todo) throw new Error(`Todo #${params.id} not found`);
					todo.text = normalizeText(params.text);
					todo.updatedAt = Date.now();
					message = `Edited todo #${todo.id}`;
				} else if (params.action === "set_status") {
					if (params.id === undefined || !params.status) {
						throw new Error("id and status are required for set_status");
					}
					const todo = setTodoStatus(draft, params.id, params.status, params.blockedReason);
					message = `Marked todo #${todo.id} as ${todo.status}`;
				} else if (params.action === "set_active") {
					if (params.id === undefined) throw new Error("id is required for set_active");
					const todo = setTodoStatus(draft, params.id, "active");
					message = `Activated todo #${todo.id}`;
				} else if (params.action === "set_dependencies") {
					if (params.id === undefined || !params.dependTo) {
						throw new Error("id and dependTo are required for set_dependencies");
					}
					const todo = setTodoDependencies(draft, params.id, params.dependTo);
					message = `Updated dependencies for todo #${todo.id}`;
				} else if (params.action === "move") {
					if (params.id === undefined || !params.direction) {
						throw new Error("id and direction are required for move");
					}
					const todo = moveTodo(draft, params.id, params.direction);
					message = `Moved todo #${todo.id} ${params.direction}`;
				} else if (params.action === "clear_completed") {
					const removed = clearCompletedTodos(draft);
					message = removed > 0 ? `Cleared ${removed} resolved todos` : "No resolved todos to clear";
				}

				state = draft;
				persistState();
				updateUi(ctx, state);
				return { message, state: cloneState(state) };
			});

			return {
				content: [{ type: "text", text: result.message }],
				details: {
					action: params.action,
					message: result.message,
					state: result.state,
				} satisfies WorkflowToolDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `“${summarizeText(args.text, 42)}”`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as WorkflowToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const stateText = options.expanded ? buildSnapshotText(details.state) : buildSnapshotPreview(details.state);
			return new Text(`${theme.fg("success", "✓")} ${details.message}\n${theme.fg("muted", stateText)}`, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Open the editable workflow todo list",
		handler: async (_args, ctx) => {
			await openTodosUi(ctx);
		},
	});

	pi.registerCommand("todo", {
		description: "Manage workflow todos (usage: /todo [add|activate|block|done|cancel|edit|depend|move|clear-completed])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await openTodosUi(ctx);
				return;
			}
			const [command, ...rest] = trimmed.split(/\s+/);
			const remainder = rest.join(" ").trim();
			try {
				if (command === "add") {
					if (!remainder) throw new Error("Usage: /todo add <text>");
					await mutateState(ctx, (draft) => {
						ensureHybridAdd(draft, ctx, remainder, "user");
					});
					ctx.ui.notify("Workflow todo saved", "info");
					return;
				}
				if (command === "activate") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /todo activate <id>");
					await mutateState(ctx, (draft) => {
						setTodoStatus(draft, id, "active");
					});
					return;
				}
				if (command === "done") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /todo done <id>");
					await mutateState(ctx, (draft) => {
						setTodoStatus(draft, id, "done");
					});
					return;
				}
				if (command === "cancel") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /todo cancel <id>");
					await mutateState(ctx, (draft) => {
						setTodoStatus(draft, id, "cancelled");
					});
					return;
				}
				if (command === "block") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /todo block <id> [reason]");
					const reason = rest.slice(1).join(" ").trim() || "Blocked";
					await mutateState(ctx, (draft) => {
						setTodoStatus(draft, id, "blocked", reason);
					});
					return;
				}
				if (command === "edit") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /todo edit <id> <text>");
					const text = rest.slice(1).join(" ").trim();
					if (!text) throw new Error("Usage: /todo edit <id> <text>");
					await mutateState(ctx, (draft) => {
						const todo = findTodo(draft, id);
						if (!todo) throw new Error(`Todo #${id} not found`);
						todo.text = normalizeText(text);
						todo.updatedAt = Date.now();
					});
					return;
				}
				if (command === "depend") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id) || rest.length < 2) throw new Error("Usage: /todo depend <id> <depIds>");
					const dependencies = parseDependencyInput(rest.slice(1).join(" "));
					await mutateState(ctx, (draft) => {
						setTodoDependencies(draft, id, dependencies);
					});
					return;
				}
				if (command === "move") {
					const id = Number(rest[0]);
					const direction = rest[1] as WorkflowMoveDirection | undefined;
					if (!Number.isInteger(id) || (direction !== "up" && direction !== "down")) {
						throw new Error("Usage: /todo move <id> <up|down>");
					}
					await mutateState(ctx, (draft) => {
						moveTodo(draft, id, direction);
					});
					return;
				}
				if (command === "clear-completed") {
					await mutateState(ctx, (draft) => {
						clearCompletedTodos(draft);
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

	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${workflowPromptAppend()}`,
		};
	});
}

export default workflowTodosExtension;
