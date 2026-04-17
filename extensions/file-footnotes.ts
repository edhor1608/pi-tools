import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, Markdown, wrapTextWithAnsi, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piCodingAgentEntry = new URL(await import.meta.resolve("@mariozechner/pi-coding-agent"));
const piCodingAgentDistDir = dirname(piCodingAgentEntry.pathname);
const { AssistantMessageComponent } = await import(
	pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "components", "assistant-message.js")).href,
);
const { rawKeyHint } = await import(
	pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "components", "keybinding-hints.js")).href,
);
const { InteractiveMode } = await import(pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "interactive-mode.js")).href);

const PATCHED = Symbol.for("stead.pi-tools.fileFootnotes.patched");
const ASSISTANT_MARKDOWN = Symbol.for("stead.pi-tools.fileFootnotes.assistantMarkdown");
const FOOTNOTE_STATE = Symbol.for("stead.pi-tools.fileFootnotes.state");
const PATCHED_CACHE = Symbol.for("stead.pi-tools.fileFootnotes.cache");
const FOOTNOTE_VISIBILITY = Symbol.for("stead.pi-tools.fileFootnotes.visibility");
const FOOTNOTE_TOGGLE_SHORTCUT = Key.ctrlShift("o");

export const FILE_FOOTNOTES_TOGGLE_SHORTCUT = FOOTNOTE_TOGGLE_SHORTCUT;

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

interface FileFootnoteState {
	items: FileFootnoteItem[];
	itemByHref: Map<string, FileFootnoteItem>;
}

interface FootnoteVisibilityState {
	expanded: boolean;
}

interface ParsedFileTarget {
	displayHref: string;
	filesystemPath?: string;
	line?: number;
	column?: number;
}

interface MarkdownWithFootnotes extends Markdown {
	[ASSISTANT_MARKDOWN]?: boolean;
	[FOOTNOTE_STATE]?: FileFootnoteState;
	[PATCHED_CACHE]?: {
		text: string;
		width: number;
		lines: string[];
		expanded: boolean;
	};
	cachedText?: string;
	cachedWidth?: number;
	cachedLines?: string[];
	paddingX: number;
	theme: {
		link: (text: string) => string;
		linkUrl: (text: string) => string;
		underline: (text: string) => string;
	};
	defaultTextStyle?: {
		bgColor?: (text: string) => string;
	};
	renderInlineTokens(tokens: any[], styleContext?: { applyText: (text: string) => string; stylePrefix: string }): string;
}

const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");

const isAbsoluteWindowsPath = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value);

const isFileHref = (href: string): boolean => {
	if (!href) return false;
	if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("ftp://")) return false;
	if (href.startsWith("file://")) return true;
	if (href.startsWith("/")) return true;
	if (href.startsWith("~/")) return true;
	return isAbsoluteWindowsPath(href);
};

const getFootnoteVisibilityState = (): FootnoteVisibilityState => {
	const globalScope = globalThis as Record<PropertyKey, unknown>;
	const existing = globalScope[FOOTNOTE_VISIBILITY] as FootnoteVisibilityState | undefined;
	if (existing) return existing;
	const created: FootnoteVisibilityState = { expanded: false };
	globalScope[FOOTNOTE_VISIBILITY] = created;
	return created;
};

export const getFileFootnotesExpanded = (): boolean => getFootnoteVisibilityState().expanded;

export const setFileFootnotesExpanded = (expanded: boolean): boolean => {
	getFootnoteVisibilityState().expanded = expanded;
	return expanded;
};

export const toggleFileFootnotesExpanded = (): boolean => {
	const visibility = getFootnoteVisibilityState();
	visibility.expanded = !visibility.expanded;
	return visibility.expanded;
};

const isEscaped = (text: string, index: number): boolean => {
	let backslashCount = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashCount++;
	return backslashCount % 2 === 1;
};

const findUnescapedChar = (text: string, char: string, startIndex = 0): number => {
	for (let i = startIndex; i < text.length; i++) {
		if (text[i] === char && !isEscaped(text, i)) return i;
	}
	return -1;
};

