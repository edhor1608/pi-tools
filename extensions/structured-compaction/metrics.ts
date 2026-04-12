import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "@mariozechner/pi-coding-agent";
import type { StructuredCompactionArtifact } from "./types.ts";

export interface StructuredCompactionMetrics {
	beforeTokens: number;
	beforeHeuristic: number;
	afterHeuristic: number;
	savedHeuristic: number;
	reductionPercent: number;
	beforeMessageCount: number;
	afterMessageCount: number;
}

const estimateMessageTokens = (message: AgentMessage): number => {
	let chars = 0;
	switch (message.role) {
		case "user": {
			const { content } = message;
			if (typeof content === "string") {
				chars = content.length;
			} else {
				for (const block of content) {
					if (block.type === "text") chars += block.text.length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			return Math.ceil(chars / 4);
		}
		case "toolResult":
		case "custom": {
			if (typeof message.content === "string") {
				chars = message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text") chars += block.text.length;
					else if (block.type === "image") chars += 4800;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}
};

const sumEstimatedTokens = (messages: AgentMessage[]): number =>
	messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

const replaceCompactionSummaryMessage = (
	messages: AgentMessage[],
	replacementMessages: AgentMessage[],
): AgentMessage[] => {
	const index = messages.findIndex((message) => message.role === "compactionSummary");
	if (index === -1) return messages;
	return [...messages.slice(0, index), ...replacementMessages, ...messages.slice(index + 1)];
};

export const computeStructuredCompactionMetrics = (
	branchEntries: SessionEntry[],
	compactionEntry: CompactionEntry,
	replacementMessages: AgentMessage[],
): StructuredCompactionMetrics => {
	const beforeMessages = buildSessionContext(branchEntries, compactionEntry.parentId).messages;
	const afterMessages = replaceCompactionSummaryMessage(
		buildSessionContext([...branchEntries, compactionEntry], compactionEntry.id).messages,
		replacementMessages,
	);
	const beforeHeuristic = sumEstimatedTokens(beforeMessages);
	const afterHeuristic = sumEstimatedTokens(afterMessages);
	const savedHeuristic = Math.max(0, beforeHeuristic - afterHeuristic);
	const reductionPercent = beforeHeuristic > 0 ? (savedHeuristic / beforeHeuristic) * 100 : 0;
	return {
		beforeTokens: compactionEntry.tokensBefore,
		beforeHeuristic,
		afterHeuristic,
		savedHeuristic,
		reductionPercent: Number(reductionPercent.toFixed(1)),
		beforeMessageCount: beforeMessages.length,
		afterMessageCount: afterMessages.length,
	};
};

const formatNumber = (value: number): string => value.toLocaleString("en-US");

export const formatStructuredCompactionStats = (
	backendKind: StructuredCompactionArtifact["backend"]["kind"],
	metrics: StructuredCompactionMetrics,
): string =>
	[
		"Structured compaction stats:",
		`- backend: ${backendKind}`,
		`- before: ${formatNumber(metrics.beforeTokens)} tokens`,
		`- after: ~${formatNumber(metrics.afterHeuristic)} tokens`,
		`- saved: ~${formatNumber(metrics.savedHeuristic)} tokens (${metrics.reductionPercent.toFixed(1)}%)`,
		`- messages: ${formatNumber(metrics.beforeMessageCount)} -> ${formatNumber(metrics.afterMessageCount)}`,
	].join("\n");
