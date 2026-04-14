import fileFootnotesExtension from "../extensions/file-footnotes.ts";
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
				"- [Pi docs](https://pi.dev)",
			].join("\n"),
		},
	],
	stopReason: "stop",
});

const lines = component.render(120).map(stripAnsi).filter((line) => line.trim().length > 0);
const readmeLine = lines.find((line) => line.includes("README.md"));
const configLine = lines.find((line) => line.includes("config.ts"));
const docsLine = lines.find((line) => line.includes("Pi docs"));
const readmeFootnote = lines.find((line) => line.includes("[1]") && line.includes("/Users/jonas/repos/pi-tools/README.md"));
const configFootnote = lines.find(
	(line) => line.includes("[2]") && line.includes("/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts"),
);

if (!readmeLine || readmeLine.includes("(/Users/jonas/repos/pi-tools/README.md)")) {
	throw new Error("expected file link path to be removed from the inline README.md bullet");
}
if (!configLine || configLine.includes("(/Users/jonas/repos/pi-tools/extensions/structured-compaction/config.ts)")) {
	throw new Error("expected file link path to be removed from the inline config.ts bullet");
}
if (!readmeLine.includes("[1]")) {
	throw new Error("expected inline numbered footnote for README.md");
}
if (!configLine.includes("[2]")) {
	throw new Error("expected inline numbered footnote for config.ts");
}
if (!readmeFootnote || !configFootnote) {
	throw new Error("expected numbered footnote lines with full file paths");
}
if (!docsLine || !docsLine.includes("(https://pi.dev)")) {
	throw new Error("expected non-file links to keep Pi's normal inline rendering");
}

console.log(
	JSON.stringify(
		{
			readmeLine,
			configLine,
			readmeFootnote,
			configFootnote,
			docsLine,
		},
		null,
		2,
	),
);
