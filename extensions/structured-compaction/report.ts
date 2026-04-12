import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { computeStructuredCompactionMetrics, type StructuredCompactionMetrics } from "./metrics.ts";
import type { StructuredCompactionArtifact } from "./types.ts";

export interface StructuredCompactionReportItem {
	entry: CompactionEntry;
	artifact?: StructuredCompactionArtifact;
	metrics: StructuredCompactionMetrics;
	backendKind: string;
	providerBefore?: { total: number; input: number; cacheRead: number };
	providerAfter?: { total: number; input: number; cacheRead: number };
	lastAssistantBeforeText?: string;
	firstAssistantAfterText?: string;
}

export interface StructuredCompactionReportFormatOptions {
	sessionFile?: string;
	latestOnly?: boolean;
}

const formatNumber = (value: number): string => value.toLocaleString("en-US");

const selectStructuredCompactionReportItems = (
	items: StructuredCompactionReportItem[],
	options?: StructuredCompactionReportFormatOptions,
): StructuredCompactionReportItem[] => (options?.latestOnly ? [items[items.length - 1]] : items);

const formatSavedSummary = (item: StructuredCompactionReportItem): string =>
	`${formatNumber(item.metrics.savedHeuristic)} (${item.metrics.reductionPercent.toFixed(1)}%)`;

const formatReportListLine = (item: StructuredCompactionReportItem): string =>
	`- ${item.entry.id} | ${item.backendKind} | saved ${formatSavedSummary(item)} | messages ${formatNumber(item.metrics.beforeMessageCount)} -> ${formatNumber(item.metrics.afterMessageCount)}`;

const getPathEntries = (entries: SessionEntry[], leafId?: string | null): SessionEntry[] => {
	if (leafId === null) return [];
	if (!leafId) return entries;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current = byId.get(leafId);
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
};

const assistantText = (entry: SessionEntry): string | undefined => {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	return entry.message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
};

const isStructuredArtifact = (details: unknown): details is StructuredCompactionArtifact =>
	typeof details === "object" && details !== null && (details as { kind?: string }).kind === "structured-replacement-history";

const replacementMessagesFromArtifact = (artifact: StructuredCompactionArtifact | undefined): AgentMessage[] | undefined =>
	artifact?.replacementMessages;

export const buildStructuredCompactionReport = (
	entries: SessionEntry[],
	leafId?: string | null,
): StructuredCompactionReportItem[] => {
	const pathEntries = getPathEntries(entries, leafId);
	return pathEntries
		.filter((entry): entry is CompactionEntry => entry.type === "compaction")
		.map((entry) => {
			const artifact = isStructuredArtifact(entry.details) ? entry.details : undefined;
			const metrics = artifact?.metrics ??
				computeStructuredCompactionMetrics(pathEntries, entry, replacementMessagesFromArtifact(artifact) ?? []);
			const compactionIndex = pathEntries.findIndex((pathEntry) => pathEntry.id === entry.id);
			const beforeEntries = pathEntries.slice(0, compactionIndex);
			const afterEntries = pathEntries.slice(compactionIndex + 1);
			const lastAssistantBefore = [...beforeEntries]
				.reverse()
				.find((pathEntry) => pathEntry.type === "message" && pathEntry.message.role === "assistant");
			const firstAssistantAfter = afterEntries.find(
				(pathEntry) => pathEntry.type === "message" && pathEntry.message.role === "assistant",
			);
			return {
				entry,
				artifact,
				metrics,
				backendKind: artifact?.backend.kind ?? "unknown",
				providerBefore:
					lastAssistantBefore?.type === "message" && lastAssistantBefore.message.role === "assistant"
						? {
							total: lastAssistantBefore.message.usage.totalTokens,
							input: lastAssistantBefore.message.usage.input,
							cacheRead: lastAssistantBefore.message.usage.cacheRead,
						}
						: undefined,
				providerAfter:
					firstAssistantAfter?.type === "message" && firstAssistantAfter.message.role === "assistant"
						? {
							total: firstAssistantAfter.message.usage.totalTokens,
							input: firstAssistantAfter.message.usage.input,
							cacheRead: firstAssistantAfter.message.usage.cacheRead,
						}
						: undefined,
				lastAssistantBeforeText: lastAssistantBefore ? assistantText(lastAssistantBefore) : undefined,
				firstAssistantAfterText: firstAssistantAfter ? assistantText(firstAssistantAfter) : undefined,
			};
		});
};

