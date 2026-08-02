import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
	INPUT_CAP,
	LEGACY_MAX_BYTES,
	OUTPUT_CAP,
	ImportAbortedError,
	ImportParseError,
	capText,
	compactInline,
	isObject,
	parseTimestamp,
	renderBoundedValue,
	type JsonlParser,
	type NormalizedConversation,
	type NormalizedEvent,
	type NormalizedToolCall,
} from "./types.ts";

interface ToolResult {
	output: string;
	isError: boolean;
}

interface CodexAccumulatorOptions {
	sourcePath: string;
	fallbackTimestamp: number;
	sourceSessionId?: string | undefined;
	sourceCwd?: string | undefined;
	baseTimestamp?: number | undefined;
}

const isWrapperText = (text: string): boolean => {
	const trimmed = text.trimStart();
	return (
		trimmed.startsWith("<user_instructions>") || trimmed.startsWith("<environment_context>") || trimmed.startsWith("<ENVIRONMENT_CONTEXT>")
	);
};

const compactArguments = (value: unknown): string => {
	if (typeof value !== "string") return renderBoundedValue(value, INPUT_CAP);
	try {
		return renderBoundedValue(JSON.parse(value), INPUT_CAP);
	} catch {
		return capText(compactInline(value), INPUT_CAP);
	}
};

class CodexAccumulator {
	readonly events: NormalizedEvent[] = [];
	readonly openCalls = new Map<string, NormalizedToolCall>();
	readonly pendingResults = new Map<string, ToolResult>();
	readonly sourcePath: string;
	readonly fallbackTimestamp: number;
	sourceSessionId: string;
	sourceCwd: string | undefined;
	sourceModel: string | undefined;
	baseTimestamp: number | undefined;
	skippedRecords = 0;

	constructor(options: CodexAccumulatorOptions) {
		this.sourcePath = options.sourcePath;
		this.fallbackTimestamp = options.fallbackTimestamp;
		this.sourceSessionId = options.sourceSessionId ?? basename(options.sourcePath, extname(options.sourcePath));
		this.sourceCwd = options.sourceCwd;
		this.baseTimestamp = options.baseTimestamp;
	}

	processRecord(record: Record<string, unknown>): void {
		if (record.type === "session_meta") {
			this.processSessionMeta(record.payload);
			return;
		}
		if (record.type === "turn_context") {
			if (isObject(record.payload) && this.sourceModel === undefined && typeof record.payload.model === "string") {
				this.sourceModel = record.payload.model;
			}
			return;
		}
		if (record.type !== "response_item" || !isObject(record.payload)) return;
		this.processItem(record.payload, record.timestamp);
	}

	processItem(item: Record<string, unknown>, timestampValue?: unknown): void {
		const timestamp = this.timestamp(timestampValue ?? item.timestamp);
		if (item.type === "message") {
			this.processMessage(item, timestamp);
			return;
		}
		if (item.type === "function_call") {
			if (typeof item.call_id !== "string" || typeof item.name !== "string") return;
			this.addCall(item.call_id, { name: item.name, input: compactArguments(item.arguments) }, timestamp);
			return;
		}
		if (item.type === "function_call_output") {
			if (typeof item.call_id !== "string") return;
			this.storeResult(item.call_id, {
				output: renderBoundedValue(item.output, OUTPUT_CAP),
				isError: item.is_error === true,
			});
			return;
		}
		if (item.type === "web_search_call") {
			const id = typeof item.id === "string" ? item.id : `web-search-${this.openCalls.size}`;
			this.addCall(id, { name: "web_search", input: compactArguments(item.action ?? item) }, timestamp);
		}
	}

	finish(): NormalizedConversation {
		this.skippedRecords += this.pendingResults.size;
		this.pendingResults.clear();
		const conversation: NormalizedConversation = {
			source: "codex",
			sourceSessionId: this.sourceSessionId,
			sourcePath: this.sourcePath,
			skippedRecords: this.skippedRecords,
			events: this.events,
		};
		if (this.sourceCwd !== undefined) conversation.sourceCwd = this.sourceCwd;
		if (this.sourceModel !== undefined) conversation.sourceModel = this.sourceModel;
		return conversation;
	}

	private processSessionMeta(value: unknown): void {
		if (!isObject(value)) return;
		if (typeof value.id === "string") this.sourceSessionId = value.id;
		if (this.sourceCwd === undefined && typeof value.cwd === "string") this.sourceCwd = value.cwd;
		const parsed = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
		if (Number.isFinite(parsed)) this.baseTimestamp = parsed;
	}

