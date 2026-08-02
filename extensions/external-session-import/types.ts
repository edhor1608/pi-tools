export const INPUT_CAP = 4096;
export const OUTPUT_CAP = 4096;
export const SUMMARY_LINE_CAP = 160;
export const SUMMARY_TOOLS_PER_TURN = 20;
export const METADATA_READ_BYTES = 65_536;
export const PAGE_SIZE = 20;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const LEGACY_MAX_BYTES = 32 * 1024 * 1024;

export interface NormalizedToolCall {
	name: string;
	input: string;
	output?: string;
	isError?: boolean;
}

export type NormalizedEvent =
	| { kind: "user"; text: string; timestamp: number }
	| { kind: "assistant"; text: string; timestamp: number; toolCalls: NormalizedToolCall[] };

export interface NormalizedConversation {
	source: "claude" | "codex";
	sourceSessionId: string;
	sourcePath: string;
	sourceCwd?: string;
	sourceModel?: string;
	skippedRecords: number;
	events: NormalizedEvent[];
}

export interface ExternalSessionRef {
	source: "claude" | "codex" | "codex-legacy";
	path: string;
	modified: number;
	sizeBytes: number;
	cwd?: string;
	preview?: string;
}

export interface JsonlParser {
	push(line: string): void;
	skip(): void;
	finish(): NormalizedConversation;
}

export class ImportAbortedError extends Error {
	constructor() {
		super("External session import aborted");
		this.name = "ImportAbortedError";
	}
}

export class ImportParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportParseError";
	}
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const capText = (value: string, cap: number): string => (value.length <= cap ? value : `${value.slice(0, Math.max(0, cap - 1))}…`);

export const compactInline = (value: string): string => value.replace(/\s+/g, " ").trim();

export const renderBoundedValue = (value: unknown, cap: number): string => {
	if (typeof value === "string") return capText(value, cap);
	try {
		return capText(JSON.stringify(value) ?? String(value), cap);
	} catch {
		return capText(String(value), cap);
	}
};

export const parseTimestamp = (value: unknown, previous: number | undefined, fallback: number): number => {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : (previous ?? fallback);
};
