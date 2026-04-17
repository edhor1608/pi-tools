import fileFootnotesExtension, { setFileFootnotesExpanded } from "../extensions/file-footnotes.ts";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piCodingAgentEntry = new URL(await import.meta.resolve("@mariozechner/pi-coding-agent"));
const piCodingAgentDistDir = dirname(piCodingAgentEntry.pathname);
const { AssistantMessageComponent } = await import(
	pathToFileURL(join(piCodingAgentDistDir, "modes", "interactive", "components", "assistant-message.js")).href,
);

const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");

initTheme("dark");
fileFootnotesExtension({} as any);

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

if (!readmeLine || readmeLine.includes("(/Users/jonas/repos/pi-tools/README.md)")) {
	throw new Error("expected file link path to be removed from the inline README.md bullet");
}
if (!configLine || configLine.includes("(/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts)")) {
	throw new Error("expected file link path to be removed from the inline config.ts bullet");
}
if (!worktreeLine || worktreeLine.includes("(/Users/jonas/repos/pi-tools)")) {
	throw new Error("expected file link path to be removed from the inline worktree bullet");
}
if (!readmeLine.includes("[1]")) {
	throw new Error("expected inline numbered footnote for README.md");
}
if (!configLine.includes("[2]")) {
	throw new Error("expected inline numbered footnote for config.ts");
}
if (!worktreeLine.includes("[3]")) {
	throw new Error("expected inline numbered footnote for worktree root");
}
if (!collapsedSummary || !collapsedSummary.includes("ctrl+shift+o to show")) {
	throw new Error("expected collapsed footnote summary with the toggle hotkey");
}
if (collapsedLines.some((line) => line.includes("[1]") && line.includes("/Users/jonas/repos/pi-tools/README.md"))) {
	throw new Error("expected full footnote paths to stay hidden while collapsed");
}
if (!docsLine || !docsLine.includes("(https://pi.dev)")) {
	throw new Error("expected non-file links to keep Pi's normal inline rendering");
}

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

if (!expandedHint) {
	throw new Error("expected expanded footnotes to render a collapse hint");
}
if (!readmeFootnote || !configFootnote || !worktreeFootnote) {
	throw new Error("expected expanded footnotes to render full file and path targets");
}
if (vscodeLines.length < 3) {
	throw new Error("expected every expanded file footnote to offer a VS Code link");
}
if (!expandedRawLines.some((line) => line.includes("vscode://file/Users/jonas/repos/pi-tools/README.md"))) {
	throw new Error("expected README.md footnote to include a VS Code hyperlink target");
}
if (!expandedRawLines.some((line) => line.includes("vscode://file/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts"))) {
	throw new Error("expected config.ts footnote to include a VS Code hyperlink target");
}
if (!expandedRawLines.some((line) => line.includes("vscode://file/Users/jonas/repos/pi-tools\x07"))) {
	throw new Error("expected worktree root footnote to include a VS Code hyperlink target");
}

console.log(
	JSON.stringify(
		{
			readmeLine,
			configLine,
			worktreeLine,
			collapsedSummary,
			expandedHint,
			readmeFootnote,
			configFootnote,
			worktreeFootnote,
			vscodeLines,
			docsLine,
		},
		null,
		2,
	),
);
