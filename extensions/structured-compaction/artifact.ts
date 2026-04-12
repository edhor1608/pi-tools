import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { FileOperations } from "@mariozechner/pi-coding-agent";
import type {
	CompactionBackendOutput,
	StructuredCompactionArtifact,
	StructuredCompactionConfig,
	StructuredCompactionInput,
	StructuredRemoteReplacement,
} from "./types.ts";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isAgentMessageArray = (value: unknown): value is AgentMessage[] => Array.isArray(value);

const isStructuredRemoteReplacement = (value: unknown): value is StructuredRemoteReplacement => {
	if (!isObject(value)) return false;
	if (value.strategy !== "responses-compact") return false;
	if (value.api !== "openai-responses" && value.api !== "openai-codex-responses") return false;
	if (typeof value.model !== "string") return false;
	if (typeof value.endpoint !== "string") return false;
	if (value.authMode !== "api-key" && value.authMode !== "codex-jwt") return false;
	if (typeof value.sessionId !== "string") return false;
	if (typeof value.promptCacheKey !== "string") return false;
	if (!Array.isArray(value.outputItems)) return false;
	return true;
};

export const isStructuredCompactionArtifact = (value: unknown): value is StructuredCompactionArtifact => {
	if (!isObject(value)) return false;
	if (value.kind !== "structured-replacement-history") return false;
	if (value.version !== 1) return false;
	if (typeof value.summary !== "string") return false;
	if (value.displaySummary !== undefined && typeof value.displaySummary !== "string") return false;
	if (value.metrics !== undefined && !isObject(value.metrics)) return false;
	if (!isAgentMessageArray(value.replacementMessages)) return false;
	if (!Array.isArray(value.readFiles) || !Array.isArray(value.modifiedFiles)) return false;
	if (value.remoteReplacement !== undefined && !isStructuredRemoteReplacement(value.remoteReplacement)) return false;
	return true;
};

export const getLatestStructuredCompactionArtifact = (
	entries: SessionEntry[],
): { entry: CompactionEntry; artifact: StructuredCompactionArtifact } | undefined => {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		if (!isStructuredCompactionArtifact(entry.details)) return undefined;
		return { entry, artifact: entry.details };
	}
	return undefined;
};

export const computeFileLists = (fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } => {
	const modified = new Set<string>([...fileOps.written, ...fileOps.edited]);
	const readFiles = [...fileOps.read].filter((path) => !modified.has(path)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
};

export const createStructuredCompactionArtifact = (
	config: StructuredCompactionConfig,
	input: StructuredCompactionInput,
	backendOutput: CompactionBackendOutput,
	displaySummary: string,
	metrics: StructuredCompactionArtifact["metrics"],
	replacementMessages: AgentMessage[],
): StructuredCompactionArtifact => ({
	version: 1,
	kind: "structured-replacement-history",
	summary: backendOutput.summary,
	displaySummary,
	metrics,
	replacementMessages,
	readFiles: input.readFiles,
	modifiedFiles: input.modifiedFiles,
	backend: {
		kind: backendOutput.kind,
		model: backendOutput.backendModel,
	},
	renderer: {
		kind: config.renderer.kind,
	},
	source: {
		firstKeptEntryId: input.firstKeptEntryId,
		isSplitTurn: input.isSplitTurn,
		tokensBefore: input.tokensBefore,
		compactedMessageCount: input.messagesToSummarize.length,
		turnPrefixMessageCount: input.turnPrefixMessages.length,
		previousArtifactVersion: input.previousArtifact?.version,
	},
	remoteReplacement: backendOutput.remoteReplacement,
	metadata: backendOutput.metadata,
});
