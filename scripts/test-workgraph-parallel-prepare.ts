import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import parallelExtension from "../extensions/parallel.ts";
import workgraphExtension from "../extensions/workgraph.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-workgraph-prepare-"));
const repo = join(tempRoot, "repo");

const run = (cwd: string, command: string, args: string[]) => {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
};

run(tempRoot, "mkdir", ["-p", repo]);
run(repo, "git", ["init", "-q"]);
run(repo, "git", ["config", "user.name", "Test User"]);
run(repo, "git", ["config", "user.email", "test@example.com"]);
writeFileSync(join(repo, "README.md"), "hello\n");
run(repo, "git", ["add", "README.md"]);
run(repo, "git", ["commit", "-q", "-m", "init"]);

const branch: any[] = [];
const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
const messages: any[] = [];
const notifications: string[] = [];

const api = {
	on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
		handlers.set(event, handler);
	},
	registerMessageRenderer() {},
	registerTool() {},
	registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
		commands.set(name, spec.handler);
	},
	appendEntry(customType: string, data: unknown) {
		branch.push({ type: "custom", customType, data });
	},
	sendMessage(message: any) {
		messages.push(message);
	},
} as any;

workgraphExtension(api);
parallelExtension(api);

const ctx = {
	cwd: repo,
	hasUI: false,
	ui: {
		theme: {
			fg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		},
		notify(message: string) {
			notifications.push(message);
		},
		setStatus() {},
		setWidget() {},
	},
	sessionManager: {
		getBranch() {
			return branch;
		},
		getSessionName() {
			return "prepare parallel helper";
		},
	},
};

const sessionStart = handlers.get("session_start");
if (!sessionStart) throw new Error("missing session_start handler");
await sessionStart({ type: "session_start", reason: "startup" }, ctx);

const item = commands.get("item");
if (!item) throw new Error("missing /item command");
await item("add parallel build parallel helper", ctx);

const parallel = commands.get("parallel");
if (!parallel) throw new Error("missing /parallel command");
await parallel("prepare", ctx);

const state = branch.filter((entry) => entry.customType === "workgraph-state").at(-1)?.data;
if (!state || !Array.isArray(state.items)) throw new Error("missing workgraph state");
const prepared = state.items.find((candidate: any) => candidate.execution === "parallel");
if (!prepared) throw new Error("missing prepared parallel item");
if (!prepared.worktreePath || !prepared.branchName || !prepared.workerPrompt) {
	throw new Error("missing prepared workspace metadata");
}
if (!existsSync(prepared.worktreePath)) throw new Error(`missing worktree path ${prepared.worktreePath}`);
if (!messages.some((message) => message.customType === "parallel-report")) throw new Error("missing parallel report message");
if (!notifications.some((message) => message.includes("Prepared worktree"))) throw new Error("missing prepare notification");

console.log(
	JSON.stringify(
		{
			worktreePath: prepared.worktreePath,
			branchName: prepared.branchName,
			messageCount: messages.length,
			notifications,
		},
		null,
		2,
	),
);

rmSync(tempRoot, { recursive: true, force: true });
