import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type AgentEndKind = "ready" | "question" | "error" | "queued" | "stopped";

export interface AgentEndClassification {
	kind: AgentEndKind;
	summary: string;
}

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const summarizeText = (value: string, max = 120): string => {
	const normalized = normalizeText(value);
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
};

const getAssistantText = (message: AgentMessage): string => {
	if (message.role !== "assistant") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return normalizeText(content);
	if (!Array.isArray(content)) return "";
	return normalizeText(
		content
			.filter((block): block is { type: "text"; text: string } => {
				if (typeof block !== "object" || block === null) return false;
				return "type" in block && block.type === "text" && "text" in block && typeof block.text === "string";
			})
			.map((block) => block.text)
			.join("\n"),
	);
};

const findQuestionLine = (text: string): string | undefined => {
	const lines = text
		.split(/\r?\n/)
		.map((line) => normalizeText(line))
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("```"));
	const directQuestion = lines.find((line) => /\?$/.test(line));
	if (directQuestion) return directQuestion;
	return lines.find((line) =>
		/(do you want|would you like|should i|should we|can you|could you|please confirm|let me know|which option|which one|what should|how should)/i.test(
			line,
		),
	);
};

export function classifyAgentEndState(
	messages: AgentMessage[],
	options: { hasPendingMessages?: boolean } = {},
): AgentEndClassification {
	if (options.hasPendingMessages) {
		return {
			kind: "queued",
			summary: "More queued messages are waiting",
		};
	}

	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	if (!lastAssistant) {
		return {
			kind: "ready",
			summary: "Ready for input",
		};
	}

	const stopReason = typeof (lastAssistant as { stopReason?: unknown }).stopReason === "string"
		? (lastAssistant as { stopReason: string }).stopReason
		: undefined;
	const errorMessage = typeof (lastAssistant as { errorMessage?: unknown }).errorMessage === "string"
		? normalizeText((lastAssistant as { errorMessage: string }).errorMessage)
		: "";
	if (errorMessage) {
		return {
			kind: "error",
			summary: summarizeText(errorMessage),
		};
	}

	if (stopReason && stopReason !== "stop" && stopReason !== "toolUse") {
		if (stopReason === "aborted") {
			return {
				kind: "stopped",
				summary: "Stopped",
			};
		}
		return {
			kind: "error",
			summary: `Stopped: ${stopReason}`,
		};
	}

	const text = getAssistantText(lastAssistant);
	const question = findQuestionLine(text);
	if (question) {
		return {
			kind: "question",
			summary: summarizeText(question),
		};
	}

	return {
		kind: "ready",
		summary: "Ready for input",
	};
}
