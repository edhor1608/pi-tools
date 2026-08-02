import type { Api, AssistantMessage, ProviderId } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	SUMMARY_LINE_CAP,
	SUMMARY_TOOLS_PER_TURN,
	capText,
	compactInline,
	isObject,
	type NormalizedConversation,
	type NormalizedToolCall,
} from "./types.ts";

export interface ExternalImportProvenance {
	version: 1;
	source: NormalizedConversation["source"];
	sourceSessionId: string;
	sourcePath: string;
	sourceCwd?: string;
	sourceModel?: string;
	importedAt: number;
	skippedRecords: number;
}

export interface ExternalImportTools {
	version: 1;
	turnIndex: number;
	toolCalls: NormalizedToolCall[];
}

export interface ImportResult {
	messageCount: number;
	toolCallCount: number;
}

export interface ModelIdentity {
	api: Api;
	provider: ProviderId;
	modelId: string;
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

const preferredInputPreview = (input: string): string => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return capText(compactInline(input), Math.floor(SUMMARY_LINE_CAP / 2));
	}
	if (isObject(parsed)) {
		for (const key of ["command", "file_path", "path", "pattern", "url"] as const) {
			const value = parsed[key];
			if (typeof value === "string") return capText(compactInline(value), Math.floor(SUMMARY_LINE_CAP / 2));
		}
	}
	return capText(compactInline(JSON.stringify(parsed) ?? input), Math.floor(SUMMARY_LINE_CAP / 2));
};

const summaryLine = (call: NormalizedToolCall): string => {
	const argument = preferredInputPreview(call.input);
	const status = call.isError === true ? "error" : "ok";
	const output = call.output?.split(/\r?\n/, 1)[0];
	const result = output === undefined ? "(no output)" : JSON.stringify(capText(compactInline(output), SUMMARY_LINE_CAP));
	return capText(`- ${call.name}(${argument}) → ${status}: ${result}`, SUMMARY_LINE_CAP);
};

export const summarizeToolCalls = (toolCalls: NormalizedToolCall[]): string => {
	const lines = [`[Imported tool activity — ${toolCalls.length} call(s)]`];
	lines.push(...toolCalls.slice(0, SUMMARY_TOOLS_PER_TURN).map(summaryLine));
	if (toolCalls.length > SUMMARY_TOOLS_PER_TURN) lines.push(`(+${toolCalls.length - SUMMARY_TOOLS_PER_TURN} more calls)`);
	return lines.join("\n");
};

const sessionName = (conversation: NormalizedConversation): string => {
	const firstUser = conversation.events.find((event) => event.kind === "user");
	const preview = firstUser?.text ? capText(compactInline(firstUser.text), 60) : conversation.sourceSessionId;
	return `imported (${conversation.source}): ${preview}`;
};

export const importConversation = (
	sessionManager: SessionManager,
	conversation: NormalizedConversation,
	modelIdentity: ModelIdentity,
	importedAt: number,
): ImportResult => {
	const provenance: ExternalImportProvenance = {
		version: 1,
		source: conversation.source,
		sourceSessionId: conversation.sourceSessionId,
		sourcePath: conversation.sourcePath,
		importedAt,
		skippedRecords: conversation.skippedRecords,
	};
	if (conversation.sourceCwd !== undefined) provenance.sourceCwd = conversation.sourceCwd;
	if (conversation.sourceModel !== undefined) provenance.sourceModel = conversation.sourceModel;
	sessionManager.appendCustomEntry("external-import", provenance);
	sessionManager.appendSessionInfo(sessionName(conversation));
	sessionManager.appendModelChange(modelIdentity.provider, modelIdentity.modelId);

	let messageCount = 0;
	let toolCallCount = 0;
	let turnIndex = 0;
	for (const event of conversation.events) {
		if (event.kind === "user") {
			sessionManager.appendMessage({ role: "user", content: event.text, timestamp: event.timestamp });
			messageCount++;
			continue;
		}

		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: event.text || "(tool activity only)" }],
			api: modelIdentity.api,
			provider: modelIdentity.provider,
			model: modelIdentity.modelId,
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: event.timestamp,
		} satisfies AssistantMessage;
		sessionManager.appendMessage(assistantMessage);
		messageCount++;
		if (event.toolCalls.length > 0) {
			const details: ExternalImportTools = {
				version: 1,
				turnIndex,
				toolCalls: event.toolCalls.map((call) => ({ ...call })),
			};
			sessionManager.appendCustomEntry("external-import:tools", details);
			sessionManager.appendCustomMessageEntry("external-import:tool-summary", summarizeToolCalls(event.toolCalls), true, {
				turnIndex,
			});
			toolCallCount += event.toolCalls.length;
		}
		turnIndex++;
	}
	return { messageCount, toolCallCount };
};