const findMatchingDelimiter = (text: string, startIndex: number, openChar: string, closeChar: string): number => {
	let depth = 0;
	for (let i = startIndex; i < text.length; i++) {
		if (isEscaped(text, i)) continue;
		if (text[i] === openChar) depth++;
		else if (text[i] === closeChar) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
};

const stripOptionalLinkTitle = (destination: string): string => {
	const trimmed = destination.trim();
	if (trimmed.startsWith("<")) {
		const closingAngleIndex = findUnescapedChar(trimmed, ">", 1);
		if (closingAngleIndex !== -1) return trimmed.slice(1, closingAngleIndex).trim();
	}
	return trimmed.replace(/\s+(?:"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\([^()]*\))\s*$/, "").trim();
};

const collectMarkdownFileHrefs = (text: string): string[] => {
	const hrefs: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "<" && !isEscaped(text, i)) {
			const closingAngleIndex = findUnescapedChar(text, ">", i + 1);
			if (closingAngleIndex !== -1) {
				const candidate = text.slice(i + 1, closingAngleIndex).trim();
				if (isFileHref(candidate)) {
					hrefs.push(candidate);
					i = closingAngleIndex;
					continue;
				}
			}
		}
		if (char !== "[" || isEscaped(text, i) || text[i - 1] === "!") continue;
		const labelEnd = findMatchingDelimiter(text, i, "[", "]");
		if (labelEnd === -1) continue;
		let openParenIndex = labelEnd + 1;
		while (openParenIndex < text.length && /\s/.test(text[openParenIndex]!)) openParenIndex++;
		if (text[openParenIndex] !== "(") continue;
		const closeParenIndex = findMatchingDelimiter(text, openParenIndex, "(", ")");
		if (closeParenIndex === -1) continue;
		const href = stripOptionalLinkTitle(text.slice(openParenIndex + 1, closeParenIndex));
		if (isFileHref(href)) hrefs.push(href);
		i = closeParenIndex;
	}
	return hrefs;
};

const parseHashLocation = (hash: string): { line?: number; column?: number } => {
	const match = /^#L(\d+)(?:C(\d+))?$/.exec(hash);
	if (!match) return {};
	const line = Number(match[1]);
	const column = match[2] ? Number(match[2]) : undefined;
	return {
		line: Number.isFinite(line) ? line : undefined,
		column: column !== undefined && Number.isFinite(column) ? column : undefined,
	};
};

const splitPathLocationSuffix = (href: string): { pathPart: string; suffix: string; line?: number; column?: number } => {
	const hashMatch = /#L(\d+)(?:C(\d+))?$/.exec(href);
	if (hashMatch && hashMatch.index >= 0) {
		const line = Number(hashMatch[1]);
		const column = hashMatch[2] ? Number(hashMatch[2]) : undefined;
		return {
			pathPart: href.slice(0, hashMatch.index),
			suffix: hashMatch[0],
			line: Number.isFinite(line) ? line : undefined,
			column: column !== undefined && Number.isFinite(column) ? column : undefined,
		};
	}
	const lastSlash = Math.max(href.lastIndexOf("/"), href.lastIndexOf("\\"));
	const colonMatch = /:(\d+)(?::(\d+))?$/.exec(href);
	if (colonMatch && colonMatch.index > lastSlash) {
		const line = Number(colonMatch[1]);
		const column = colonMatch[2] ? Number(colonMatch[2]) : undefined;
		return {
			pathPart: href.slice(0, colonMatch.index),
			suffix: colonMatch[0],
			line: Number.isFinite(line) ? line : undefined,
			column: column !== undefined && Number.isFinite(column) ? column : undefined,
		};
	}
	return { pathPart: href, suffix: "" };
};

const normalizeFilesystemPath = (pathPart: string): string | undefined => {
	if (pathPart.startsWith("~/")) return join(homedir(), pathPart.slice(2));
	if (pathPart.startsWith("/")) return pathPart;
	if (isAbsoluteWindowsPath(pathPart)) return pathPart;
	return undefined;
};

const parseFileTarget = (href: string): ParsedFileTarget => {
	if (href.startsWith("file://")) {
		try {
			const url = new URL(href);
			const filesystemPath = fileURLToPath(url);
			const { line, column } = parseHashLocation(url.hash || "");
			return {
				displayHref: `${filesystemPath}${url.hash || ""}`,
				filesystemPath,
				line,
				column,
			};
		} catch {
			return { displayHref: href };
		}
	}
	const { pathPart, suffix, line, column } = splitPathLocationSuffix(href);
	return {
		displayHref: `${pathPart}${suffix}`,
		filesystemPath: normalizeFilesystemPath(pathPart),
		line,
		column,
	};
};

const buildDefaultOpenUrl = (target: ParsedFileTarget): string | undefined => {
	if (!target.filesystemPath) return undefined;
	return pathToFileURL(target.filesystemPath).href;
};

const buildVsCodeUrl = (target: ParsedFileTarget): string | undefined => {
	if (!target.filesystemPath) return undefined;
	const fileUrl = pathToFileURL(target.filesystemPath).href;
	const baseUrl =
		process.platform === "win32"
			? fileUrl.replace(/^file:\/\/\//, "vscode://file/")
			: fileUrl.replace(/^file:\/\//, "vscode://file/");
	if (!target.line) return baseUrl;
	if (!target.column) return `${baseUrl}:${target.line}`;
	return `${baseUrl}:${target.line}:${target.column}`;
};

const formatHyperlink = (url: string | undefined, label: string): string => {
	if (!url) return label;
	return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
};

const deriveInlineLabel = (href: string): string => {
	const target = parseFileTarget(href);
	const slashIndex = Math.max(target.displayHref.lastIndexOf("/"), target.displayHref.lastIndexOf("\\"));
	const base = slashIndex === -1 ? target.displayHref : target.displayHref.slice(slashIndex + 1);
	return base || target.displayHref;
};

const registerFootnoteItem = (state: FileFootnoteState, href: string): FileFootnoteItem => {
	const existing = state.itemByHref.get(href);
	if (existing) return existing;
	const target = parseFileTarget(href);
	const item: FileFootnoteItem = {
		index: state.items.length + 1,
		href,
		displayHref: target.displayHref,
		filesystemPath: target.filesystemPath,
		line: target.line,
		column: target.column,
		openUrl: buildDefaultOpenUrl(target),
		vscodeUrl: buildVsCodeUrl(target),
	};
	state.items.push(item);
	state.itemByHref.set(href, item);
	return item;
};

const registerFootnote = (markdown: MarkdownWithFootnotes, href: string): FileFootnoteItem | undefined => {
	const state = markdown[FOOTNOTE_STATE];
	if (!state) return undefined;
	return registerFootnoteItem(state, href);
};

const buildFootnoteHeaderLine = (expanded: boolean, itemCount: number): string => {
	if (expanded) return `${rawKeyHint(FOOTNOTE_TOGGLE_SHORTCUT, "to hide file footnotes")}`;
	const noun = itemCount === 1 ? "reference" : "references";
	return `${itemCount} file ${noun} hidden ${rawKeyHint(FOOTNOTE_TOGGLE_SHORTCUT, "to show")}`;
};

const extractFileFootnotesFromText = (text: string): FileFootnoteItem[] => {
	const state: FileFootnoteState = {
		items: [],
		itemByHref: new Map<string, FileFootnoteItem>(),
	};
	for (const href of collectMarkdownFileHrefs(text.replace(/\t/g, "   "))) {
		registerFootnoteItem(state, href);
	}
	return state.items;
};

const buildFootnoteLines = (markdown: MarkdownWithFootnotes, width: number, items: FileFootnoteItem[]): string[] => {
	if (items.length === 0) return [];
	const contentWidth = Math.max(1, width - markdown.paddingX * 2);
	const leftMargin = " ".repeat(markdown.paddingX);
	const rightMargin = " ".repeat(markdown.paddingX);
	const expanded = getFileFootnotesExpanded();
	const rawLines = ["", markdown.theme.linkUrl(buildFootnoteHeaderLine(expanded, items.length))];
	if (expanded) {
		for (const item of items) {
			let line = `${markdown.theme.linkUrl(`[${item.index}] `)}${formatHyperlink(item.openUrl, markdown.theme.link(markdown.theme.underline(item.displayHref)))}`;
			if (item.vscodeUrl) {
				line += ` ${formatHyperlink(item.vscodeUrl, markdown.theme.link(markdown.theme.underline("VS Code")))}`;
			}
			rawLines.push(line);
		}
	}
	const rendered: string[] = [];
	for (const rawLine of rawLines) {
		if (!rawLine) {
			rendered.push(" ".repeat(width));
			continue;
		}
		const wrapped = wrapTextWithAnsi(rawLine, contentWidth);
		for (const wrappedLine of wrapped) {
			const lineWithMargins = leftMargin + wrappedLine + rightMargin;
			const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
			rendered.push(lineWithMargins + " ".repeat(paddingNeeded));
		}
	}
	return rendered;
};

const patchAssistantMessageRendering = () => {
	const globalScope = globalThis as Record<PropertyKey, unknown>;
	if (globalScope[PATCHED]) return;
	globalScope[PATCHED] = true;

	const originalCreateExtensionUIContext = InteractiveMode.prototype.createExtensionUIContext;
	InteractiveMode.prototype.createExtensionUIContext = function () {
		const uiContext = originalCreateExtensionUIContext.call(this) as Record<string, unknown>;
		uiContext.fullRedraw = () => {
			this.ui.requestRender(true);
		};
		return uiContext;
	};

	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	AssistantMessageComponent.prototype.updateContent = function (message: any) {
		originalUpdateContent.call(this, message);
		for (const child of this.contentContainer.children) {
			if (child instanceof Markdown) {
				(child as MarkdownWithFootnotes)[ASSISTANT_MARKDOWN] = true;
			}
		}
	};

	const originalInvalidate = Markdown.prototype.invalidate;
	Markdown.prototype.invalidate = function () {
		delete (this as MarkdownWithFootnotes)[PATCHED_CACHE];
		return originalInvalidate.call(this);
	};

	const originalRenderInlineTokens = Markdown.prototype.renderInlineTokens;
	Markdown.prototype.renderInlineTokens = function (tokens: any[], styleContext?: { applyText: (text: string) => string; stylePrefix: string }) {
		const markdown = this as MarkdownWithFootnotes;
		if (!markdown[ASSISTANT_MARKDOWN] || !markdown[FOOTNOTE_STATE]) {
			return originalRenderInlineTokens.call(this, tokens, styleContext);
		}
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string) => text.split("\n").map((segment) => applyText(segment)).join("\n");
		for (const token of tokens) {
			switch (token.type) {
				case "text":
					if (token.tokens && token.tokens.length > 0) result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					else result += applyTextWithNewlines(token.text);
					break;
				case "paragraph":
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;
				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}
				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}
				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;
				case "link": {
					const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
					if (!isFileHref(token.href)) {
						const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
						if (token.text === token.href || token.text === hrefForComparison) {
							result += this.theme.link(this.theme.underline(linkText)) + stylePrefix;
						} else {
							result +=
								this.theme.link(this.theme.underline(linkText)) +
								this.theme.linkUrl(` (${token.href})`) +
								stylePrefix;
						}
						break;
					}
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const visibleLinkText = stripAnsi(linkText).trim();
					const inlineLabel =
						token.text === token.href || token.text === hrefForComparison || visibleLinkText.length === 0
							? deriveInlineLabel(token.href)
							: linkText;
					const footnoteItem = registerFootnote(markdown, token.href);
					const inlineLink = footnoteItem
						? formatHyperlink(footnoteItem.openUrl, this.theme.link(this.theme.underline(inlineLabel)))
						: this.theme.link(this.theme.underline(inlineLabel));
					result += inlineLink + this.theme.linkUrl(`[${footnoteItem?.index ?? 0}]`) + stylePrefix;
					break;
				}
				case "br":
					result += "\n";
					break;
				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}
				case "html":
					if ("raw" in token && typeof token.raw === "string") result += applyTextWithNewlines(token.raw);
					break;
				default:
					if ("text" in token && typeof token.text === "string") result += applyTextWithNewlines(token.text);
			}
		}
		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}
		return result;
	};

	const originalRender = Markdown.prototype.render;
	Markdown.prototype.render = function (width: number) {
		const markdown = this as MarkdownWithFootnotes;
		if (!markdown[ASSISTANT_MARKDOWN] || markdown.defaultTextStyle?.bgColor) {
			return originalRender.call(this, width);
		}
		const expanded = getFileFootnotesExpanded();
		const cached = markdown[PATCHED_CACHE];
		if (cached && cached.text === this.text && cached.width === width && cached.expanded === expanded) {
			return cached.lines;
		}
		const previousCachedText = markdown.cachedText;
		const previousCachedWidth = markdown.cachedWidth;
		const previousCachedLines = markdown.cachedLines;
		markdown.cachedText = undefined;
		markdown.cachedWidth = undefined;
		markdown.cachedLines = undefined;
		markdown[FOOTNOTE_STATE] = {
			items: [],
			itemByHref: new Map<string, FileFootnoteItem>(),
		};
		try {
			const lines = originalRender.call(this, width) as string[];
			const items = markdown[FOOTNOTE_STATE]?.items || [];
			const rendered = items.length > 0 ? [...lines, ...buildFootnoteLines(markdown, width, items)] : lines;
			markdown[PATCHED_CACHE] = {
				text: this.text,
				width,
				lines: rendered,
				expanded,
			};
			return rendered;
		} finally {
			delete markdown[FOOTNOTE_STATE];
			markdown.cachedText = previousCachedText;
			markdown.cachedWidth = previousCachedWidth;
			markdown.cachedLines = previousCachedLines;
		}
	};
};

