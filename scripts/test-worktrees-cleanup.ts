import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { computeCleanupCandidates, removeCleanupCandidates } from "../extensions/worktrees/cleanup.ts";
import { getDefaultWorktreesConfig } from "../extensions/worktrees/config.ts";
import { getRepoContext } from "../extensions/worktrees/git.ts";
import type { ExecFn } from "../extensions/worktrees/types.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const tempRoot = mkdtempSync(join(tmpdir(), "pi-worktrees-cleanup-"));
const repo = join(tempRoot, "repo");
const managedRoot = join(tempRoot, "worktrees");
const cleanWorktree = join(managedRoot, "github.com", "local", "repo", "merged-clean");
const dirtyWorktree = join(managedRoot, "github.com", "local", "repo", "merged-dirty");

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

try {
	run(repo, "git", ["init", "-q", "-b", "main"]);
	run(repo, "git", ["config", "user.name", "Test User"]);
	run(repo, "git", ["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
	run(repo, "git", ["add", "README.md"]);
	run(repo, "git", ["commit", "-q", "-m", "init"]);

	run(repo, "git", ["worktree", "add", "-b", "merged-clean", cleanWorktree, "main"]);
	writeFileSync(join(cleanWorktree, "clean.txt"), "clean\n", "utf8");
	run(cleanWorktree, "git", ["add", "clean.txt"]);
	run(cleanWorktree, "git", ["commit", "-q", "-m", "clean change"]);
	run(repo, "git", ["merge", "--no-ff", "-m", "merge clean", "merged-clean"]);

	run(repo, "git", ["worktree", "add", "-b", "merged-dirty", dirtyWorktree, "main"]);
	writeFileSync(join(dirtyWorktree, "dirty.txt"), "dirty\n", "utf8");
	run(dirtyWorktree, "git", ["add", "dirty.txt"]);
	run(dirtyWorktree, "git", ["commit", "-q", "-m", "dirty change"]);
	run(repo, "git", ["merge", "--no-ff", "-m", "merge dirty", "merged-dirty"]);
	writeFileSync(join(dirtyWorktree, "dirty.txt"), "dirty\nlocal changes\n", "utf8");

	const repoContext = await getRepoContext(exec, repo);
	assert(repoContext, "expected repo context to resolve for cleanup test");

	const config = {
		...getDefaultWorktreesConfig(),
		root: managedRoot,
	};
	const candidates = await computeCleanupCandidates(exec, repoContext, config);
	const cleanCandidate = candidates.find((candidate) => candidate.worktree.branch === "merged-clean");
	const dirtyCandidate = candidates.find((candidate) => candidate.worktree.branch === "merged-dirty");

	assert(cleanCandidate, "expected merged-clean to be a cleanup candidate");
	assert(cleanCandidate.safe && !cleanCandidate.dirty, "expected merged-clean to be safe and clean");
	assert(dirtyCandidate, "expected merged-dirty to be a cleanup candidate");
	assert(!dirtyCandidate.safe && dirtyCandidate.dirty, "expected merged-dirty to be excluded from safe cleanup because it is dirty");

	const result = await removeCleanupCandidates(exec, repoContext, [cleanCandidate, dirtyCandidate]);
	assert(result.removed.includes(cleanCandidate.worktree.path), "expected clean merged worktree to be removed");
	assert(
		result.skippedDirty.some((candidate) => candidate.worktree.path === dirtyCandidate.worktree.path),
		"expected dirty merged worktree to be skipped",
	);
	assert(!existsSync(cleanWorktree), "expected clean worktree path to be removed from disk");
	assert(existsSync(dirtyWorktree), "expected dirty worktree path to remain on disk");

	console.log(
		JSON.stringify(
			{
				candidates,
				result,
			},
			null,
			2,
		),
	);
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
