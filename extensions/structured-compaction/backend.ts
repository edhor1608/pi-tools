import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { complete } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	convertAgentMessagesToResponsesInput,
	isCodexRemoteCompatibleModel,
	normalizeRemoteOutputItemsForInput,
	requestCodexRemoteCompaction,
} from "./responses-adapter.ts";
import type {
	CompactionBackendOutput,
	StructuredCompactionConfig,
	StructuredCompactionInput,
	StructuredCompactionPrompts,
} from "./types.ts";

interface BackendRuntime {
	ctx: ExtensionContext;
	config: StructuredCompactionConfig;
	prompts: StructuredCompactionPrompts;
	signal: AbortSignal;
}

interface CompactionBackend {
	kind: Exclude<StructuredCompactionConfig["backend"]["kind"], "auto">;
	run(input: StructuredCompactionInput, runtime: BackendRuntime): Promise<CompactionBackendOutput>;
}

class RemoteCompactionUnavailableError extends Error {}

const MODEL_REF_SEPARATOR = "/";

const serializeMessages = (messages: AgentMessage[]): string | undefined => {
	if (messages.length === 0) return undefined;
	return serializeConversation(convertToLlm(messages));
};

const xmlBlock = (name: string, content: string | undefined): string | undefined => {
	if (!content) return undefined;
	return `<${name}>\n${content}\n</${name}>`;
};

const resolveConfiguredModel = (ctx: ExtensionContext, modelRef: string): Model<any> | undefined => {
	const separator = modelRef.indexOf(MODEL_REF_SEPARATOR);
	if (separator <= 0 || separator === modelRef.length - 1) return undefined;
	const provider = modelRef.slice(0, separator);
	const modelId = modelRef.slice(separator + 1);
	return ctx.modelRegistry.find(provider, modelId);
};

const resolveSummaryModelAndAuth = async (
	ctx: ExtensionContext,
	config: StructuredCompactionConfig,
): Promise<{ model: Model<any>; modelRef: string; apiKey: string; headers?: Record<string, string> }> => {
	const attempts: Array<{ model: Model<any>; modelRef: string }> = [];
	if (config.backend.model) {
		const configuredModel = resolveConfiguredModel(ctx, config.backend.model);
		if (!configuredModel) {
			throw new Error(`Configured compaction model not found: ${config.backend.model}`);
		}
		attempts.push({ model: configuredModel, modelRef: config.backend.model });
	}
	if (config.backend.fallbackToActiveModel && ctx.model) {
		const activeModelRef = `${ctx.model.provider}/${ctx.model.id}`;
		if (!attempts.some((attempt) => attempt.modelRef === activeModelRef)) {
			attempts.push({ model: ctx.model, modelRef: activeModelRef });
		}
	}
	for (const attempt of attempts) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(attempt.model);
		if (auth.ok && auth.apiKey) {
			return {
				model: attempt.model,
				modelRef: attempt.modelRef,
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}
	throw new Error("No authenticated summary model available");
};

const runPiModelSummary = async (
	input: StructuredCompactionInput,
	runtime: BackendRuntime,
): Promise<CompactionBackendOutput> => {
	const { ctx, config, prompts, signal } = runtime;
	const { model, modelRef, apiKey, headers } = await resolveSummaryModelAndAuth(ctx, config);

	const previousReplacementHistory = input.previousArtifact
		? serializeMessages(input.previousArtifact.replacementMessages)
		: undefined;
	const previousSummary =
		input.previousSummary && input.previousSummary !== input.previousArtifact?.summary ? input.previousSummary : undefined;
	const conversation = serializeMessages(input.messagesToSummarize) ?? "(none)";
	const splitTurnPrefix = serializeMessages(input.turnPrefixMessages);
	const fileContext = [
		input.readFiles.length > 0 ? `Read files:\n${input.readFiles.join("\n")}` : undefined,
		input.modifiedFiles.length > 0 ? `Modified files:\n${input.modifiedFiles.join("\n")}` : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join("\n\n");

	const sections = [
		xmlBlock(
			"compaction-metadata",
			[
				`firstKeptEntryId: ${input.firstKeptEntryId}`,
				`isSplitTurn: ${String(input.isSplitTurn)}`,
				`tokensBefore: ${input.tokensBefore}`,
			].join("\n"),
		),
		xmlBlock("previous-replacement-history", previousReplacementHistory),
		xmlBlock("previous-summary", previousSummary),
		xmlBlock("conversation", conversation),
		xmlBlock("split-turn-prefix", splitTurnPrefix),
		xmlBlock("file-context", fileContext || undefined),
		xmlBlock("custom-instructions", input.customInstructions?.trim() || undefined),
		prompts.compact,
	].filter((value): value is string => value !== undefined);

	const response = await complete(
		model,
		{
			systemPrompt: prompts.system,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: sections.join("\n\n") }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			headers,
			maxTokens: config.backend.maxTokens,
			signal,
			...(config.backend.reasoning === "off" ? {} : { reasoning: config.backend.reasoning }),
		},
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Compaction summary backend returned an error");
	}

	const summary = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!summary) {
		throw new Error("Compaction summary backend returned an empty summary");
	}

	return {
		kind: "pi-model",
		summary,
		backendModel: modelRef,
		metadata: {
			promptSystemPath: prompts.systemPath ?? null,
			promptCompactPath: prompts.compactPath ?? null,
		},
	};
};