export const formatStructuredCompactionReportItem = (item: StructuredCompactionReportItem): string => {
	const lines = [
		`Compaction ${item.entry.id}`,
		`- backend: ${item.backendKind}`,
		`- timestamp: ${item.entry.timestamp}`,
		`- pi before: ${formatNumber(item.entry.tokensBefore)} tokens`,
		`- local heuristic: ${formatNumber(item.metrics.beforeHeuristic)} -> ${formatNumber(item.metrics.afterHeuristic)} (saved ${formatNumber(item.metrics.savedHeuristic)}, ${item.metrics.reductionPercent.toFixed(1)}%)`,
		`- messages: ${formatNumber(item.metrics.beforeMessageCount)} -> ${formatNumber(item.metrics.afterMessageCount)}`,
	];
	if (item.providerBefore) {
		lines.push(
			`- provider before: total=${formatNumber(item.providerBefore.total)} input=${formatNumber(item.providerBefore.input)} cacheRead=${formatNumber(item.providerBefore.cacheRead)}`,
		);
	}
	if (item.providerAfter) {
		lines.push(
			`- provider after: total=${formatNumber(item.providerAfter.total)} input=${formatNumber(item.providerAfter.input)} cacheRead=${formatNumber(item.providerAfter.cacheRead)}`,
		);
	}
	if (item.lastAssistantBeforeText) {
		lines.push(`- last assistant before: ${JSON.stringify(item.lastAssistantBeforeText.slice(0, 90))}`);
	}
	if (item.firstAssistantAfterText) {
		lines.push(`- first assistant after: ${JSON.stringify(item.firstAssistantAfterText.slice(0, 90))}`);
	}
	return lines.join("\n");
};

export const formatStructuredCompactionReportPreview = (
	items: StructuredCompactionReportItem[],
	options?: StructuredCompactionReportFormatOptions,
): string => {
	if (items.length === 0) {
		return options?.sessionFile
			? `No compactions found for ${options.sessionFile}.`
			: "No compactions found on the current session branch.";
	}
	const selected = selectStructuredCompactionReportItems(items, options);
	const header = options?.sessionFile ? [`Session: ${options.sessionFile}`, ""] : [];
	if (options?.latestOnly) {
		const item = selected[0];
		return [
			...header,
			`Latest compaction${items.length > 1 ? ` (1 of ${items.length})` : ""}`,
			`- id: ${item.entry.id}`,
			`- backend: ${item.backendKind}`,
			`- saved: ${formatSavedSummary(item)}`,
			`- messages: ${formatNumber(item.metrics.beforeMessageCount)} -> ${formatNumber(item.metrics.afterMessageCount)}`,
		].join("\n");
	}
	return [...header, `Compactions on current branch: ${selected.length}`, ...selected.map(formatReportListLine)].join("\n");
};

export const formatStructuredCompactionReport = (
	items: StructuredCompactionReportItem[],
	options?: StructuredCompactionReportFormatOptions,
): string => {
	if (items.length === 0) {
		return options?.sessionFile
			? `No compactions found for ${options.sessionFile}.`
			: "No compactions found on the current session branch.";
	}
	const selected = selectStructuredCompactionReportItems(items, options);
	const header = options?.sessionFile ? [`Session: ${options.sessionFile}`, ""] : [];
	return [...header, ...selected.map(formatStructuredCompactionReportItem)].join("\n\n");
};
