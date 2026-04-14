import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/system-prompt.js";
import contextFilesExtension, { filterSystemPrompt } from "../extensions/context-files.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-context-files-"));
const agentDir = join(tempRoot, "agent");
const repo = join(tempRoot, "repo");

mkdirSync(agentDir, { recursive: true });
mkdirSync(join(repo, ".pi"), { recursive: true });

const globalPath = join(agentDir, "AGENTS.md");
const repoPath = join(repo, "AGENTS.md");

writeFileSync(globalPath, "GLOBAL RULES\n", "utf-8");
writeFileSync(repoPath, "PROJECT RULES\n", "utf-8");
writeFileSync(
	join(repo, ".pi", "context-files.json"),
	`${JSON.stringify({ version: 1, disabledPaths: [globalPath] }, null, 2)}\n`,
	"utf-8",
);

const systemPrompt = buildSystemPrompt({
	cwd: repo,
	contextFiles: [
		{ path: globalPath, content: "GLOBAL RULES\n" },
		{ path: repoPath, content: "PROJECT RULES\n" },
	],
	selectedTools: ["read", "bash", "edit", "write"],
	toolSnippets: {
		read: "Read files",
		bash: "Run shell commands",
		edit: "Edit files",
		write: "Write files",
	},
});

const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();

const api = {
	on() {},
	registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
		commands.set(name, spec);
	},
} as any;

contextFilesExtension(api);

if (!commands.has("context-files")) {
	throw new Error("missing /context-files command");
}

const filteredPrompt = filterSystemPrompt(systemPrompt, repo, agentDir);
if (filteredPrompt.includes("GLOBAL RULES")) {
	throw new Error("disabled global context file should be removed from the final system prompt");
}
if (!filteredPrompt.includes("PROJECT RULES")) {
	throw new Error("enabled project context file should remain in the final system prompt");
}
if (!filteredPrompt.includes("# Project Context")) {
	throw new Error("expected project context section to remain while at least one file is enabled");
}

writeFileSync(
	join(repo, ".pi", "context-files.json"),
	`${JSON.stringify({ version: 1, disabledPaths: [globalPath, repoPath] }, null, 2)}\n`,
	"utf-8",
);
const emptyContextPrompt = filterSystemPrompt(systemPrompt, repo, agentDir);
if (typeof emptyContextPrompt !== "string") {
	throw new Error("expected filtered system prompt when all context files are disabled");
}
if (emptyContextPrompt.includes("GLOBAL RULES") || emptyContextPrompt.includes("PROJECT RULES")) {
	throw new Error("all disabled context files should be removed");
}
if (emptyContextPrompt.includes("# Project Context")) {
	throw new Error("project context section should be removed when all files are disabled");
}
if (!emptyContextPrompt.includes("Current date:")) {
	throw new Error("date footer should remain after context filtering");
}

console.log(
	JSON.stringify(
		{
			commandRegistered: commands.has("context-files"),
			filteredHasProject: filteredPrompt.includes("PROJECT RULES"),
			filteredHasGlobal: filteredPrompt.includes("GLOBAL RULES"),
			emptyContextHasSection: emptyContextPrompt.includes("# Project Context"),
		},
		null,
		2,
	),
);
