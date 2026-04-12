import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { createStructuredCompactionArtifact, computeFileLists, getLatestStructuredCompactionArtifact } from "./artifact.ts";
import { runStructuredCompactionBackend } from "./backend.ts";
import { loadStructuredCompactionConfig, loadStructuredCompactionPrompts } from "./config.ts";
import { computeStructuredCompactionMetrics, formatStructuredCompactionStats } from "./metrics.ts";
import { buildStructuredCompactionReport, formatStructuredCompactionReport } from "./report.ts";
import { convertAgentMessagesToResponsesInput, normalizeRemoteOutputItemsForInput } from "./responses-adapter.ts";
import { renderStructuredReplacementMessages } from "./renderer.ts";
import type { StructuredCompactionInput } from "./types.ts";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const notifyWarning = (enabled: boolean, notify: (message: string, type?: "info" | "warning" | "error") => void, message: string) => {
	if (enabled) notify(message, "warning");
};

export default function structuredCompactionExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer("structured-compaction-report", (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const title = theme.fg("accent", "Compaction Report");
		box.addChild(new Text(`${title}\n${String(message.content)}`, 0, 0));
		return box;
	});

	pi.registerCommand("compaction-report", {
		description: "Show the latest structured compaction report for this session",
		handler: async (_args, ctx) => {
			const items = buildStructuredCompactionReport(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			if (items.length === 0) {
				ctx.ui.notify("No compactions found on the current branch", "info");
				return;
			}
			pi.sendMessage({
				customType: "structured-compaction-report",
				content: formatStructuredCompactionReport(items, {
					sessionFile: ctx.sessionManager.getSessionFile(),
					latestOnly: true,
				}),
				display: true,
				details: { count: items.length, timestamp: Date.now() },
			});
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const config = loadStructuredCompactionConfig(ctx.cwd);
		if (!config.enabled) return undefined;

		const previousStructuredCompaction = getLatestStructuredCompactionArtifact(event.branchEntries);
		const { readFiles, modifiedFiles } = computeFileLists(event.preparation.fileOps);
		const input: StructuredCompactionInput = {
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			isSplitTurn: event.preparation.isSplitTurn,
			tokensBefore: event.preparation.tokensBefore,
			customInstructions: event.customInstructions,
			previousSummary: event.preparation.previousSummary,
			previousArtifact: previousStructuredCompaction?.artifact,
			messagesToSummarize: event.preparation.messagesToSummarize,
			turnPrefixMessages: event.preparation.turnPrefixMessages,
			readFiles,
			modifiedFiles,
		};

		try {
			const prompts = loadStructuredCompactionPrompts(ctx.cwd, config);
			const backendOutput = await runStructuredCompactionBackend(input, {
				ctx,
				config,
				prompts,
				signal: event.signal,
			});
			const provisionalReplacementMessages = renderStructuredReplacementMessages(backendOutput, input, config);
			const provisionalCompaction = {
				type: "compaction",
				id: `${input.firstKeptEntryId}-structured-preview`,
				parentId: event.branchEntries[event.branchEntries.length - 1]?.id ?? input.firstKeptEntryId,
				timestamp: new Date().toISOString(),
				summary: backendOutput.summary,
				firstKeptEntryId: input.firstKeptEntryId,
				tokensBefore: input.tokensBefore,
				details: undefined,
			};
			const metrics = computeStructuredCompactionMetrics(
				event.branchEntries,
				provisionalCompaction,
				provisionalReplacementMessages,
			);
			const displaySummary = `${formatStructuredCompactionStats(backendOutput.kind, metrics)}\n\n${backendOutput.summary}`;
			const replacementMessages = renderStructuredReplacementMessages(
				{ ...backendOutput, displaySummary },
				input,
				config,
			);
			const artifact = createStructuredCompactionArtifact(
				config,
				input,
				backendOutput,
				displaySummary,
				metrics,
				replacementMessages,
			);

			return {
				compaction: {
					summary: displaySummary,
					firstKeptEntryId: input.firstKeptEntryId,
					tokensBefore: input.tokensBefore,
					details: artifact,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifyWarning(config.debug.notify, ctx.ui.notify.bind(ctx.ui), `Structured compaction failed: ${message}`);
			return undefined;
		}
	});

	pi.on("context", (event, ctx) => {
		const config = loadStructuredCompactionConfig(ctx.cwd);
		if (!config.enabled) return undefined;

		const latestStructuredCompaction = getLatestStructuredCompactionArtifact(ctx.sessionManager.getBranch());
		if (!latestStructuredCompaction) return undefined;

		const summaryIndex = event.messages.findIndex((message) => message.role === "compactionSummary");
		if (summaryIndex === -1) return undefined;

		return {
			messages: [
				...event.messages.slice(0, summaryIndex),
				...latestStructuredCompaction.artifact.replacementMessages,
				...event.messages.slice(summaryIndex + 1),
			],
		};
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const config = loadStructuredCompactionConfig(ctx.cwd);
		if (!config.enabled) return undefined;
		const model = ctx.model;
		if (!model) return undefined;

		const latestStructuredCompaction = getLatestStructuredCompactionArtifact(ctx.sessionManager.getBranch());
		const remoteReplacement = latestStructuredCompaction?.artifact.remoteReplacement;
		if (!remoteReplacement) return undefined;
		if (remoteReplacement.api !== model.api) return undefined;
		if (!isObject(event.payload) || !Array.isArray(event.payload.input)) return undefined;

		const localReplacementInput = await convertAgentMessagesToResponsesInput(
			model,
			latestStructuredCompaction.artifact.replacementMessages,
		);
		if (event.payload.input.length < localReplacementInput.length) return undefined;

		return {
			...event.payload,
			input: [
				...normalizeRemoteOutputItemsForInput(remoteReplacement.outputItems),
				...event.payload.input.slice(localReplacementInput.length),
			],
			prompt_cache_key: remoteReplacement.promptCacheKey,
		};
	});
}
