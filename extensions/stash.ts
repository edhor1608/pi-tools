import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { classifyAgentEndState } from "./shared/agent-end-state.ts";

const STATUS_KEY = "stash";
const STATE_ENTRY_TYPE = "stash-state";
const SNAPSHOT_MESSAGE_TYPE = "stash-snapshot";
const MAX_PREVIEW_ITEMS = 4;
const STASH_MODES = ["manual", "draft", "send"] as const;
const MOVE_DIRECTIONS = ["up", "down"] as const;

type StashMode = (typeof STASH_MODES)[number];
type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

interface StashItem {
	id: number;
	content: string;
	mode: StashMode;
	createdAt: number;
	updatedAt: number;
}

interface StashState {
	version: 1;
	nextId: number;
	items: StashItem[];
}

interface StashSnapshotMessageDetails {
	preview: string;
}

const emptyState = (): StashState => ({
	version: 1,
	nextId: 1,
	items: [],
});

const cloneState = (state: StashState): StashState => ({
	version: 1,
	nextId: state.nextId,
	items: state.items.map((item) => ({ ...item })),
});

const normalizeInline = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeContent = (value: string): string => value.replace(/\r\n/g, "\n").trim();

const summarizeContent = (value: string, max = 84): string => {
	const normalized = normalizeInline(value);
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isMode = (value: unknown): value is StashMode => typeof value === "string" && (STASH_MODES as readonly string[]).includes(value);

const isStashItem = (value: unknown): value is StashItem =>
	isObject(value) &&
	typeof value.id === "number" &&
	typeof value.content === "string" &&
	isMode(value.mode) &&
	typeof value.createdAt === "number" &&
	typeof value.updatedAt === "number";

const isStashState = (value: unknown): value is StashState =>
	isObject(value) && value.version === 1 && typeof value.nextId === "number" && Array.isArray(value.items) && value.items.every(isStashItem);

const readStateFromBranch = (branch: SessionEntry[]): StashState => {
	const snapshot = branch
		.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
		.filter((entry) => entry.customType === STATE_ENTRY_TYPE)
		.map((entry) => entry.data)
		.reverse()
		.find(isStashState);
	return snapshot ? cloneState(snapshot) : emptyState();
};

const modeEmoji = (mode: StashMode): string => (mode === "manual" ? "□" : mode === "draft" ? "✎" : "▶");

const formatItemLabel = (item: StashItem): string => `#${item.id} [${item.mode}] ${summarizeContent(item.content)}`;

const createItem = (state: StashState, content: string, mode: StashMode): StashItem => {
	const normalized = normalizeContent(content);
	if (!normalized) throw new Error("Stash prompt cannot be empty");
	const timestamp = Date.now();
	const item: StashItem = {
		id: state.nextId++,
		content: normalized,
		mode,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	state.items.push(item);
	return item;
};

const findItem = (state: StashState, id: number): StashItem | undefined => state.items.find((item) => item.id === id);

const updateItemContent = (state: StashState, id: number, content: string): StashItem => {
	const item = findItem(state, id);
	if (!item) throw new Error(`Stash item #${id} not found`);
	const normalized = normalizeContent(content);
	if (!normalized) throw new Error("Stash prompt cannot be empty");
	item.content = normalized;
	item.updatedAt = Date.now();
	return item;
};

const setItemMode = (state: StashState, id: number, mode: StashMode): StashItem => {
	const item = findItem(state, id);
	if (!item) throw new Error(`Stash item #${id} not found`);
	item.mode = mode;
	item.updatedAt = Date.now();
	return item;
};

const moveItem = (state: StashState, id: number, direction: MoveDirection): StashItem => {
	const index = state.items.findIndex((item) => item.id === id);
	if (index === -1) throw new Error(`Stash item #${id} not found`);
	const nextIndex = direction === "up" ? index - 1 : index + 1;
	if (nextIndex < 0 || nextIndex >= state.items.length) {
		throw new Error(`Stash item #${id} cannot move ${direction}`);
	}
	const current = state.items[index];
	const next = state.items[nextIndex];
	if (!current || !next) throw new Error(`Stash item #${id} cannot move ${direction}`);
	state.items[index] = next;
	state.items[nextIndex] = current;
	current.updatedAt = Date.now();
	return current;
};

const removeItem = (state: StashState, id: number): { item: StashItem; index: number } => {
	const index = state.items.findIndex((item) => item.id === id);
	if (index === -1) throw new Error(`Stash item #${id} not found`);
	const [item] = state.items.splice(index, 1);
	if (!item) throw new Error(`Stash item #${id} not found`);
	return { item, index };
};

const insertItem = (state: StashState, index: number, item: StashItem): void => {
	state.items.splice(Math.max(0, Math.min(index, state.items.length)), 0, item);
};

const buildSnapshotPreview = (state: StashState): string => {
	if (state.items.length === 0) return "- stash empty";
	return state.items
		.slice(0, MAX_PREVIEW_ITEMS)
		.map((item) => `- ${formatItemLabel(item)}`)
		.join("\n");
};

const buildSnapshotText = (state: StashState): string => {
	if (state.items.length === 0) return "Stash\n- stash empty";
	const lines = ["Stash"];
	for (const item of state.items) {
		lines.push(`- #${item.id} [${item.mode}]`);
		lines.push(item.content);
	}
	return lines.join("\n\n");
};

const buildStatusLine = (ctx: ExtensionContext, state: StashState): string | undefined => {
	if (state.items.length === 0) return undefined;
	return ctx.ui.theme.fg("accent", `stash ${state.items.length}`);
};

const updateUi = (ctx: ExtensionContext, state: StashState) => {
	ctx.ui.setStatus(STATUS_KEY, buildStatusLine(ctx, state));
};

const clearUi = (ctx: ExtensionContext) => {
	ctx.ui.setStatus(STATUS_KEY, undefined);
};

const sendSnapshotMessage = (pi: ExtensionAPI, state: StashState) => {
	pi.sendMessage({
		customType: SNAPSHOT_MESSAGE_TYPE,
		content: buildSnapshotText(state),
		display: true,
		details: {
			preview: buildSnapshotPreview(state),
		} satisfies StashSnapshotMessageDetails,
	});
};

const pickMode = async (ctx: ExtensionCommandContext, initial: StashMode = "manual"): Promise<StashMode | undefined> => {
	if (!ctx.hasUI) return initial;
	const labels = ["manual", "draft", "send"];
	const selected = await ctx.ui.select("Stash release mode", labels);
	return selected === "manual" || selected === "draft" || selected === "send" ? selected : undefined;
};

const promptForContent = async (ctx: ExtensionCommandContext, title: string, prefill = ""): Promise<string | undefined> => {
	if (!ctx.hasUI) return undefined;
	const text = await ctx.ui.editor(title, prefill);
	if (text === undefined) return undefined;
	const normalized = normalizeContent(text);
	if (!normalized) return undefined;
	return normalized;
};

function stashExtension(pi: ExtensionAPI) {
	let state = emptyState();
	let mutationQueue: Promise<unknown> = Promise.resolve();

	const persistState = () => {
		pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
	};

	const reconstructState = (ctx: ExtensionContext) => {
		state = readStateFromBranch(ctx.sessionManager.getBranch());
		updateUi(ctx, state);
	};

	const resetRuntimeState = (ctx: ExtensionContext) => {
		state = emptyState();
		clearUi(ctx);
	};

	const runSerialized = async <T>(operation: () => Promise<T> | T): Promise<T> => {
		const next = mutationQueue.then(operation);
		mutationQueue = next.then(() => undefined, () => undefined);
		return next;
	};

	const mutateState = async <T>(ctx: ExtensionContext | undefined, operation: (draft: StashState) => T): Promise<T> =>
		runSerialized(async () => {
			const draft = cloneState(state);
			const result = operation(draft);
			state = draft;
			persistState();
			if (ctx) updateUi(ctx, state);
			return result;
		});

	const releaseToEditor = async (ctx: ExtensionContext, id: number) => {
		if (!ctx.hasUI) throw new Error("Stash apply requires interactive mode");
		const existing = normalizeContent(ctx.ui.getEditorText());
		if (existing.length > 0) throw new Error("Editor is not empty");
		const removed = await mutateState(ctx, (draft) => removeItem(draft, id));
		ctx.ui.setEditorText(removed.item.content);
		ctx.ui.notify(`Loaded stash #${removed.item.id} into the editor`, "info");
	};

	const sendNow = async (ctx: ExtensionContext, id: number, options: { requireIdle?: boolean } = {}) => {
		if (!ctx.hasUI) throw new Error("Stash send requires interactive mode");
		if (options.requireIdle !== false && !ctx.isIdle()) {
			throw new Error("Agent is busy; stash send only works when idle");
		}
		const existing = normalizeContent(ctx.ui.getEditorText());
		if (existing.length > 0) throw new Error("Editor is not empty");
		const removed = await mutateState(ctx, (draft) => removeItem(draft, id));
		try {
			pi.sendUserMessage(removed.item.content);
			ctx.ui.notify(`Sent stash #${removed.item.id}`, "info");
		} catch (error) {
			await mutateState(ctx, (draft) => {
				insertItem(draft, removed.index, removed.item);
			});
			throw error;
		}
	};

	const releaseHeadIfReady = async (ctx: ExtensionContext, messages: AgentMessage[]) => {
		if (!ctx.hasUI) return;
		if (state.items.length === 0) return;
		const head = state.items[0];
		if (!head || head.mode === "manual") return;
		if (normalizeContent(ctx.ui.getEditorText()).length > 0) return;
		const classification = classifyAgentEndState(messages as AgentMessage[], { hasPendingMessages: ctx.hasPendingMessages() });
		if (classification.kind !== "ready") return;
		if (head.mode === "draft") {
			await releaseToEditor(ctx, head.id);
			return;
		}
		await sendNow(ctx, head.id, { requireIdle: false });
	};

	const showPicker = async (ctx: ExtensionCommandContext): Promise<string | null> => {
		const items: SelectItem[] = [{ value: "add", label: "+ Add stashed prompt", description: "Save a prompt for later release" }];
		for (const item of state.items) {
			items.push({
				value: `item:${item.id}`,
				label: `${modeEmoji(item.mode)} ${formatItemLabel(item)}`,
				description: item.mode,
			});
		}
		items.push({ value: "close", label: "Close", description: "Exit stash editor" });
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Stash")), 1, 0));
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

	const showItemActions = async (ctx: ExtensionCommandContext, item: StashItem): Promise<string | undefined> => {
		return ctx.ui.select(`Stash #${item.id}`, [
			"Edit prompt",
			"Set manual",
			"Set draft",
			"Set send",
			"Apply now",
			"Send now",
			"Move up",
			"Move down",
			"Drop",
			"Back",
		]);
	};

	const openStashUi = async (ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) {
			sendSnapshotMessage(pi, state);
			return;
		}
		while (true) {
			const picked = await showPicker(ctx);
			if (!picked || picked === "close") return;
			if (picked === "add") {
				const content = await promptForContent(ctx, "Stash prompt");
				if (!content) continue;
				const mode = await pickMode(ctx, "manual");
				if (!mode) continue;
				const item = await mutateState(ctx, (draft) => createItem(draft, content, mode));
				ctx.ui.notify(`Stashed prompt #${item.id} (${item.mode})`, "info");
				continue;
			}
			if (!picked.startsWith("item:")) continue;
			const id = Number(picked.slice(5));
			const item = findItem(state, id);
			if (!item) continue;
			const action = await showItemActions(ctx, item);
			if (!action || action === "Back") continue;
			if (action === "Edit prompt") {
				const content = await promptForContent(ctx, `Edit stash #${id}`, item.content);
				if (!content) continue;
				await mutateState(ctx, (draft) => updateItemContent(draft, id, content));
				continue;
			}
			if (action === "Apply now") {
				try {
					await releaseToEditor(ctx, id);
					return;
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					continue;
				}
			}
			if (action === "Send now") {
				try {
					await sendNow(ctx, id);
					return;
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					continue;
				}
			}
			if (action === "Drop") {
				await mutateState(ctx, (draft) => removeItem(draft, id));
				continue;
			}
			await mutateState(ctx, (draft) => {
				if (action === "Set manual") setItemMode(draft, id, "manual");
				else if (action === "Set draft") setItemMode(draft, id, "draft");
				else if (action === "Set send") setItemMode(draft, id, "send");
				else if (action === "Move up") moveItem(draft, id, "up");
				else if (action === "Move down") moveItem(draft, id, "down");
			});
		}
	};

	const stashCurrentEditorText = async (ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("Stash shortcuts require interactive mode", "warning");
			return;
		}
		const current = ctx.ui.getEditorText();
		const prefill = normalizeContent(current).length > 0 ? current : "";
		const content = prefill || (await promptForContent(ctx, "Stash prompt", ""));
		if (!content) return;
		const mode = await pickMode(ctx, "manual");
		if (!mode) return;
		const item = await mutateState(ctx, (draft) => createItem(draft, content, mode));
		if (prefill) ctx.ui.setEditorText("");
		ctx.ui.notify(`Stashed prompt #${item.id} (${item.mode})`, "info");
	};

	pi.registerMessageRenderer(SNAPSHOT_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as StashSnapshotMessageDetails | undefined;
		const box = new Container();
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		box.addChild(new Text(theme.fg("accent", theme.bold("Stash")), 1, 0));
		box.addChild(new Text(options.expanded ? String(message.content) : details?.preview ?? String(message.content), 1, 0));
		box.addChild(new Text(theme.fg("dim", options.expanded ? "Saved prompts" : "Expand for full stash contents"), 1, 0));
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return box;
	});

	pi.registerCommand("stash", {
		description: "Manage deferred prompts (usage: /stash [add|edit|mode|apply|send|drop|move|list])",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await openStashUi(ctx);
				return;
			}
			const [command, ...rest] = trimmed.split(/\s+/);
			try {
				if (command === "add") {
					let mode: StashMode = "manual";
					let text = rest.join(" ").trim();
					if (rest[0] === "manual" || rest[0] === "draft" || rest[0] === "send") {
						mode = rest[0];
						text = rest.slice(1).join(" ").trim();
					}
					let content = text;
					if (!content) {
						content = (await promptForContent(ctx, "Stash prompt")) || "";
					}
					if (!content) throw new Error("Usage: /stash add [manual|draft|send] <text>");
					if (!text && ctx.hasUI) {
						const picked = await pickMode(ctx, mode);
						if (!picked) return;
						mode = picked;
					}
					const item = await mutateState(ctx, (draft) => createItem(draft, content, mode));
					ctx.ui.notify(`Stashed prompt #${item.id} (${item.mode})`, "info");
					return;
				}
				if (command === "edit") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /stash edit <id> <text>");
					let content = rest.slice(1).join(" ").trim();
					if (!content) {
						const currentItem = findItem(state, id);
						if (!currentItem) throw new Error(`Stash item #${id} not found`);
						content = (await promptForContent(ctx, `Edit stash #${id}`, currentItem.content)) || "";
					}
					if (!content) throw new Error("Usage: /stash edit <id> <text>");
					await mutateState(ctx, (draft) => updateItemContent(draft, id, content));
					return;
				}
				if (command === "mode") {
					const id = Number(rest[0]);
					let mode = rest[1] as StashMode | undefined;
					if (!Number.isInteger(id)) throw new Error("Usage: /stash mode <id> <manual|draft|send>");
					if (mode !== "manual" && mode !== "draft" && mode !== "send") {
						const currentItem = findItem(state, id);
						if (!currentItem || !ctx.hasUI) throw new Error("Usage: /stash mode <id> <manual|draft|send>");
						mode = await pickMode(ctx, currentItem.mode);
						if (!mode) return;
					}
					await mutateState(ctx, (draft) => setItemMode(draft, id, mode));
					return;
				}
				if (command === "apply") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /stash apply <id>");
					await releaseToEditor(ctx, id);
					return;
				}
				if (command === "send") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /stash send <id>");
					await sendNow(ctx, id);
					return;
				}
				if (command === "drop") {
					const id = Number(rest[0]);
					if (!Number.isInteger(id)) throw new Error("Usage: /stash drop <id>");
					await mutateState(ctx, (draft) => removeItem(draft, id));
					return;
				}
				if (command === "move") {
					const id = Number(rest[0]);
					const direction = rest[1] as MoveDirection | undefined;
					if (!Number.isInteger(id) || (direction !== "up" && direction !== "down")) {
						throw new Error("Usage: /stash move <id> <up|down>");
					}
					await mutateState(ctx, (draft) => moveItem(draft, id, direction));
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

	pi.registerShortcut(Key.ctrlAlt("s"), {
		description: "Stash current editor text or open the stash editor",
		handler: async (ctx) => {
			await stashCurrentEditorText(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Open the stash editor",
		handler: async (ctx) => {
			await openStashUi(ctx);
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

	pi.on("agent_end", async (event, ctx) => {
		await releaseHeadIfReady(ctx, event.messages);
	});
}

export default stashExtension;
