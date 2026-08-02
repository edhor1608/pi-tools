import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Text } from "@earendil-works/pi-tui";
import { filterExternalSessions, listExternalSessions, readSessionMetadata } from "./discover.ts";
import { importConversation, type ExternalImportProvenance, type ExternalImportTools } from "./import.ts";
import { ClaudeParser } from "./parse-claude.ts";
import { CodexParser, parseCodexLegacyFile } from "./parse-codex.ts";
import { parseJsonlStream } from "./stream.ts";
import { ImportAbortedError, PAGE_SIZE, capText, compactInline, type ExternalSessionRef, type NormalizedConversation } from "./types.ts";

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const formatPickerLabel = (session: ExternalSessionRef): string => {
	const date = new Date(session.modified);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	const source = session.source === "codex-legacy" ? "codex" : session.source;
	const cwd = session.cwd ? basename(session.cwd) : "unknown cwd";
	const preview = session.preview ? ` · “${session.preview}”` : "";
	return `${source} · ${month}-${day} ${hour}:${minute} · ${cwd}${preview}`;
};

const pickerLabels = (sessions: ExternalSessionRef[]): string[] => {
	const labels = sessions.map(formatPickerLabel);
	const withSeconds = labels.map((label, index) => {
		if (labels.indexOf(label) === labels.lastIndexOf(label)) return label;
		const seconds = String(new Date(sessions[index]?.modified ?? 0).getSeconds()).padStart(2, "0");
		return `${label} · ${seconds}s`;
	});
	return withSeconds.map((label, index) =>
		withSeconds.indexOf(label) === withSeconds.lastIndexOf(label) ? label : `${label} · #${index + 1}`,
	);
};

const pickSession = async (
	ctx: ExtensionCommandContext,
	source: "claude" | "codex" | undefined,
	filter: string,
): Promise<ExternalSessionRef | undefined> => {
	if (!ctx.hasUI) {
		ctx.ui.notify("External session import requires an interactive session", "error");
		return undefined;
	}
	const discovered = await listExternalSessions({ homedir: homedir(), ...(source === undefined ? {} : { source }) });
	const sessions = filterExternalSessions(discovered, filter);
	if (sessions.length === 0) {
		ctx.ui.notify(filter.trim() ? "No matching external sessions found" : "No external sessions found", "warning");
		return undefined;
	}

	for (let offset = 0; offset < sessions.length; offset += PAGE_SIZE) {
		const page = await Promise.all(sessions.slice(offset, offset + PAGE_SIZE).map(readSessionMetadata));
		const labels = pickerLabels(page);
		const hasMore = offset + PAGE_SIZE < sessions.length;
		const options = hasMore ? [...labels, "→ older…"] : labels;
		const selected = await ctx.ui.select("Resume external session", options);
		if (selected === undefined) return undefined;
		if (selected === "→ older…") continue;
		const index = labels.indexOf(selected);
		if (index >= 0) return page[index];
		return undefined;
	}
	return undefined;
};

const validDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

const pickTargetCwd = async (ctx: ExtensionCommandContext, sourceCwd: string | undefined): Promise<string | undefined> => {
	if (!ctx.hasUI) return undefined;
	while (true) {
		const choices: Array<{ label: string; path?: string }> = [];
		if (sourceCwd !== undefined) choices.push({ label: `Source: ${sourceCwd}`, path: sourceCwd });
		if (sourceCwd !== ctx.cwd) choices.push({ label: `Current: ${ctx.cwd}`, path: ctx.cwd });
		choices.push({ label: "Custom…" });
		const selected = await ctx.ui.select(
			"Target working directory",
			choices.map((choice) => choice.label),
		);
		if (selected === undefined) return undefined;
		const choice = choices.find((candidate) => candidate.label === selected);
		let path = choice?.path;
		if (choice && path === undefined) path = await ctx.ui.input("Custom target working directory", ctx.cwd);
		if (path === undefined) return undefined;
		if (validDirectory(path)) return path;
		ctx.ui.notify(`Working directory does not exist or is not a directory: ${path}`, "error");
	}
};

const parseSelectedSession = async (session: ExternalSessionRef, signal: AbortSignal): Promise<NormalizedConversation> => {
	if (session.source !== "codex-legacy") {
		const parser =
			session.source === "claude"
				? new ClaudeParser({ sourcePath: session.path, fallbackTimestamp: session.modified })
				: new CodexParser({ sourcePath: session.path, fallbackTimestamp: session.modified });
		return parseJsonlStream(session.path, parser, signal);
	}

	const currentSize = statSync(session.path).size;
	return parseCodexLegacyFile(session.path, currentSize, session.modified, signal);
};

