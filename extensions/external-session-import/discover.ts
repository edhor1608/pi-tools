import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { METADATA_READ_BYTES, capText, compactInline, isObject, type ExternalSessionRef } from "./types.ts";

export interface ListExternalSessionsOptions {
	source?: "claude" | "codex";
	homedir: string;
}

const collectFiles = async (root: string, accept: (path: string, depth: number) => boolean): Promise<string[]> => {
	const found: string[] = [];
	const visit = async (directory: string, depth: number): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path, depth + 1);
			else if (entry.isFile() && accept(path, depth)) found.push(path);
		}
	};
	await visit(root, 0);
	return found;
};

const toRef = async (path: string, source: ExternalSessionRef["source"]): Promise<ExternalSessionRef | undefined> => {
	try {
		const details = await stat(path);
		if (!details.isFile()) return undefined;
		return { source, path, modified: details.mtimeMs, sizeBytes: details.size };
	} catch {
		return undefined;
	}
};

export const listExternalSessions = async (options: ListExternalSessionsOptions): Promise<ExternalSessionRef[]> => {
	const candidates: Array<{ path: string; source: ExternalSessionRef["source"] }> = [];
	if (options.source !== "codex") {
		const root = join(options.homedir, ".claude", "projects");
		const files = await collectFiles(root, (path, depth) => depth === 1 && path.endsWith(".jsonl"));
		candidates.push(...files.map((path) => ({ path, source: "claude" as const })));
	}
	if (options.source !== "claude") {
		const root = join(options.homedir, ".codex", "sessions");
		const files = await collectFiles(root, (path) => path.endsWith(".jsonl") || path.endsWith(".json"));
		for (const path of files) {
			const relativeDepth = path.slice(root.length + 1).split(/[\\/]/).length - 1;
			if (path.endsWith(".jsonl")) candidates.push({ path, source: "codex" });
			else if (relativeDepth === 0) candidates.push({ path, source: "codex-legacy" });
		}
	}
	const refs = (await Promise.all(candidates.map(({ path, source }) => toRef(path, source)))).filter(
		(ref): ref is ExternalSessionRef => ref !== undefined,
	);
	return refs.sort((left, right) => right.modified - left.modified);
};

const claudeText = (message: Record<string, unknown>): string | undefined => {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((block): block is Record<string, unknown> => isObject(block))
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join(" ");
	return text || undefined;
};

const codexText = (payload: Record<string, unknown>): string | undefined => {
	if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return undefined;
	const text = payload.content
		.filter((block): block is Record<string, unknown> => isObject(block))
		.filter((block) => block.type === "input_text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.find((value) => {
			const trimmed = value.trimStart();
			return (
				!trimmed.startsWith("<user_instructions>") &&
				!trimmed.startsWith("<environment_context>") &&
				!trimmed.startsWith("<ENVIRONMENT_CONTEXT>")
			);
		});
	return text;
};

const applyMetadataLine = (ref: ExternalSessionRef, line: string): void => {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	if (!isObject(record)) return;
	if (ref.source === "claude") {
		if (ref.cwd === undefined && typeof record.cwd === "string") ref.cwd = record.cwd;
		if (ref.preview === undefined && record.type === "user" && isObject(record.message)) {
			const text = claudeText(record.message);
			if (text) ref.preview = capText(compactInline(text), 80);
		}
		return;
	}
	if (record.type === "session_meta" && isObject(record.payload) && ref.cwd === undefined && typeof record.payload.cwd === "string") {
		ref.cwd = record.payload.cwd;
	}
	if (record.type === "response_item" && isObject(record.payload) && ref.preview === undefined) {
		const text = codexText(record.payload);
		if (text) ref.preview = capText(compactInline(text), 80);
	}
};

export const readSessionMetadata = async (session: ExternalSessionRef): Promise<ExternalSessionRef> => {
	const ref = { ...session };
	if (ref.source === "codex-legacy" || ref.sizeBytes === 0) return ref;
	const input = createReadStream(ref.path, { encoding: "utf8", end: METADATA_READ_BYTES - 1 });
	let pending = "";
	try {
		for await (const chunk of input) {
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				applyMetadataLine(ref, pending.slice(0, newline).replace(/\r$/, ""));
				pending = pending.slice(newline + 1);
				if (ref.cwd !== undefined && ref.preview !== undefined) {
					input.destroy();
					return ref;
				}
				newline = pending.indexOf("\n");
			}
		}
		if (ref.sizeBytes <= METADATA_READ_BYTES && pending) applyMetadataLine(ref, pending.replace(/\r$/, ""));
		return ref;
	} finally {
		input.destroy();
	}
};

export const filterExternalSessions = (sessions: ExternalSessionRef[], filter: string): ExternalSessionRef[] => {
	const needle = filter.trim().toLowerCase();
	if (!needle) return sessions;
	return sessions.filter((session) => `${session.path}\n${session.cwd ?? ""}`.toLowerCase().includes(needle));
};
