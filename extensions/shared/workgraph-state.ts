import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export const WORKGRAPH_STATUSES = ["active", "pending", "blocked", "done", "cancelled"] as const;
export const WORKGRAPH_EXECUTION_MODES = ["local", "parallel"] as const;
export const WORKGRAPH_ITEM_KINDS = ["work", "merge"] as const;

export const WORKGRAPH_STATE_ENTRY_TYPE = "workgraph-state";
export const LEGACY_WORKFLOW_STATE_ENTRY_TYPE = "workflow-todos-state";

export type WorkgraphStatus = (typeof WORKGRAPH_STATUSES)[number];
export type WorkgraphExecutionMode = (typeof WORKGRAPH_EXECUTION_MODES)[number];
export type WorkgraphItemKind = (typeof WORKGRAPH_ITEM_KINDS)[number];
export type WorkgraphMutationSource = "user" | "agent" | "system";

export interface WorkgraphItem {
	id: number;
	text: string;
	status: WorkgraphStatus;
	dependTo: number[];
	blockedReason?: string;
	createdAt: number;
	updatedAt: number;
	source: WorkgraphMutationSource;
	execution: WorkgraphExecutionMode;
	kind: WorkgraphItemKind;
	repoRoot?: string;
	worktreePath?: string;
	branchName?: string;
	preparedAt?: number;
	workerPrompt?: string;
}

export interface WorkgraphState {
	version: 2;
	nextId: number;
	items: WorkgraphItem[];
}

interface WorkgraphItemCreateOptions {
	dependTo?: number[];
	blockedReason?: string;
	execution?: WorkgraphExecutionMode;
	kind?: WorkgraphItemKind;
}

interface PreparedWorkspaceMetadata {
	repoRoot: string;
	worktreePath: string;
	branchName: string;
	preparedAt: number;
	workerPrompt: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

export const summarizeText = (value: string, max = 96): string => {
	const normalized = normalizeText(value);
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
};

const isStatus = (value: unknown): value is WorkgraphStatus =>
	typeof value === "string" && (WORKGRAPH_STATUSES as readonly string[]).includes(value);

const isExecutionMode = (value: unknown): value is WorkgraphExecutionMode =>
	typeof value === "string" && (WORKGRAPH_EXECUTION_MODES as readonly string[]).includes(value);

const isItemKind = (value: unknown): value is WorkgraphItemKind =>
	typeof value === "string" && (WORKGRAPH_ITEM_KINDS as readonly string[]).includes(value);

const normalizeDependencies = (value: unknown, selfId?: number): number[] =>
	Array.isArray(value)
		? [...new Set(value.filter((candidate): candidate is number => typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0 && candidate !== selfId))]
		: [];

const normalizeSource = (value: unknown): WorkgraphMutationSource =>
	value === "user" || value === "agent" || value === "system" ? value : "system";

const toWorkgraphItem = (value: unknown): WorkgraphItem | undefined => {
	if (!isObject(value)) return undefined;
	if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id <= 0) return undefined;
	if (typeof value.text !== "string" || normalizeText(value.text).length === 0) return undefined;
	if (!isStatus(value.status)) return undefined;
	if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return undefined;
	const kind = isItemKind(value.kind) ? value.kind : "work";
	const execution = isExecutionMode(value.execution) ? value.execution : "local";
	if (kind === "merge" && execution === "parallel") return undefined;
	return {
		id: value.id,
		text: normalizeText(value.text),
		status: value.status,
		dependTo: normalizeDependencies(value.dependTo, value.id),
		blockedReason: typeof value.blockedReason === "string" && normalizeText(value.blockedReason).length > 0 ? normalizeText(value.blockedReason) : undefined,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		source: normalizeSource(value.source),
		execution,
		kind,
		repoRoot: typeof value.repoRoot === "string" && value.repoRoot.length > 0 ? value.repoRoot : undefined,
		worktreePath: typeof value.worktreePath === "string" && value.worktreePath.length > 0 ? value.worktreePath : undefined,
		branchName: typeof value.branchName === "string" && value.branchName.length > 0 ? value.branchName : undefined,
		preparedAt: typeof value.preparedAt === "number" ? value.preparedAt : undefined,
		workerPrompt: typeof value.workerPrompt === "string" && value.workerPrompt.length > 0 ? value.workerPrompt : undefined,
	};
};

