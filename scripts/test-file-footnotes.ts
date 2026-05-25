import fileFootnotesExtension, { setFileFootnotesExpanded } from "../extensions/file-footnotes.ts";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, setCapabilities } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piCodingAgentEntry = new URL(await import.meta.resolve("@mariozechner/pi-coding-agent"));
const piCodingAgentDistDir = dirname(piCodingAgentEntry.pathname);
const { AssistantMessageComponent } = await import(
	pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "components", "assistant-message.js")).href,
);
const { getMarkdownTheme } = await import(
	pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "theme", "theme.js")).href,
);

const stripAnsi = (value: string): string =>
	value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

interface ExecCall {
	command: string;
	args: string[];
}

let fileFootnotesCommand: ((args: string, ctx: any) => Promise<void>) | undefined;
const execCalls: ExecCall[] = [];

const piMock = {
	async exec(command: string, args: string[]) {
		execCalls.push({ command, args });
		if (command === "code") {
			return { code: 1, stdout: "", stderr: "missing code cli" };
		}
		return { code: 0, stdout: "", stderr: "" };
	},
	registerCommand(name: string, config: { handler: (args: string, ctx: any) => Promise<void> }) {
		if (name === "file-footnotes") fileFootnotesCommand = config.handler;
	},
	registerShortcut() {},
};

const createCommandContext = (messages: any[]) => {
	const notifications: Array<{ level: string; message: string }> = [];
	return {
		notifications,
		ctx: {
			sessionManager: {
				getBranch: () => messages.map((message, index) => ({ id: `entry-${index + 1}`, type: "message", message })),
			},
			ui: {
				notify(message: string, level: string) {
					notifications.push({ level, message });
				},
				async select() {
					return null;
				},
			},
		},
	};
};

initTheme("dark");
setCapabilities({ images: null, trueColor: true, hyperlinks: true });
fileFootnotesExtension(piMock as any);
assert(fileFootnotesCommand, "expected /file-footnotes command to register");

setFileFootnotesExpanded(false);

const component = new AssistantMessageComponent({
	role: "assistant",
	content: [
		{
			type: "text",
			text: [
				"Changed files:",
				"- [README.md](/Users/jonas/repos/pi-tools/README.md)",
				"- [config.ts](/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts)",
				"- [worktree root](/Users/jonas/repos/pi-tools)",
				"- [Pi docs](https://pi.dev)",
			].join("\n"),
		},
	],
	stopReason: "stop",
});

const collapsedRawLines = component.render(120);
const collapsedLines = collapsedRawLines.map(stripAnsi).filter((line) => line.trim().length > 0);
const readmeLine = collapsedLines.find((line) => line.includes("README.md"));
const configLine = collapsedLines.find((line) => line.includes("config.ts"));
const worktreeLine = collapsedLines.find((line) => line.includes("worktree root"));
const docsLine = collapsedLines.find((line) => line.includes("Pi docs"));
const collapsedSummary = collapsedLines.find((line) => line.includes("file references hidden"));

assert(readmeLine && !readmeLine.includes("(/Users/jonas/repos/pi-tools/README.md)"), "expected file link path to be removed from the inline README.md bullet");
assert(
	configLine && !configLine.includes("(/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts)"),
	"expected file link path to be removed from the inline config.ts bullet",
);
assert(worktreeLine && !worktreeLine.includes("(/Users/jonas/repos/pi-tools)"), "expected file link path to be removed from the inline worktree bullet");
assert(readmeLine.includes("[1]"), "expected inline numbered footnote for README.md");
assert(configLine.includes("[2]"), "expected inline numbered footnote for config.ts");
assert(worktreeLine.includes("[3]"), "expected inline numbered footnote for worktree root");
assert(collapsedSummary && collapsedSummary.includes("ctrl+shift+o to show"), "expected collapsed footnote summary with the toggle hotkey");
assert(
	!collapsedLines.some((line) => line.includes("[1]") && line.includes("/Users/jonas/repos/pi-tools/README.md")),
	"expected full footnote paths to stay hidden while collapsed",
);
assert(docsLine && docsLine.includes("Pi docs"), "expected non-file links to keep a visible inline label");

const webLinkText = "- [Pi docs](https://pi.dev)";
const baselineMarkdown = new Markdown(webLinkText, 1, 0, getMarkdownTheme());
const baselineWebLine = baselineMarkdown.render(120).find((line) => stripAnsi(line).includes("Pi docs"));
const assistantWebOnly = new AssistantMessageComponent({
	role: "assistant",
	content: [{ type: "text", text: webLinkText }],
	stopReason: "stop",
});
const assistantWebLine = assistantWebOnly.render(120).find((line) => stripAnsi(line).includes("Pi docs"));
assert(baselineWebLine && assistantWebLine && assistantWebLine === baselineWebLine, "expected non-file links in assistant messages to keep Pi core markdown rendering");