const parseWithLoader = async (ctx: ExtensionCommandContext, session: ExternalSessionRef): Promise<NormalizedConversation | null> => {
	if (ctx.mode !== "tui") {
		try {
			return await parseSelectedSession(session, new AbortController().signal);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return null;
		}
	}
	return ctx.ui.custom<NormalizedConversation | null>((tui, theme, _keybindings, done) => {
		const loader = new CancellableLoader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("dim", text),
			`Parsing ${basename(session.path)} (${formatBytes(session.sizeBytes)})… esc to cancel`,
		);
		let settled = false;
		const complete = (result: NormalizedConversation | null) => {
			if (settled) return;
			settled = true;
			done(result);
		};
		loader.onAbort = () => complete(null);
		parseSelectedSession(session, loader.signal).then(complete, (error: unknown) => {
			if (!(error instanceof ImportAbortedError)) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			complete(null);
		});
		return loader;
	});
};

const renderToolLine = (call: ExternalImportTools["toolCalls"][number]): string => {
	const status = call.isError === true ? "error" : call.output === undefined ? "no output" : "ok";
	return `- ${call.name}(${capText(compactInline(call.input), 80)}) · ${status}`;
};

const registerRenderers = (pi: ExtensionAPI): void => {
	pi.registerEntryRenderer<ExternalImportProvenance>("external-import", (entry, _options, theme) => {
		const cwd = entry.data?.sourceCwd ? ` · ${entry.data.sourceCwd}` : "";
		return new Text(
			theme.fg("dim", `⇩ imported from ${entry.data?.source ?? "external"} · ${entry.data?.sourceSessionId ?? "unknown"}${cwd}`),
			0,
			0,
		);
	});
	pi.registerEntryRenderer<ExternalImportTools>("external-import:tools", (entry, _options, theme) => {
		const calls = entry.data?.toolCalls ?? [];
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("dim", text)));
		const lines = [`⚒ ${calls.length} imported tool call(s)`, ...calls.slice(0, 10).map(renderToolLine)];
		if (calls.length > 10) lines.push(`(+${calls.length - 10} more)`);
		container.addChild(new Text(theme.fg("dim", lines.join("\n")), 1, 0));
		container.addChild(new DynamicBorder((text) => theme.fg("dim", text)));
		return container;
	});
};

const runImport = async (ctx: ExtensionCommandContext, source: "claude" | "codex" | undefined, filter: string): Promise<void> => {
	const selected = await pickSession(ctx, source, filter);
	if (!selected) return;
	const targetCwd = await pickTargetCwd(ctx, selected.cwd);
	if (!targetCwd) return;
	const conversation = await parseWithLoader(ctx, selected);
	if (!conversation) return;
	if (conversation.events.length === 0) {
		ctx.ui.notify("External session contains nothing to import", "warning");
		return;
	}
	if (conversation.skippedRecords > 0) {
		ctx.ui.notify(`Skipped ${conversation.skippedRecords} unparseable record(s)`, "warning");
	}

	const sessionManager = SessionManager.create(targetCwd);
	const result = importConversation(sessionManager, conversation, Date.now());
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("Imported session could not be persisted", "error");
		return;
	}
	const sourceName = conversation.source;
	await ctx.switchSession(sessionFile, {
		withSession: async (replacementCtx) => {
			replacementCtx.ui.notify(`Imported ${result.messageCount} messages, ${result.toolCallCount} tool calls from ${sourceName}`, "info");
		},
	});
};

export default function externalSessionImportExtension(pi: ExtensionAPI): void {
	registerRenderers(pi);
	pi.registerCommand("resume-external", {
		description: "Import a Claude Code or Codex session into a new Pi session",
		handler: async (args, ctx) => runImport(ctx, undefined, args),
	});
	pi.registerCommand("resume-claude", {
		description: "Import a Claude Code session into a new Pi session",
		handler: async (args, ctx) => runImport(ctx, "claude", args),
	});
	pi.registerCommand("resume-codex", {
		description: "Import a Codex session into a new Pi session",
		handler: async (args, ctx) => runImport(ctx, "codex", args),
	});
}
