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

export type StatusTone = "info" | "warn" | "error";

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

const statuses = new Map<string, ExtensionStatus>();
const listeners = new Set<Listener>();

function emit(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// A broken listener must never break another extension's publish.
		}
	}
}

export function setExtensionStatus(id: string, text: string, options?: { tone?: StatusTone; order?: number }): void {
	statuses.set(id, {
		id,
		text,
		tone: options?.tone ?? "info",
		order: options?.order ?? 100,
		updatedAt: Date.now(),
	});
	emit();
}

export function clearExtensionStatus(id: string): void {
	if (statuses.delete(id)) emit();
}

/** Snapshot ordered by `order`, then id for stable rendering. */
export function getExtensionStatuses(): ExtensionStatus[] {
	return [...statuses.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onStatusChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test helper: reset all bus state. */
export function resetStatusBusForTest(): void {
	statuses.clear();
	listeners.clear();
}
