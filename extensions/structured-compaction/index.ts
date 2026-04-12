import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { createStructuredCompactionArtifact, computeFileLists, getLatestStructuredCompactionArtifact } from "./artifact.ts";
import { runStructuredCompactionBackend } from "./backend.ts";
import {
	ensureStructuredCompactionDefaults,
	loadStructuredCompactionConfig,
	loadStructuredCompactionPrompts,
} from "./config.ts";
import { computeStructuredCompactionMetrics, formatStructuredCompactionStats } from "./metrics.ts";
import {
	buildStructuredCompactionReport,
	formatStructuredCompactionReport,
	formatStructuredCompactionReportPreview,
} from "./report.ts";
import { convertAgentMessagesToResponsesInput, normalizeRemoteOutputItemsForInput } from "./responses-adapter.ts";
import { renderStructuredReplacementMessages } from "./renderer.ts";
import type { StructuredCompactionInput } from "./types.ts";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const REPORT_MODES = ["latest", "all"] as const;
type StructuredCompactionReportMode = (typeof REPORT_MODES)[number];

interface StructuredCompactionReportMessageDetails {
	count: number;
	mode: StructuredCompactionReportMode;
	preview: string;
	timestamp: number;
}

const notifyWarning = (enabled: boolean, notify: (message: string, type?: "info" | "warning" | "error") => void, message: string) => {
	if (enabled) notify(message, "warning");
};

const parseReportMode = (args: string): StructuredCompactionReportMode | undefined => {
	const trimmed = args.trim();
	if (!trimmed) return "latest";
	return REPORT_MODES.find((mode) => mode === trimmed);
};

const triggerCompaction = async (ctx: ExtensionCommandContext, label: string, customInstructions?: string) => {
	if (ctx.hasUI) {
		ctx.ui.notify(`${label} started`, "info");
	}
	await new Promise<void>((resolve) => {
		ctx.compact({
			customInstructions,
			onComplete: () => {
				if (ctx.hasUI) {
					ctx.ui.notify(`${label} completed`, "info");
				}
				resolve();
			},
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`${label} failed: ${error.message}`, "error");
				}
				resolve();
			},
		});
	});
};

export default function structuredCompactionExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer("structured-compaction-report", (message, options, theme) => {
		const details = message.details as StructuredCompactionReportMessageDetails | undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const modeLabel = details?.mode === "all" ? "All" : "Latest";
		const title = theme.fg("accent", `Compaction Report (${modeLabel})`);
		const body = options.expanded ? String(message.content) : details?.preview ?? String(message.content);
		const hint = theme.fg(
			"dim",
			options.expanded
				? `items: ${details?.count ?? 0}`
				: details?.mode === "all"
					? "Expand for full per-compaction details"
					: "Expand for provider usage and continuity details",
		);
		box.addChild(new Text(`${title}\n${body}\n${hint}`, 0, 0));
		return box;
	});

	pi.on("session_start", async () => {
		await ensureStructuredCompactionDefaults();
	});

	pi.registerCommand("compaction-report", {
		description: "Show structured compaction report (usage: /compaction-report [latest|all])",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			const matches = REPORT_MODES.filter((mode) => mode.startsWith(trimmed));
			return matches.length > 0 ? matches.map((mode) => ({ value: mode, label: mode })) : null;
		},
		handler: async (args, ctx) => {
			const mode = parseReportMode(args);
			if (!mode) {
				ctx.ui.notify("Usage: /compaction-report [latest|all]", "warning");
				return;
			}
			const items = buildStructuredCompactionReport(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			if (items.length === 0) {
				ctx.ui.notify("No compactions found on the current branch", "info");
				return;
			}
			const options = {
				sessionFile: ctx.sessionManager.getSessionFile(),
				latestOnly: mode !== "all",
			};
			pi.sendMessage({
				customType: "structured-compaction-report",
				content: formatStructuredCompactionReport(items, options),
				display: true,
				details: {
					count: items.length,
					mode,
					preview: formatStructuredCompactionReportPreview(items, options),
					timestamp: Date.now(),
				} satisfies StructuredCompactionReportMessageDetails,
			});
		},
	});

	pi.registerCommand("trigger-compact", {
		description: "Trigger compaction immediately (optional instructions)",
		handler: async (args, ctx) => {
			const config = await loadStructuredCompactionConfig(ctx.cwd);
			const instructions = args.trim() || undefined;
			await triggerCompaction(ctx, config.enabled ? "Structured compaction" : "Pi compaction", instructions);
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const config = await loadStructuredCompactionConfig(ctx.cwd);
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
			const prompts = await loadStructuredCompactionPrompts(ctx.cwd, config);
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

	pi.on("context", async (event, ctx) => {
		const config = await loadStructuredCompactionConfig(ctx.cwd);
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
		const config = await loadStructuredCompactionConfig(ctx.cwd);
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