	private processMessage(item: Record<string, unknown>, timestamp: number): void {
		if (item.role !== "user" && item.role !== "assistant") return;
		const expectedType = item.role === "user" ? "input_text" : "output_text";
		const text: string[] = [];
		if (Array.isArray(item.content)) {
			for (const block of item.content) {
				if (!isObject(block) || block.type !== expectedType || typeof block.text !== "string" || !block.text.trim()) continue;
				if (item.role === "user" && isWrapperText(block.text)) continue;
				text.push(block.text);
			}
		}
		if (text.length === 0) return;
		if (item.role === "user") this.events.push({ kind: "user", text: text.join("\n\n"), timestamp });
		else this.addAssistantText(text.join("\n\n"), timestamp);
	}

	private addAssistantText(text: string, timestamp: number): void {
		const last = this.events.at(-1);
		if (last?.kind === "assistant") {
			last.text = [last.text, text].filter(Boolean).join("\n\n");
			return;
		}
		this.events.push({ kind: "assistant", text, timestamp, toolCalls: [] });
	}

	private addCall(id: string, call: NormalizedToolCall, timestamp: number): void {
		const last = this.events.at(-1);
		const event: Extract<NormalizedEvent, { kind: "assistant" }> =
			last?.kind === "assistant" ? last : { kind: "assistant", text: "", timestamp, toolCalls: [] };
		if (last !== event) this.events.push(event);
		event.toolCalls.push(call);
		this.openCalls.set(id, call);
		const pending = this.pendingResults.get(id);
		if (pending) {
			this.applyResult(call, pending);
			this.pendingResults.delete(id);
			this.openCalls.delete(id);
		}
	}

	private storeResult(id: string, result: ToolResult): void {
		const call = this.openCalls.get(id);
		if (call) {
			this.applyResult(call, result);
			this.openCalls.delete(id);
		} else {
			this.pendingResults.set(id, result);
		}
	}

	private applyResult(call: NormalizedToolCall, result: ToolResult): void {
		call.output = result.output;
		call.isError = result.isError;
	}

	private timestamp(value: unknown): number {
		return parseTimestamp(value, this.events.at(-1)?.timestamp ?? this.baseTimestamp, this.fallbackTimestamp);
	}
}

export class CodexParser implements JsonlParser {
	private readonly accumulator: CodexAccumulator;

	constructor(options: { sourcePath: string; fallbackTimestamp: number }) {
		this.accumulator = new CodexAccumulator(options);
	}

	push(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.skip();
			return;
		}
		if (!isObject(record)) {
			this.skip();
			return;
		}
		this.accumulator.processRecord(record);
	}

	skip(): void {
		this.accumulator.skippedRecords++;
	}

	finish(): NormalizedConversation {
		return this.accumulator.finish();
	}
}

export const parseCodexLegacySession = (document: unknown, sourcePath: string, fallbackTimestamp: number): NormalizedConversation => {
	if (!isObject(document) || !isObject(document.session) || !Array.isArray(document.items)) {
		throw new ImportParseError("Legacy Codex session has an unsupported shape");
	}
	const session = document.session;
	const parsedBase = typeof session.timestamp === "string" ? Date.parse(session.timestamp) : Number.NaN;
	const accumulator = new CodexAccumulator({
		sourcePath,
		fallbackTimestamp,
		sourceSessionId: typeof session.id === "string" ? session.id : undefined,
		sourceCwd: typeof session.cwd === "string" ? session.cwd : undefined,
		baseTimestamp: Number.isFinite(parsedBase) ? parsedBase : undefined,
	});
	if (typeof session.model === "string") accumulator.sourceModel = session.model;
	for (const rawItem of document.items) {
		if (!isObject(rawItem)) {
			accumulator.skippedRecords++;
			continue;
		}
		if (rawItem.type === "response_item" && isObject(rawItem.payload)) {
			accumulator.processItem(rawItem.payload, rawItem.timestamp);
		} else {
			accumulator.processItem(rawItem, rawItem.timestamp);
		}
	}
	return accumulator.finish();
};

export const parseCodexLegacyFile = async (
	sourcePath: string,
	sizeBytes: number,
	fallbackTimestamp: number,
	signal: AbortSignal,
): Promise<NormalizedConversation> => {
	if (sizeBytes > LEGACY_MAX_BYTES) {
		throw new ImportParseError(`Legacy session too large to import (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB, limit 32MB)`);
	}
	try {
		const content = await readFile(sourcePath, { encoding: "utf8", signal });
		if (signal.aborted) throw new ImportAbortedError();
		return parseCodexLegacySession(JSON.parse(content), sourcePath, fallbackTimestamp);
	} catch (error) {
		if (signal.aborted || error instanceof ImportAbortedError) throw new ImportAbortedError();
		if (error instanceof ImportParseError) throw error;
		throw new ImportParseError(error instanceof Error ? error.message : String(error));
	}
};
