import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import worktreesExtension from "../extensions/worktrees.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const tempRoot = mkdtempSync(join(tmpdir(), "pi-worktrees-extension-"));
const repo = join(tempRoot, "repo");
const managedRoot = join(tempRoot, "worktrees");

mkdirSync(join(repo, ".pi"), { recursive: true });

const run = (cwd: string, command: string, args: string[]) => {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
};

const notifications: Array<{ level: string; message: string }> = [];
const sentMessages: any[] = [];
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const tools: any[] = [];
const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();

const api = {
	registerMessageRenderer() {},
	registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
		commands.set(name, spec);
	},
	registerTool(tool: any) {
		tools.push(tool);
	},
	on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	sendMessage(message: any) {
		sentMessages.push(message);
	},
	async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
		const result = spawnSync(command, args, {
			cwd: options?.cwd,
			encoding: "utf8",
			timeout: options?.timeout,
		});
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.status ?? 1,
			killed: Boolean(result.signal),
		};
	},
} as any;

try {
	writeFileSync(
		join(repo, ".pi", "worktrees.json"),
		`${JSON.stringify({ root: managedRoot, autoSetup: false, enableInputTrigger: true, triggerMinConfidence: "high" }, null, 2)}\n`,
		"utf8",
	);
	run(tempRoot, "mkdir", ["-p", repo]);
	run(repo, "git", ["init", "-q", "-b", "main"]);
	run(repo, "git", ["config", "user.name", "Test User"]);
	run(repo, "git", ["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
	run(repo, "git", ["add", "README.md"]);
	run(repo, "git", ["commit", "-q", "-m", "init"]);

	worktreesExtension(api);

	assert(commands.has("worktrees"), "expected /worktrees command to register");
	assert(tools.some((tool) => tool.name === "ensure_worktree"), "expected ensure_worktree tool to register");
	const inputHandler = handlers.get("input")?.[0];
	assert(inputHandler, "expected input handler to register");

	const baseCtx = {
		cwd: repo,
		hasUI: true,
		ui: {
			async select(title: string, items: string[]) {
				if (title === "Worktree needed") return items.find((item) => item === "Create a new worktree");
				if (title === "Choose a base ref") return items.find((item) => item.includes("current branch main"));
				return items[0];
			},
			async confirm() {
				return false;
			},
			async input() {
				return undefined;
			},
			notify(message: string, level: string) {
				notifications.push({ level, message });
			},
		},
	};

	const genericResult = await inputHandler({ text: "explain cache behavior", source: "interactive" }, baseCtx);
	assert(genericResult?.action === "continue", "expected generic prompt to pass through input trigger");

	const extensionResult = await inputHandler({ text: "review pr 55", source: "extension" }, baseCtx);
	assert(extensionResult?.action === "continue", "expected extension-originated prompt to bypass input trigger");

	sentMessages.length = 0;
	notifications.length = 0;
	const prResult = await inputHandler(
		{ text: "review https://github.com/org/repo/pull/1234", source: "interactive" },
		baseCtx,
	);
	assert(prResult?.action === "handled", "expected strong PR signal to be handled by input trigger");
	assert(sentMessages.some((message) => message.customType === "worktrees-report"), "expected trigger to emit a worktrees report");
	assert(
		sentMessages.some((message) => typeof message.content === "string" && message.content.includes("Original prompt:")),
		"expected trigger report to include the original prompt",
	);
	assert(notifications.some((notification) => notification.message.includes("Created worktree")), "expected trigger to notify after creating a worktree");
	assert(existsSync(join(managedRoot, "local", "repo", "pr-1234")), "expected trigger flow to create the managed worktree path");

	console.log(
		JSON.stringify(
			{
				commandRegistered: commands.has("worktrees"),
				toolNames: tools.map((tool) => tool.name),
				genericResult,
				extensionResult,
				prResult,
				notifications,
				sentMessages,
			},
			null,
			2,
		),
	);
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
