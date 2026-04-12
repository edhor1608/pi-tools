import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type StructuredCompactionBackendKind = "auto" | "pi-model" | "codex-remote";
export type StructuredCompactionRendererKind = "compaction-summary" | "custom-message";
export type StructuredCompactionReasoning = "off" | "low" | "medium" | "high";
export type StructuredRemoteEndpointMode = "auto" | "responses" | "codex-responses";
export type StructuredRemoteApi = "openai-responses" | "openai-codex-responses";
export type StructuredRemoteAuthMode = "api-key" | "codex-jwt";

export interface StructuredCompactionConfig {
	enabled: boolean;
	backend: {
		kind: StructuredCompactionBackendKind;
		model: string | null;
		fallbackToActiveModel: boolean;
		maxTokens: number;
		reasoning: StructuredCompactionReasoning;
		remote: {
			endpointMode: StructuredRemoteEndpointMode;
			originator: string;
		};
	};
	renderer: {
		kind: StructuredCompactionRendererKind;
		customType: string;
		display: boolean;
	};
	prompt: {
		systemPath?: string;
		compactPath?: string;
	};
	debug: {
		notify: boolean;
	};
}

export interface StructuredCompactionPrompts {
	system: string;
	systemPath?: string;
	compact: string;
	compactPath?: string;
}

export interface StructuredRemoteReplacement {
	strategy: "responses-compact";
	api: StructuredRemoteApi;
	model: string;
	endpoint: string;
	authMode: StructuredRemoteAuthMode;
	sessionId: string;
	promptCacheKey: string;
	outputItems: JsonValue[];
}

export interface StructuredCompactionMetrics {
	beforeTokens: number;
	beforeHeuristic: number;
	afterHeuristic: number;
	savedHeuristic: number;
	reductionPercent: number;
	beforeMessageCount: number;
	afterMessageCount: number;
}

export interface StructuredCompactionArtifact {
	version: 1;
	kind: "structured-replacement-history";
	summary: string;
	displaySummary?: string;
	metrics?: StructuredCompactionMetrics;
	replacementMessages: AgentMessage[];
	readFiles: string[];
	modifiedFiles: string[];
	backend: {
		kind: StructuredCompactionBackendKind;
		model?: string;
	};
	renderer: {
		kind: StructuredCompactionRendererKind;
	};
	source: {
		firstKeptEntryId: string;
		isSplitTurn: boolean;
		tokensBefore: number;
		compactedMessageCount: number;
		turnPrefixMessageCount: number;
		previousArtifactVersion?: number;
	};
	remoteReplacement?: StructuredRemoteReplacement;
	metadata?: Record<string, JsonValue>;
}

export interface StructuredCompactionInput {
	firstKeptEntryId: string;
	isSplitTurn: boolean;
	tokensBefore: number;
	customInstructions?: string;
	previousSummary?: string;
	previousArtifact?: StructuredCompactionArtifact;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionBackendOutput {
	kind: Exclude<StructuredCompactionBackendKind, "auto">;
	summary: string;
	displaySummary?: string;
	metadata?: Record<string, JsonValue>;
	backendModel?: string;
	remoteReplacement?: StructuredRemoteReplacement;
}
