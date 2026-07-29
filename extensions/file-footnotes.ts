import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FOOTNOTE_HEADER = "File references:";

interface FileFootnoteItem {
	index: number;
	href: string;
	displayHref: string;
	filesystemPath?: string;
	line?: number;
	column?: number;
	openUrl?: string;
	vscodeUrl?: string;
}

interface ParsedFileTarget {
	displayHref: string;
	filesystemPath?: string;
	line?: number;
	column?: number;
}

const isAbsoluteWindowsPath = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value);

const isFileHref = (href: string): boolean => {
	if (!href) return false;
	if (/^(?:https?|mailto|ftp):\/\//.test(href)) return false;
	return href.startsWith("file://") || href.startsWith("/") || href.startsWith("~/") || isAbsoluteWindowsPath(href);
};

const isEscaped = (text: string, index: number): boolean => {
	let count = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) count++;
	return count % 2 === 1;
};

const findUnescapedChar = (text: string, char: string, startIndex = 0): number => {
	for (let index = startIndex; index < text.length; index++) {
		if (text[index] === char && !isEscaped(text, index)) return index;
	}
	return -1;
};

const findMatchingDelimiter = (text: string, startIndex: number, openChar: string, closeChar: string): number => {
	let depth = 0;
	for (let index = startIndex; index < text.length; index++) {
		if (isEscaped(text, index)) continue;
		if (text[index] === openChar) depth++;
		else if (text[index] === closeChar && --depth === 0) return index;
	}
	return -1;
};

