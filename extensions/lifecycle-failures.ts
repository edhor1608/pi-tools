import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const MAX_INPUT_LENGTH = 300;
const MAX_ERROR_LENGTH = 500;
const MAX_RECORD_BYTES = 4096;
const FAILURE_LOG = join(homedir(), "memories", "tool-failures.jsonl");

// Pi creates a cache-disabled jiti instance for each extension runtime, including
// in-process subagents. A process-wide claim prevents every child copy from also
// acting as the main-session logger and writing into the same shared JSONL file.
type PrimaryInstanceState = { owner?: symbol };
const PRIMARY_INSTANCE_KEY = Symbol.for("pi-tools.lifecycle-failures.primary.v1");

const primaryInstanceState = (): PrimaryInstanceState => {
	const host = globalThis as { [PRIMARY_INSTANCE_KEY]?: PrimaryInstanceState };
	host[PRIMARY_INSTANCE_KEY] ??= {};
	return host[PRIMARY_INSTANCE_KEY];
};

export interface FailureRecord {
	ts: string;
	tool: string;
	cwd: string;
	session: string;
	input: string;
	error: string;
}

export interface FailureRecordInput {
	ts?: string;
	tool: string;
	cwd: string;
	sessionId: string;
	input: unknown;
	error: unknown;
}

const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "[unserializable]";
	}
};

export const clip = (value: unknown, length: number): string => stringify(value).slice(0, length);

export const redactSecrets = (value: string): string =>
	value
		.replace(/sk-[A-Za-z0-9]{10,}/g, "[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "[redacted]")
		.replace(/AKIA[A-Z0-9]{16}/g, "[redacted]")
		.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
		.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
		.replace(/xox[a-z]-[A-Za-z0-9-]{10,}/g, "[redacted]")
		.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/\bpassword\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "[redacted]")
		.replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, "[redacted]");

export const createFailureRecord = (input: FailureRecordInput): FailureRecord => ({
	ts: input.ts ?? new Date().toISOString(),
	tool: input.tool,
	cwd: input.cwd,
	session: input.sessionId.slice(0, 8),
	input: redactSecrets(clip(input.input, MAX_INPUT_LENGTH)),
	error: redactSecrets(clip(input.error, MAX_ERROR_LENGTH)),
});

export const isAbortedFailure = (error: unknown, signal?: AbortSignal): boolean => {
	if (signal?.aborted === true) return true;
	const finalLine = stringify(error).trim().split(/\r?\n/).at(-1)?.trim() ?? "";
	return /^(?:error:\s*)?(?:(?:operation|command|request|tool call)(?: was)?\s+)?(?:aborted|cancelled|canceled|interrupted)(?: by (?:the )?user)?[.!]?$/i.test(
		finalLine,
	);
};

export const serializeFailureRecord = (record: FailureRecord): string | undefined => {
	const line = `${JSON.stringify(record)}\n`;
	return Buffer.byteLength(line) <= MAX_RECORD_BYTES ? line : undefined;
};

const toolInput = (event: ToolResultEvent): unknown => {
	if (event.toolName === "bash" && typeof event.input.command === "string") return event.input.command;
	if (typeof event.input.path === "string") return event.input.path;
	return event.input;
};

const textContent = (content: readonly unknown[]): string =>
	content
		.filter(
			(item): item is { type: "text"; text: string } =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "text" &&
				"text" in item &&
				typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");

const toolError = (event: ToolResultEvent): string => {
	const text = textContent(event.content);
	return text !== "" ? text : stringify(event.details);
};

const assistantFailure = (message: AssistantMessage): string => {
	if (message.errorMessage !== undefined && message.errorMessage !== "") return message.errorMessage;
	const text = textContent(message.content);
	return text !== "" ? text : "Assistant error";
};

export default function lifecycleFailuresExtension(pi: ExtensionAPI) {
	const instanceToken = Symbol("lifecycle-failures-instance");
	const primaryState = primaryInstanceState();
	const isPrimaryInstance = primaryState.owner === undefined;
	if (isPrimaryInstance) primaryState.owner = instanceToken;
	let writeQueue = Promise.resolve();

	const log = (record: FailureRecord): void => {
		try {
			const line = serializeFailureRecord(record);
			if (line === undefined) return;
			writeQueue = writeQueue
				.then(async () => {
					await mkdir(dirname(FAILURE_LOG), { recursive: true });
					await appendFile(FAILURE_LOG, line, "utf8");
				})
				.catch(() => undefined);
		} catch {
			// Failure telemetry must never affect the agent run.
		}
	};

	pi.on("tool_result", (event, ctx) => {
		try {
			if (!isPrimaryInstance || !event.isError) return;
			const error = toolError(event);
			if (isAbortedFailure(error, ctx.signal)) return;
			log(
				createFailureRecord({
					tool: event.toolName,
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					input: toolInput(event),
					error,
				}),
			);
		} catch {
			// Failure telemetry must never affect the agent run.
		}
	});

	pi.on("message_end", (event, ctx) => {
		try {
			if (!isPrimaryInstance || event.message.role !== "assistant" || event.message.stopReason !== "error") return;
			const error = assistantFailure(event.message);
			if (isAbortedFailure(error, ctx.signal)) return;
			log(
				createFailureRecord({
					tool: "assistant",
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					input: `${event.message.provider}/${event.message.model}`,
					error,
				}),
			);
		} catch {
			// Failure telemetry must never affect the agent run.
		}
	});

	pi.on("session_shutdown", () => {
		if (primaryState.owner === instanceToken) delete primaryState.owner;
	});
}
