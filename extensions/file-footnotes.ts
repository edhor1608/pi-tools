import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, wrapTextWithAnsi, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piCodingAgentEntry = new URL(await import.meta.resolve("@mariozechner/pi-coding-agent"));
const piCodingAgentDistDir = dirname(piCodingAgentEntry.pathname);
const { AssistantMessageComponent } = await import(
	pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "components", "assistant-message.js")).href,
);

const PATCHED = Symbol.for("stead.pi-tools.fileFootnotes.patched");
const ASSISTANT_MARKDOWN = Symbol.for("stead.pi-tools.fileFootnotes.assistantMarkdown");
const FOOTNOTE_STATE = Symbol.for("stead.pi-tools.fileFootnotes.state");
const PATCHED_CACHE = Symbol.for("stead.pi-tools.fileFootnotes.cache");

interface FileFootnoteItem {
	index: number;
	href: string;
}

interface FileFootnoteState {
	items: FileFootnoteItem[];
	indexByHref: Map<string, number>;
}

interface MarkdownWithFootnotes extends Markdown {
	[ASSISTANT_MARKDOWN]?: boolean;
	[FOOTNOTE_STATE]?: FileFootnoteState;
	[PATCHED_CACHE]?: {
		text: string;
		width: number;
		lines: string[];
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

const splitLocationSuffix = (href: string): { pathPart: string; suffix: string } => {
	if (href.startsWith("file://")) {
		try {
			const url = new URL(href);
			const pathPart = url.pathname || href;
			const suffix = url.hash || "";
			return { pathPart, suffix };
		} catch {
			return { pathPart: href, suffix: "" };
		}
	}
	const hashIndex = href.lastIndexOf("#L");
	if (hashIndex !== -1) {
		return { pathPart: href.slice(0, hashIndex), suffix: href.slice(hashIndex) };
	}
	const lastSlash = Math.max(href.lastIndexOf("/"), href.lastIndexOf("\\"));
	const lastColon = href.lastIndexOf(":");
	if (lastColon > lastSlash && /^:\d+(?::\d+)?$/.test(href.slice(lastColon))) {
		return { pathPart: href.slice(0, lastColon), suffix: href.slice(lastColon) };
	}
	return { pathPart: href, suffix: "" };
};

const deriveInlineLabel = (href: string): string => {
	const { pathPart, suffix } = splitLocationSuffix(href);
	const slashIndex = Math.max(pathPart.lastIndexOf("/"), pathPart.lastIndexOf("\\"));
	const base = slashIndex === -1 ? pathPart : pathPart.slice(slashIndex + 1);
	return `${base || pathPart}${suffix}`;
};

const registerFootnote = (markdown: MarkdownWithFootnotes, href: string): number => {
	const state = markdown[FOOTNOTE_STATE];
	if (!state) return 0;
	const existing = state.indexByHref.get(href);
	if (existing) return existing;
	const index = state.items.length + 1;
	state.items.push({ index, href });
	state.indexByHref.set(href, index);
	return index;
};

const buildFootnoteLines = (markdown: MarkdownWithFootnotes, width: number, items: FileFootnoteItem[]): string[] => {
	if (items.length === 0) return [];
	const contentWidth = Math.max(1, width - markdown.paddingX * 2);
	const leftMargin = " ".repeat(markdown.paddingX);
	const rightMargin = " ".repeat(markdown.paddingX);
	const rawLines = [""];
	for (const item of items) {
		rawLines.push(`${markdown.theme.linkUrl(`[${item.index}] `)}${markdown.theme.link(markdown.theme.underline(item.href))}`);
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
					const footnoteIndex = registerFootnote(markdown, token.href);
					result +=
						this.theme.link(this.theme.underline(inlineLabel)) +
						this.theme.linkUrl(`[${footnoteIndex}]`) +
						stylePrefix;
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
		const cached = markdown[PATCHED_CACHE];
		if (cached && cached.text === this.text && cached.width === width) {
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
			indexByHref: new Map<string, number>(),
		};
		try {
			const lines = originalRender.call(this, width) as string[];
			const items = markdown[FOOTNOTE_STATE]?.items || [];
			const rendered = items.length > 0 ? [...lines, ...buildFootnoteLines(markdown, width, items)] : lines;
			markdown[PATCHED_CACHE] = {
				text: this.text,
				width,
				lines: rendered,
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

export default function fileFootnotesExtension(_pi: ExtensionAPI) {
	patchAssistantMessageRendering();
}