const getLatestAssistantText = (ctx: { sessionManager: { getBranch: () => any[] } }): { text?: string; error?: string } => {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason !== "stop") {
			return { error: `Last assistant message incomplete (${message.stopReason})` };
		}
		const textParts = Array.isArray(message.content)
			? message.content
					.filter((content): content is { type: "text"; text: string } => content?.type === "text" && typeof content.text === "string")
					.map((content) => content.text)
			: [];
		return { text: textParts.join("\n") };
	}
	return { error: "No assistant messages found" };
};

const openUriWithSystem = async (pi: ExtensionAPI, uri: string): Promise<void> => {
	if (process.platform === "darwin") {
		await pi.exec("open", [uri], { timeout: 5000 });
		return;
	}
	if (process.platform === "win32") {
		await pi.exec("cmd", ["/c", "start", "", uri], { timeout: 5000 });
		return;
	}
	await pi.exec("xdg-open", [uri], { timeout: 5000 });
};

const openFootnoteInVsCode = async (pi: ExtensionAPI, item: FileFootnoteItem): Promise<void> => {
	if (!item.filesystemPath) throw new Error(`No local filesystem path for footnote [${item.index}]`);
	const target = item.line ? `${item.filesystemPath}:${item.line}${item.column ? `:${item.column}` : ""}` : item.filesystemPath;
	try {
		const result = await pi.exec("code", item.line ? ["--goto", target] : [item.filesystemPath], { timeout: 5000 });
		if (result.code === 0) return;
	} catch {
		// Fall back to URL scheme if the code CLI is unavailable.
	}
	if (!item.vscodeUrl) throw new Error(`No VS Code URL for footnote [${item.index}]`);
	await openUriWithSystem(pi, item.vscodeUrl);
};