const stripOptionalLinkTitle = (destination: string): string => {
	const trimmed = destination.trim();
	if (trimmed.startsWith("<")) {
		const close = findUnescapedChar(trimmed, ">", 1);
		if (close !== -1) return trimmed.slice(1, close).trim();
	}
	return trimmed.replace(/\s+(?:"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\([^()]*\))\s*$/, "").trim();
};

const parseHashLocation = (hash: string): { line?: number; column?: number } => {
	const match = /^#L(\d+)(?:C(\d+))?$/.exec(hash);
	if (!match) return {};
	return { line: Number(match[1]), column: match[2] ? Number(match[2]) : undefined };
};

const splitPathLocationSuffix = (href: string): { pathPart: string; suffix: string; line?: number; column?: number } => {
	const hash = /#L(\d+)(?:C(\d+))?$/.exec(href);
	if (hash?.index !== undefined) {
		return {
			pathPart: href.slice(0, hash.index),
			suffix: hash[0],
			line: Number(hash[1]),
			column: hash[2] ? Number(hash[2]) : undefined,
		};
	}
	const lastSlash = Math.max(href.lastIndexOf("/"), href.lastIndexOf("\\"));
	const colon = /:(\d+)(?::(\d+))?$/.exec(href);
	if (colon && colon.index > lastSlash) {
		return {
			pathPart: href.slice(0, colon.index),
			suffix: colon[0],
			line: Number(colon[1]),
			column: colon[2] ? Number(colon[2]) : undefined,
		};
	}
	return { pathPart: href, suffix: "" };
};

const normalizeFilesystemPath = (path: string): string | undefined => {
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path.startsWith("/") || isAbsoluteWindowsPath(path) ? path : undefined;
};

const parseFileTarget = (href: string): ParsedFileTarget => {
	if (href.startsWith("file://")) {
		try {
			const url = new URL(href);
			const filesystemPath = fileURLToPath(url);
			return { displayHref: `${filesystemPath}${url.hash}`, filesystemPath, ...parseHashLocation(url.hash) };
		} catch {
			return { displayHref: href };
		}
	}
	const { pathPart, suffix, line, column } = splitPathLocationSuffix(href);
	return { displayHref: `${pathPart}${suffix}`, filesystemPath: normalizeFilesystemPath(pathPart), line, column };
};

const buildVsCodeUrl = (target: ParsedFileTarget): string | undefined => {
	if (!target.filesystemPath) return undefined;
	const fileUrl = pathToFileURL(target.filesystemPath).href;
	const base = process.platform === "win32" ? fileUrl.replace(/^file:\/\/\//, "vscode://file/") : fileUrl.replace(/^file:\/\//, "vscode://file/");
	return target.line ? `${base}:${target.line}${target.column ? `:${target.column}` : ""}` : base;
};

const createFootnoteItem = (href: string, index: number): FileFootnoteItem => {
	const target = parseFileTarget(href);
	return {
		index,
		href,
		displayHref: target.displayHref,
		filesystemPath: target.filesystemPath,
		line: target.line,
		column: target.column,
		openUrl: target.filesystemPath ? pathToFileURL(target.filesystemPath).href : undefined,
		vscodeUrl: buildVsCodeUrl(target),
	};
};

const deriveInlineLabel = (href: string): string => {
	const display = parseFileTarget(href).displayHref;
	const slash = Math.max(display.lastIndexOf("/"), display.lastIndexOf("\\"));
	return display.slice(slash + 1) || display;
};

const markdownDestination = (href: string): string => `<${href.replaceAll("<", "%3C").replaceAll(">", "%3E")}>`;

const codeSpan = (value: string): string => {
	const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestRun + 1);
	return `${fence}${value}${fence}`;
};

const rewriteMarkdownLine = (line: string, register: (href: string) => FileFootnoteItem): string => {
	let output = "";
	for (let index = 0; index < line.length;) {
		if (line[index] === "`" && !isEscaped(line, index)) {
			const run = /^`+/.exec(line.slice(index))?.[0] ?? "`";
			const close = line.indexOf(run, index + run.length);
			if (close !== -1) {
				output += line.slice(index, close + run.length);
				index = close + run.length;
				continue;
			}
		}
		if (line[index] === "<" && !isEscaped(line, index)) {
			const close = findUnescapedChar(line, ">", index + 1);
			if (close !== -1) {
				const href = line.slice(index + 1, close).trim();
				if (isFileHref(href)) {
					const item = register(href);
					output += `${deriveInlineLabel(href)} [[${item.index}]](${markdownDestination(href)})`;
					index = close + 1;
					continue;
				}
			}
		}
		if (line[index] === "[" && line[index - 1] !== "!" && !isEscaped(line, index)) {
			const labelEnd = findMatchingDelimiter(line, index, "[", "]");
			let openParen = labelEnd + 1;
			while (labelEnd !== -1 && /\s/.test(line[openParen] ?? "")) openParen++;
			if (labelEnd !== -1 && line[openParen] === "(") {
				const closeParen = findMatchingDelimiter(line, openParen, "(", ")");
				if (closeParen !== -1) {
					const href = stripOptionalLinkTitle(line.slice(openParen + 1, closeParen));
					if (isFileHref(href)) {
						const item = register(href);
						output += `${line.slice(index + 1, labelEnd)} [[${item.index}]](${markdownDestination(href)})`;
						index = closeParen + 1;
						continue;
					}
				}
			}
		}
		output += line[index];
		index++;
	}
	return output;
};

export const rewriteFileLinksAsFootnotes = (text: string): string => {
	if (text.includes(`\n\n${FOOTNOTE_HEADER}\n`)) return text;
	const items: FileFootnoteItem[] = [];
	const byHref = new Map<string, FileFootnoteItem>();
	const register = (href: string): FileFootnoteItem => {
		const existing = byHref.get(href);
		if (existing) return existing;
		const item = createFootnoteItem(href, items.length + 1);
		items.push(item);
		byHref.set(href, item);
		return item;
	};
	let fencedBy: "`" | "~" | undefined;
	const rewritten = text.split("\n").map((line) => {
		const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			const marker = fence[0] as "`" | "~";
			if (!fencedBy) fencedBy = marker;
			else if (fencedBy === marker) fencedBy = undefined;
			return line;
		}
		return fencedBy ? line : rewriteMarkdownLine(line, register);
	}).join("\n");
	if (items.length === 0) return text;
	const references = items.map((item) => `- [[${item.index}]](${markdownDestination(item.href)}) ${codeSpan(item.displayHref)}`);
	return `${rewritten}\n\n${FOOTNOTE_HEADER}\n${references.join("\n")}`;
};

const collectMarkdownFileHrefs = (text: string): string[] => {
	const hrefs: string[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "<" && !isEscaped(text, index)) {
			const close = findUnescapedChar(text, ">", index + 1);
			if (close !== -1) {
				const href = text.slice(index + 1, close).trim();
				if (isFileHref(href)) hrefs.push(href);
				index = close;
			}
			continue;
		}
		if (text[index] !== "[" || text[index - 1] === "!" || isEscaped(text, index)) continue;
		const labelEnd = findMatchingDelimiter(text, index, "[", "]");
		let openParen = labelEnd + 1;
		while (labelEnd !== -1 && /\s/.test(text[openParen] ?? "")) openParen++;
		if (labelEnd === -1 || text[openParen] !== "(") continue;
		const closeParen = findMatchingDelimiter(text, openParen, "(", ")");
		if (closeParen === -1) continue;
		const href = stripOptionalLinkTitle(text.slice(openParen + 1, closeParen));
		if (isFileHref(href)) hrefs.push(href);
		index = closeParen;
	}
	return hrefs;
};