export const toWorkgraphState = (value: unknown): WorkgraphState | undefined => {
	if (!isObject(value) || typeof value.nextId !== "number") return undefined;
	const rawItems = Array.isArray(value.items) ? value.items : Array.isArray(value.todos) ? value.todos : undefined;
	if (!rawItems) return undefined;
	const items = rawItems.map(toWorkgraphItem).filter((item): item is WorkgraphItem => !!item);
	return {
		version: 2,
		nextId: Math.max(1, ...items.map((item) => item.id + 1), Number.isInteger(value.nextId) ? value.nextId : 1),
		items,
	};
};

export const emptyWorkgraphState = (): WorkgraphState => ({
	version: 2,
	nextId: 1,
	items: [],
});

export const cloneWorkgraphState = (state: WorkgraphState): WorkgraphState => ({
	version: 2,
	nextId: state.nextId,
	items: state.items.map((item) => ({
		...item,
		dependTo: [...item.dependTo],
	})),
});

export const readWorkgraphStateFromBranch = (branch: SessionEntry[]): WorkgraphState => {
	const snapshot = branch
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
		.filter((entry) => entry.customType === WORKGRAPH_STATE_ENTRY_TYPE || entry.customType === LEGACY_WORKFLOW_STATE_ENTRY_TYPE)
		.map((entry) => toWorkgraphState(entry.data))
		.reverse()
		.find((value): value is WorkgraphState => !!value);
	return snapshot ? cloneWorkgraphState(snapshot) : emptyWorkgraphState();
};

export const isResolvedStatus = (status: WorkgraphStatus): boolean => status === "done" || status === "cancelled";

export const findWorkgraphItem = (state: WorkgraphState, id: number): WorkgraphItem | undefined =>
	state.items.find((item) => item.id === id);

export const getCurrentFocusItem = (state: WorkgraphState): WorkgraphItem | undefined =>
	state.items.find((item) => item.status === "active" || item.status === "blocked");

export const areDependenciesResolved = (state: WorkgraphState, item: WorkgraphItem): boolean =>
	item.dependTo.every((id) => {
		const dependency = state.items.find((candidate) => candidate.id === id);
		return dependency ? isResolvedStatus(dependency.status) : false;
	});

const promoteNextEligibleItem = (state: WorkgraphState): WorkgraphItem | undefined => {
	if (getCurrentFocusItem(state)) return undefined;
	const candidate = state.items.find((item) => item.status === "pending" && areDependenciesResolved(state, item));
	if (!candidate) return undefined;
	candidate.status = "active";
	candidate.blockedReason = undefined;
	candidate.updatedAt = Date.now();
	return candidate;
};

export const resetPreparedWorkspace = (item: WorkgraphItem): void => {
	delete item.repoRoot;
	delete item.worktreePath;
	delete item.branchName;
	delete item.preparedAt;
	delete item.workerPrompt;
};

export const createWorkgraphItem = (
	state: WorkgraphState,
	text: string,
	status: WorkgraphStatus,
	source: WorkgraphMutationSource,
	options: WorkgraphItemCreateOptions = {},
): WorkgraphItem => {
	const timestamp = Date.now();
	const kind = options.kind ?? "work";
	const execution = options.execution ?? "local";
	if (kind === "merge" && execution === "parallel") {
		throw new Error("Merge items must use local execution");
	}
	const item: WorkgraphItem = {
		id: state.nextId++,
		text: normalizeText(text),
		status,
		dependTo: normalizeDependencies(options.dependTo),
		blockedReason: options.blockedReason ? normalizeText(options.blockedReason) : undefined,
		createdAt: timestamp,
		updatedAt: timestamp,
		source,
		execution,
		kind,
	};
	state.items.push(item);
	return item;
};

export const setWorkgraphItemStatus = (
	state: WorkgraphState,
	id: number,
	status: WorkgraphStatus,
	blockedReason?: string,
): WorkgraphItem => {
	const item = findWorkgraphItem(state, id);
	if (!item) throw new Error(`Item #${id} not found`);
	const focus = getCurrentFocusItem(state);
	if ((status === "active" || status === "blocked") && focus && focus.id !== item.id) {
		focus.status = "pending";
		focus.blockedReason = undefined;
		focus.updatedAt = Date.now();
	}
	item.status = status;
	item.updatedAt = Date.now();
	item.blockedReason = status === "blocked" ? normalizeText(blockedReason || item.blockedReason || "Blocked") : undefined;
	if (status === "active" && !areDependenciesResolved(state, item)) {
		item.status = "blocked";
		item.blockedReason = `Waiting on ${item.dependTo.map((dependencyId) => `#${dependencyId}`).join(", ")}`;
	}
	if (isResolvedStatus(status) || status === "pending") {
		item.blockedReason = undefined;
	}
	if (isResolvedStatus(status)) {
		promoteNextEligibleItem(state);
	}
	return item;
};

