import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getDefaultWorktreesConfig } from "../extensions/worktrees/config.ts";
import { ensureWorktree } from "../extensions/worktrees/ensure.ts";
import { getRepoContext } from "../extensions/worktrees/git.ts";
import { extractWorktreeIntent } from "../extensions/worktrees/intent.ts";
import type { ExecFn } from "../extensions/worktrees/types.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const tempRoot = mkdtempSync(join(tmpdir(), "pi-worktrees-ensure-"));
const repo = join(tempRoot, "repo");
const managedRoot = join(tempRoot, "worktrees");

mkdirSync(repo, { recursive: true });

const run = (cwd: string, command: string, args: string[]) => {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
};

const exec: ExecFn = async (command, args, options) => {
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
};

const createCtx = (cwd: string, selectHandler: (title: string, items: string[]) => string | undefined) => ({
	cwd,
	hasUI: true,
	ui: {
		async select(title: string, items: string[]) {
			const choice = selectHandler(title, items);
			if (choice === undefined) throw new Error(`No selection provided for ${title}: ${items.join(", ")}`);
			return choice;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify() {},
	},
});

try {
	run(repo, "git", ["init", "-q", "-b", "main"]);
	run(repo, "git", ["config", "user.name", "Test User"]);
	run(repo, "git", ["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
	run(repo, "git", ["add", "README.md"]);
	run(repo, "git", ["commit", "-q", "-m", "init"]);

	const repoContext = await getRepoContext(exec, repo);
	assert(repoContext, "expected repo context to resolve");

	const config = {
		...getDefaultWorktreesConfig(),
		root: managedRoot,
	};
	const intent = extractWorktreeIntent("review pr 1234");
	assert(intent.kind === "pr", "expected PR intent for ensure test");

	const created = await ensureWorktree({
		ctx: createCtx(repo, (title, items) => {
			if (title === "Choose a base ref") return items.find((item) => item.includes("current branch main"));
			return items[0];
		}),
		exec,
		config,
		repoContext,
		intent,
		mode: "reuse-or-create",
	});

	assert(created.action === "created", "expected first ensure call to create a worktree");
	assert(created.worktreePath && existsSync(created.worktreePath), "expected created worktree path to exist");
	assert(created.branchName === "pr-1234", `expected created branch to be pr-1234, got ${created.branchName}`);
	assert(created.startCommand?.includes(created.worktreePath), "expected start command to include worktree path");
	assert(run(repo, "git", ["branch", "--list", "pr-1234"]).includes("pr-1234"), "expected local branch pr-1234 to exist");

	const reused = await ensureWorktree({
		ctx: createCtx(repo, (_title, items) => items.find((item) => item.startsWith("Reuse existing worktree"))),
		exec,
		config,
		repoContext,
		intent,
		mode: "reuse-or-create",
	});

	assert(reused.action === "reused", "expected second ensure call to reuse the existing worktree");
	assert(reused.worktreePath === created.worktreePath, "expected reused worktree path to match created worktree path");

	const worktreeRepoContext = await getRepoContext(exec, created.worktreePath!);
	assert(worktreeRepoContext, "expected repo context inside worktree");
	const alreadyThere = await ensureWorktree({
		ctx: {
			cwd: created.worktreePath!,
			hasUI: false,
			ui: {
				async select() {
					return undefined;
				},
				async confirm() {
					return false;
				},
				async input() {
					return undefined;
				},
				notify() {},
			},
		},
		exec,
		config,
		repoContext: worktreeRepoContext,
		intent,
		mode: "reuse-or-create",
	});

	assert(alreadyThere.action === "continued-here", "expected ensure inside matching worktree to continue in place");
	assert(alreadyThere.worktreePath === created.worktreePath, "expected current worktree path to be preserved");

	console.log(
		JSON.stringify(
			{
				created,
				reused,
				alreadyThere,
			},
			null,
			2,
		),
	);
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