const extractFileFootnotesFromText = (text: string): FileFootnoteItem[] => {
	const unique = [...new Set(collectMarkdownFileHrefs(text))];
	return unique.map((href, index) => createFootnoteItem(href, index + 1));
};

const getLatestAssistantText = (ctx: { sessionManager: { getBranch: () => SessionEntry[] } }): { text?: string; error?: string } => {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		if (message.stopReason !== "stop") return { error: `Last assistant message incomplete (${String(message.stopReason)})` };
		const content = Array.isArray(message.content) ? message.content : [];
		return {
			text: content.flatMap((block) =>
				typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string"
					? [block.text]
					: [],
			).join("\n"),
		};
	}
	return { error: "No assistant messages found" };
};

const openUriWithSystem = async (pi: ExtensionAPI, uri: string): Promise<void> => {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", uri] : [uri];
	await pi.exec(command, args, { timeout: 5000 });
};

const openFootnoteInVsCode = async (pi: ExtensionAPI, item: FileFootnoteItem): Promise<void> => {
	if (!item.filesystemPath) throw new Error(`No local filesystem path for footnote [${item.index}]`);
	const target = item.line ? `${item.filesystemPath}:${item.line}${item.column ? `:${item.column}` : ""}` : item.filesystemPath;
	try {
		const result = await pi.exec("code", item.line ? ["--goto", target] : [item.filesystemPath], { timeout: 5000 });
		if (result.code === 0) return;
	} catch {
		// The URL scheme keeps the command useful when the optional code CLI is unavailable.
	}
	if (!item.vscodeUrl) throw new Error(`No VS Code URL for footnote [${item.index}]`);
	await openUriWithSystem(pi, item.vscodeUrl);
};

export default function fileFootnotesExtension(pi: ExtensionAPI) {
	pi.on("message_end", async (event): Promise<{ message: AgentMessage } | undefined> => {
		if (event.message.role !== "assistant") return undefined;
		let changed = false;
		const content = event.message.content.map((block) => {
			if (block.type !== "text") return block;
			const text = rewriteFileLinksAsFootnotes(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		});
		return changed ? { message: { ...event.message, content } } : undefined;
	});

	pi.registerCommand("file-footnotes", {
		description: "Open file footnotes from the latest assistant message",
		handler: async (args, ctx) => {
			const latest = getLatestAssistantText(ctx);
			if (latest.error) {
				ctx.ui.notify(latest.error, latest.error.includes("incomplete") ? "error" : "warning");
				return;
			}
			const items = extractFileFootnotesFromText(latest.text ?? "");
			if (items.length === 0) {
				ctx.ui.notify("No file footnotes found in the latest assistant message", "warning");
				return;
			}
			const open = async (mode: "open" | "vscode", index: number) => {
				const item = items.find((candidate) => candidate.index === index);
				if (!item) throw new Error(`Unknown footnote index: ${index}`);
				if (mode === "vscode") await openFootnoteInVsCode(pi, item);
				else if (item.openUrl) await openUriWithSystem(pi, item.openUrl);
				else throw new Error(`No open URL for footnote [${index}]`);
				ctx.ui.notify(`Opened footnote [${index}] ${mode === "vscode" ? "in VS Code" : "with the system opener"}`, "info");
			};
			try {
				const trimmed = args.trim();
				if (trimmed) {
					const match = /^(open|vscode)\s+(\d+)$/.exec(trimmed);
					if (!match) throw new Error("Usage: /file-footnotes [open|vscode] <index>");
					await open(match[1] as "open" | "vscode", Number(match[2]));
					return;
				}
				const labels = items.map((item) => `[${item.index}] ${item.displayHref}`);
				const selected = await ctx.ui.select("Open file footnote", labels);
				if (!selected) return;
				const item = items[labels.indexOf(selected)];
				if (!item) return;
				const action = await ctx.ui.select("Open how?", ["Open path", "Open in VS Code"]);
				if (action) await open(action === "Open in VS Code" ? "vscode" : "open", item.index);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Failed to open file footnote", "error");
			}
		},
	});
}