const piModelBackend: CompactionBackend = {
	kind: "pi-model",
	run(input, runtime) {
		return runPiModelSummary(input, runtime);
	},
};

const codexRemoteBackend: CompactionBackend = {
	kind: "codex-remote",
	async run(input, runtime) {
		const { ctx, config, signal } = runtime;
		const model = ctx.model;
		if (!model || !isCodexRemoteCompatibleModel(model)) {
			throw new RemoteCompactionUnavailableError("Current model is not compatible with codex-remote compaction");
		}
		if (
			input.previousArtifact?.remoteReplacement &&
			input.previousArtifact.remoteReplacement.api !== model.api
		) {
			throw new RemoteCompactionUnavailableError("Previous remote replacement history is not compatible with the current model API");
		}

		const summaryResult = await runPiModelSummary(input, runtime);
		const compactedMessages = [...input.messagesToSummarize, ...input.turnPrefixMessages];
		const freshInputItems = await convertAgentMessagesToResponsesInput(model, compactedMessages);
		const previousOutputItems = input.previousArtifact?.remoteReplacement
			? normalizeRemoteOutputItemsForInput(input.previousArtifact.remoteReplacement.outputItems)
			: [];
		const inputItems = [...previousOutputItems, ...freshInputItems];
		if (inputItems.length === 0) {
			throw new RemoteCompactionUnavailableError("No compatible messages to send to codex-remote compaction");
		}

		const remoteReplacement = await requestCodexRemoteCompaction(
			ctx,
			config,
			model,
			ctx.getSystemPrompt(),
			inputItems,
			ctx.sessionManager.getSessionId(),
			signal,
		);

		return {
			kind: "codex-remote",
			summary: summaryResult.summary,
			backendModel: `${model.provider}/${model.id}`,
			remoteReplacement,
			metadata: {
				...(summaryResult.metadata || {}),
				remoteApi: remoteReplacement.api,
				remoteEndpoint: remoteReplacement.endpoint,
				remoteAuthMode: remoteReplacement.authMode,
				remoteOutputItems: remoteReplacement.outputItems.length,
			},
		};
	},
};

const BACKENDS: Record<CompactionBackend["kind"], CompactionBackend> = {
	[piModelBackend.kind]: piModelBackend,
	[codexRemoteBackend.kind]: codexRemoteBackend,
};

export const runStructuredCompactionBackend = async (
	input: StructuredCompactionInput,
	runtime: BackendRuntime,
): Promise<CompactionBackendOutput> => {
	if (runtime.config.backend.kind === "auto") {
		try {
			return await codexRemoteBackend.run(input, runtime);
		} catch (error) {
			if (error instanceof RemoteCompactionUnavailableError || error instanceof Error) {
				return piModelBackend.run(input, runtime);
			}
			throw error;
		}
	}
	const backend = BACKENDS[runtime.config.backend.kind];
	if (!backend) {
		throw new Error(`Unsupported structured compaction backend: ${runtime.config.backend.kind}`);
	}
	return backend.run(input, runtime);
};
