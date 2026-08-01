/**
 * Status bus: the single channel through which pi-tools extensions publish
 * short footer statuses. The statusline extension is the ONLY footer
 * compositor (it calls ctx.ui.setFooter); every other extension publishes
 * here instead of touching the footer directly. The statusline renders all
 * published statuses on a second footer line, ordered by `order` then id.
 *
 * This is an in-process module-level registry: all extensions of one Pi
 * session share one module instance, so no IPC or persistence is needed.
 * Statuses are ephemeral UI state — durable state (e.g. review-loop phase)
 * must be persisted by the owning extension itself, not here.
 */

type StatusTone = "info" | "warn" | "error";

export type ExtensionStatus = {
	/** Stable identifier, e.g. "review-loop", "usage-guard". One slot per id. */
	id: string;
	/** Short single-line text; the compositor truncates to terminal width. */
	text: string;
	tone: StatusTone;
	/** Lower renders first. Defaults to 100. */
	order: number;
	updatedAt: number;
};

type Listener = () => void;

/**
 * Pi loads every extension through its own jiti instance with module caching
 * disabled, so a plain module-level Map would give each extension a private
 * copy and publishes would never reach the statusline compositor. Anchoring
 * the registry on globalThis under a well-known symbol makes all extension
 * module instances of one Pi process share the same state.
 */
type BusState = {
	statuses: Map<string, ExtensionStatus>;
	listeners: Set<Listener>;
};

const BUS_KEY = Symbol.for("pi-tools.status-bus.v1");

function busState(): BusState {
	const host = globalThis as { [BUS_KEY]?: BusState };
	host[BUS_KEY] ??= { statuses: new Map(), listeners: new Set() };
	return host[BUS_KEY];
}

function emit(): void {
	for (const listener of busState().listeners) {
		try {
			listener();
		} catch {
			// A broken listener must never break another extension's publish.
		}
	}
}

export function setExtensionStatus(id: string, text: string, options?: { tone?: StatusTone; order?: number }): void {
	busState().statuses.set(id, {
		id,
		text,
		tone: options?.tone ?? "info",
		order: options?.order ?? 100,
		updatedAt: Date.now(),
	});
	emit();
}

export function clearExtensionStatus(id: string): void {
	if (busState().statuses.delete(id)) emit();
}

/** Snapshot ordered by `order`, then id for stable rendering. */
export function getExtensionStatuses(): ExtensionStatus[] {
	return [...busState().statuses.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onStatusChange(listener: Listener): () => void {
	const { listeners } = busState();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test helper: reset all bus state. */
export function resetStatusBusForTest(): void {
	busState().statuses.clear();
	busState().listeners.clear();
}
