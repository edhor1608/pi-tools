import { basename, extname } from "node:path";
import {
	INPUT_CAP,
	OUTPUT_CAP,
	capText,
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

export class ClaudeParser implements JsonlParser {
	private readonly sourcePath: string;
	private readonly fallbackTimestamp: number;
	private readonly events: NormalizedEvent[] = [];
	private readonly openCalls = new Map<string, NormalizedToolCall>();
	private readonly pendingResults = new Map<string, ToolResult>();
	private sourceCwd?: string;
	private sourceModel?: string;
	private skippedRecords = 0;

	constructor(options: { sourcePath: string; fallbackTimestamp: number }) {
		this.sourcePath = options.sourcePath;
		this.fallbackTimestamp = options.fallbackTimestamp;
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
		if (record.type !== "user" && record.type !== "assistant") return;
		if (record.isSidechain === true || record.isMeta === true || !isObject(record.message)) return;

		if (this.sourceCwd === undefined && typeof record.cwd === "string") this.sourceCwd = record.cwd;
		if (record.type === "assistant" && this.sourceModel === undefined && typeof record.message.model === "string") {
			this.sourceModel = record.message.model;
		}

		const timestamp = this.timestamp(record.timestamp);
		if (record.type === "user") this.pushUser(record, record.message, timestamp);
		else this.pushAssistant(record.message, timestamp);
	}

	skip(): void {
		this.skippedRecords++;
	}

	finish(): NormalizedConversation {
		this.skippedRecords += this.pendingResults.size;
		this.pendingResults.clear();
		const conversation: NormalizedConversation = {
			source: "claude",
			sourceSessionId: basename(this.sourcePath, extname(this.sourcePath)),
			sourcePath: this.sourcePath,
			skippedRecords: this.skippedRecords,
			events: this.events,
		};
		if (this.sourceCwd !== undefined) conversation.sourceCwd = this.sourceCwd;
		if (this.sourceModel !== undefined) conversation.sourceModel = this.sourceModel;
		return conversation;
	}

	private timestamp(value: unknown): number {
		return parseTimestamp(value, this.events.at(-1)?.timestamp, this.fallbackTimestamp);
	}

	private pushUser(record: Record<string, unknown>, message: Record<string, unknown>, timestamp: number): void {
		const content = message.content;
		if (typeof content === "string") {
			if (content.trim()) this.events.push({ kind: "user", text: content, timestamp });
			return;
		}
		if (!Array.isArray(content)) return;

		const text: string[] = [];
		for (const block of content) {
			if (!isObject(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) text.push(block.text);
			if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
				const preferredOutput = typeof record.toolUseResult === "string" ? record.toolUseResult : block.content;
				this.storeResult(block.tool_use_id, {
					output: renderBoundedValue(preferredOutput, OUTPUT_CAP),
					isError: block.is_error === true,
				});
			}
		}
		if (text.length > 0) this.events.push({ kind: "user", text: text.join("\n\n"), timestamp });
	}

	private pushAssistant(message: Record<string, unknown>, timestamp: number): void {
		const text: string[] = [];
		const calls: Array<{ id: string; call: NormalizedToolCall }> = [];
		const content = message.content;
		if (typeof content === "string" && content.trim()) text.push(content);
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!isObject(block)) continue;
				if (block.type === "text" && typeof block.text === "string" && block.text.trim()) text.push(block.text);
				if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
					calls.push({
						id: block.id,
						call: {
							name: block.name,
							input: capText(renderBoundedValue(block.input, INPUT_CAP), INPUT_CAP),
						},
					});
				}
			}
		}
		if (text.length === 0 && calls.length === 0) return;

		const last = this.events.at(-1);
		const event: Extract<NormalizedEvent, { kind: "assistant" }> =
			last?.kind === "assistant" ? last : { kind: "assistant", text: "", timestamp, toolCalls: [] };
		if (last !== event) this.events.push(event);
		if (text.length > 0) event.text = [event.text, text.join("\n\n")].filter(Boolean).join("\n\n");
		for (const { id, call } of calls) {
			event.toolCalls.push(call);
			this.openCalls.set(id, call);
			const pending = this.pendingResults.get(id);
			if (pending) {
				this.applyResult(call, pending);
				this.pendingResults.delete(id);
			}
		}
	}

	private storeResult(id: string, result: ToolResult): void {
		const call = this.openCalls.get(id);
		if (call) this.applyResult(call, result);
		else this.pendingResults.set(id, result);
	}

	private applyResult(call: NormalizedToolCall, result: ToolResult): void {
		call.output = result.output;
		call.isError = result.isError;
	}
}
