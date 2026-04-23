import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import contextFilesExtension, { discoverContextFiles, filterSystemPrompt } from "../extensions/context-files.ts";

const piCodingAgentEntry = new URL(await import.meta.resolve("@mariozechner/pi-coding-agent"));
const piCodingAgentDistDir = dirname(piCodingAgentEntry.pathname);
const { buildSystemPrompt } = await import(pathToFileURL(join(piCodingAgentDistDir, "core", "system-prompt.js")).href);

const tempRoot = mkdtempSync(join(tmpdir(), "pi-context-files-"));
const agentDir = join(tempRoot, "agent");
const workspace = join(tempRoot, "workspace");
const repo = join(workspace, "repo");

mkdirSync(agentDir, { recursive: true });
mkdirSync(repo, { recursive: true });
mkdirSync(join(repo, ".pi"), { recursive: true });

const globalPath = join(agentDir, "AGENTS.md");
const workspacePath = join(workspace, "AGENTS.md");
const repoPath = join(repo, "AGENTS.md");

writeFileSync(globalPath, "GLOBAL RULES\n", "utf-8");
writeFileSync(workspacePath, "WORKSPACE RULES\n", "utf-8");
writeFileSync(repoPath, "PROJECT RULES\n", "utf-8");
writeFileSync(
	join(repo, ".pi", "context-files.json"),
	`${JSON.stringify({ version: 1, disabledPaths: [globalPath] }, null, 2)}\n`,
	"utf-8",
);

const discovered = discoverContextFiles(repo, agentDir).map((file) => file.path);
const expectedDiscovered = [globalPath, workspacePath, repoPath];
if (JSON.stringify(discovered) !== JSON.stringify(expectedDiscovered)) {
	throw new Error(`expected core context-file discovery order ${expectedDiscovered.join(", ")}, got ${discovered.join(", ")}`);
}

const systemPrompt = buildSystemPrompt({
	cwd: repo,
	contextFiles: expectedDiscovered.map((path) => ({
		path,
		content: path === globalPath ? "GLOBAL RULES\n" : path === workspacePath ? "WORKSPACE RULES\n" : "PROJECT RULES\n",
	})),
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
if (!filteredPrompt.includes("WORKSPACE RULES") || !filteredPrompt.includes("PROJECT RULES")) {
	throw new Error("enabled ancestor and project context files should remain in the final system prompt");
}
if (!filteredPrompt.includes("# Project Context")) {
	throw new Error("expected project context section to remain while at least one file is enabled");
}

writeFileSync(
	join(repo, ".pi", "context-files.json"),
	`${JSON.stringify({ version: 1, disabledPaths: [globalPath, workspacePath, repoPath] }, null, 2)}\n`,
	"utf-8",
);
const emptyContextPrompt = filterSystemPrompt(systemPrompt, repo, agentDir);
if (typeof emptyContextPrompt !== "string") {
	throw new Error("expected filtered system prompt when all context files are disabled");
}
if (emptyContextPrompt.includes("GLOBAL RULES") || emptyContextPrompt.includes("WORKSPACE RULES") || emptyContextPrompt.includes("PROJECT RULES")) {
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
			discovered,
			filteredHasWorkspace: filteredPrompt.includes("WORKSPACE RULES"),
			filteredHasProject: filteredPrompt.includes("PROJECT RULES"),
			filteredHasGlobal: filteredPrompt.includes("GLOBAL RULES"),
			emptyContextHasSection: emptyContextPrompt.includes("# Project Context"),
		},
		null,
		2,
	),
);