export const moveWorkgraphItem = (state: WorkgraphState, id: number, direction: "up" | "down"): WorkgraphItem => {
	const index = state.items.findIndex((item) => item.id === id);
	if (index === -1) throw new Error(`Item #${id} not found`);
	const nextIndex = direction === "up" ? index - 1 : index + 1;
	if (nextIndex < 0 || nextIndex >= state.items.length) {
		throw new Error(`Item #${id} cannot move ${direction}`);
	}
	const current = state.items[index];
	const next = state.items[nextIndex];
	if (!current || !next) throw new Error(`Item #${id} cannot move ${direction}`);
	state.items[index] = next;
	state.items[nextIndex] = current;
	current.updatedAt = Date.now();
	return current;
};

export const setWorkgraphItemDependencies = (state: WorkgraphState, id: number, dependTo: number[]): WorkgraphItem => {
	const item = findWorkgraphItem(state, id);
	if (!item) throw new Error(`Item #${id} not found`);
	const normalized = normalizeDependencies(dependTo, id);
	for (const dependencyId of normalized) {
		if (!findWorkgraphItem(state, dependencyId)) {
			throw new Error(`Dependency #${dependencyId} not found`);
		}
	}
	item.dependTo = normalized;
	item.updatedAt = Date.now();
	resetPreparedWorkspace(item);
	if (item.status === "active" && !areDependenciesResolved(state, item)) {
		item.status = "blocked";
		item.blockedReason = `Waiting on ${item.dependTo.map((dependencyId) => `#${dependencyId}`).join(", ")}`;
	}
	return item;
};

export const setWorkgraphItemExecution = (
	state: WorkgraphState,
	id: number,
	execution: WorkgraphExecutionMode,
): WorkgraphItem => {
	const item = findWorkgraphItem(state, id);
	if (!item) throw new Error(`Item #${id} not found`);
	if (item.kind === "merge" && execution === "parallel") {
		throw new Error("Merge items must use local execution");
	}
	item.execution = execution;
	item.updatedAt = Date.now();
	resetPreparedWorkspace(item);
	return item;
};

export const setWorkgraphItemKind = (state: WorkgraphState, id: number, kind: WorkgraphItemKind): WorkgraphItem => {
	const item = findWorkgraphItem(state, id);
	if (!item) throw new Error(`Item #${id} not found`);
	item.kind = kind;
	if (kind === "merge") item.execution = "local";
	item.updatedAt = Date.now();
	resetPreparedWorkspace(item);
	return item;
};

export const clearResolvedWorkgraphItems = (state: WorkgraphState): number => {
	const before = state.items.length;
	state.items = state.items.filter((item) => !isResolvedStatus(item.status));
	return before - state.items.length;
};

export const bootstrapWorkgraph = (
	state: WorkgraphState,
	activeText: string,
	pendingTexts: string[],
	source: WorkgraphMutationSource,
): { active: WorkgraphItem; pending: WorkgraphItem[] } => {
	if (state.items.length > 0) {
		throw new Error("Workgraph already exists; use add/edit/status actions instead of bootstrap");
	}
	const active = createWorkgraphItem(state, activeText, "active", source);
	const pending = pendingTexts.map((text) => createWorkgraphItem(state, text, "pending", source));
	return { active, pending };
};

export const attachPreparedWorkspace = (
	state: WorkgraphState,
	id: number,
	metadata: PreparedWorkspaceMetadata,
): WorkgraphItem => {
	const item = findWorkgraphItem(state, id);
	if (!item) throw new Error(`Item #${id} not found`);
	item.repoRoot = metadata.repoRoot;
	item.worktreePath = metadata.worktreePath;
	item.branchName = metadata.branchName;
	item.preparedAt = metadata.preparedAt;
	item.workerPrompt = metadata.workerPrompt;
	item.updatedAt = metadata.preparedAt;
	return item;
};