const openFootnoteNormally = async (pi: ExtensionAPI, item: FileFootnoteItem): Promise<void> => {
	if (!item.openUrl) throw new Error(`No open URL for footnote [${item.index}]`);
	await openUriWithSystem(pi, item.openUrl);
};

export default function fileFootnotesExtension(pi: ExtensionAPI) {
	setFileFootnotesExpanded(false);
	patchAssistantMessageRendering();
	pi.registerShortcut?.(FOOTNOTE_TOGGLE_SHORTCUT, {
		description: "Collapse or expand file footnotes",
		handler: (ctx) => {
			const expanded = toggleFileFootnotesExpanded();
			ctx.ui.notify(`File footnotes ${expanded ? "expanded" : "collapsed"}`, "info");
			(ctx.ui as { fullRedraw?: () => void }).fullRedraw?.();
		},
	});
	pi.registerCommand?.("file-footnotes", {
		description: "Open file footnotes from the latest assistant message",
		handler: async (args, ctx) => {
			const latestAssistant = getLatestAssistantText(ctx);
			if (latestAssistant.error) {
				ctx.ui.notify(latestAssistant.error, latestAssistant.error.includes("incomplete") ? "error" : "warning");
				return;
			}

			const items = extractFileFootnotesFromText(latestAssistant.text ?? "");
			if (items.length === 0) {
				ctx.ui.notify("No file footnotes found in the latest assistant message", "warning");
				return;
			}

			const trimmed = args.trim();
			const openAction = async (mode: "open" | "vscode", index: number) => {
				const item = items.find((item) => item.index === index);
				if (!item) throw new Error(`Unknown footnote index: ${index}`);
				if (mode === "vscode") await openFootnoteInVsCode(pi, item);
				else await openFootnoteNormally(pi, item);
				ctx.ui.notify(`Opened footnote [${index}] ${mode === "vscode" ? "in VS Code" : "with the system opener"}`, "info");
			};

			try {
				if (trimmed) {
					const match = /^(open|vscode)\s+(\d+)$/.exec(trimmed);
					if (!match) {
						ctx.ui.notify("Usage: /file-footnotes [open|vscode] <index>", "warning");
						return;
					}
					await openAction(match[1] as "open" | "vscode", Number(match[2]));
					return;
				}

				const labels = items.map((item) => `[${item.index}] ${item.displayHref}`);
				const selectedLabel = await ctx.ui.select("Open file footnote", labels);
				if (!selectedLabel) return;
				const selectedIndex = labels.indexOf(selectedLabel);
				if (selectedIndex === -1) return;
				const action = await ctx.ui.select("Open how?", ["Open path", "Open in VS Code"]);
				if (!action) return;
				await openAction(action === "Open in VS Code" ? "vscode" : "open", items[selectedIndex]!.index);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to open file footnote";
				ctx.ui.notify(message, "error");
			}
		},
	});
}