setFileFootnotesExpanded(true);

const expandedRawLines = component.render(120);
const expandedLines = expandedRawLines.map(stripAnsi).filter((line) => line.trim().length > 0);
const expandedHint = expandedLines.find((line) => line.includes("ctrl+shift+o to hide file footnotes"));
const readmeFootnote = expandedLines.find((line) => line.includes("[1]") && line.includes("/Users/jonas/repos/pi-tools/README.md"));
const configFootnote = expandedLines.find(
	(line) => line.includes("[2]") && line.includes("/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts"),
);
const worktreeFootnote = expandedLines.find((line) => line.includes("[3]") && line.includes("/Users/jonas/repos/pi-tools"));
const vscodeLines = expandedLines.filter((line) => line.includes("VS Code"));

assert(expandedHint, "expected expanded footnotes to render a collapse hint");
assert(readmeFootnote && configFootnote && worktreeFootnote, "expected expanded footnotes to render full file and path targets");
assert(vscodeLines.length >= 3, "expected every expanded file footnote to offer a VS Code link");
assert(
	expandedRawLines.some((line) => line.includes("vscode://file//Users/jonas/repos/pi-tools/README.md")),
	"expected README.md footnote to include a VS Code hyperlink target",
);
assert(
	expandedRawLines.some((line) => line.includes("vscode://file//Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts")),
	"expected config.ts footnote to include a VS Code hyperlink target",
);
assert(
	expandedRawLines.some((line) => line.includes("vscode://file//Users/jonas/repos/pi-tools")),
	"expected worktree root footnote to include a VS Code hyperlink target",
);

execCalls.length = 0;
const staleCommand = createCommandContext([
	{
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "- [README.md](/Users/jonas/repos/pi-tools/README.md)" }],
	},
	{
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "No files here" }],
	},
]);
await fileFootnotesCommand!("open 1", staleCommand.ctx);
assert(execCalls.length === 0, "expected /file-footnotes not to open stale footnotes from an older assistant message");
assert(
	staleCommand.notifications.some(
		(notification) => notification.level === "warning" && notification.message.includes("latest assistant message"),
	),
	"expected /file-footnotes to warn when the latest assistant message has no file footnotes",
);

execCalls.length = 0;
const encodedCommand = createCommandContext([
	{
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "- [odd file](file:///Users/jonas/My%20Folder/file%23name.ts)" }],
	},
]);
await fileFootnotesCommand!("vscode 1", encodedCommand.ctx);
const codeCall = execCalls.find((call) => call.command === "code");
const expectedFallbackCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
const fallbackOpenCall = execCalls.find((call) => call.command === expectedFallbackCommand);
const fallbackUri = process.platform === "win32" ? fallbackOpenCall?.args.at(-1) : fallbackOpenCall?.args[0];
assert(codeCall && codeCall.args[0] === "/Users/jonas/My Folder/file#name.ts", "expected VS Code fallback to try the decoded filesystem path first");
assert(
	fallbackOpenCall && fallbackUri === "vscode://file//Users/jonas/My%20Folder/file%23name.ts",
	"expected VS Code fallback URI to keep path encoding intact",
);
assert(
	encodedCommand.notifications.some(
		(notification) => notification.level === "info" && notification.message.includes("Opened footnote [1] in VS Code"),
	),
	"expected /file-footnotes vscode 1 to report success after falling back to the VS Code URI",
);

setCapabilities({ images: null, trueColor: true, hyperlinks: false });
setFileFootnotesExpanded(false);
const noHyperlinkComponent = new AssistantMessageComponent({
	role: "assistant",
	content: [{ type: "text", text: "- [README.md](/Users/jonas/repos/pi-tools/README.md)" }],
	stopReason: "stop",
});
const noHyperlinkRawLines = noHyperlinkComponent.render(120);
const noHyperlinkLine = noHyperlinkRawLines.map(stripAnsi).find((line) => line.includes("README.md"));
assert(noHyperlinkLine && noHyperlinkLine.includes("[1]"), "expected file footnote numbering to remain when hyperlinks are unavailable");
assert(
	!noHyperlinkRawLines.some((line) => line.includes("/Users/jonas/repos/pi-tools/README.md")),
	"expected file footnotes to avoid injecting hidden OSC URLs when terminal hyperlinks are disabled",
);

console.log(
	JSON.stringify(
		{
			readmeLine,
			configLine,
			worktreeLine,
			collapsedSummary,
			docsLine,
			webLinkMatchesCore: assistantWebLine === baselineWebLine,
			expandedHint,
			readmeFootnote,
			configFootnote,
			worktreeFootnote,
			vscodeLines,
			staleCommandNotifications: staleCommand.notifications,
			encodedCommandNotifications: encodedCommand.notifications,
			encodedCommandExecCalls: execCalls,
			noHyperlinkLine,
		},
		null,
		2,
	),
);
