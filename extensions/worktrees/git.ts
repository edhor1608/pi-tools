import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { ExecFn, ExistingWorktree, RepoContext, WorktreesConfig } from "./types.ts"
import { canonicalizePath, isManagedWorktreePath, parseRemoteRepoKey } from "./pathing.ts"

interface GitWorktreeRecord {
	path: string
	branch?: string
	head?: string
	bare: boolean
	detached: boolean
	locked: boolean
	prunable: boolean
}

const GIT_TIMEOUT = 15_000

const runGit = async (exec: ExecFn, cwd: string, args: string[]) => exec("git", args, { cwd, timeout: GIT_TIMEOUT })

export const getRepoRoot = async (exec: ExecFn, cwd: string): Promise<string | undefined> => {
	const result = await runGit(exec, cwd, ["rev-parse", "--show-toplevel"])
	if (result.code !== 0) return undefined
	const repoRoot = result.stdout.trim()
	return repoRoot.length > 0 ? resolve(repoRoot) : undefined
}

export const getCurrentBranch = async (exec: ExecFn, repoRoot: string): Promise<string | undefined> => {
	const result = await runGit(exec, repoRoot, ["branch", "--show-current"])
	if (result.code !== 0) return undefined
	const branch = result.stdout.trim()
	return branch.length > 0 ? branch : undefined
}

export const getDefaultBranch = async (exec: ExecFn, repoRoot: string): Promise<string | undefined> => {
	const result = await runGit(exec, repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
	if (result.code !== 0) return undefined
	const value = result.stdout.trim()
	const prefix = "refs/remotes/origin/"
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}

export const getRemoteUrl = async (exec: ExecFn, repoRoot: string): Promise<string | undefined> => {
	const result = await runGit(exec, repoRoot, ["config", "--get", "remote.origin.url"])
	if (result.code !== 0) return undefined
	const url = result.stdout.trim()
	return url.length > 0 ? url : undefined
}

export const listLocalBranches = async (exec: ExecFn, repoRoot: string): Promise<string[]> => {
	const result = await runGit(exec, repoRoot, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])
	if (result.code !== 0) return []
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

export const hasLocalBranch = async (exec: ExecFn, repoRoot: string, branch: string): Promise<boolean> => {
	const result = await runGit(exec, repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
	return result.code === 0
}

export const hasRemoteBranch = async (exec: ExecFn, repoRoot: string, branch: string): Promise<boolean> => {
	const result = await runGit(exec, repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])
	return result.code === 0
}

const parseBranchRef = (value: string): string | undefined => {
	const prefix = "refs/heads/"
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}

export const parseWorktreeList = (text: string): GitWorktreeRecord[] => {
	const records: GitWorktreeRecord[] = []
	let current: GitWorktreeRecord | undefined
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd()
		if (!line) {
			if (current) records.push(current)
			current = undefined
			continue
		}
		if (line.startsWith("worktree ")) {
			if (current) records.push(current)
			current = {
				path: resolve(line.slice("worktree ".length).trim()),
				bare: false,
				detached: false,
				locked: false,
				prunable: false,
			}
			continue
		}
		if (!current) continue
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim()
			continue
		}
		if (line.startsWith("branch ")) {
			current.branch = parseBranchRef(line.slice("branch ".length).trim())
			continue
		}
		if (line.startsWith("locked")) {
			current.locked = true
			continue
		}
		if (line.startsWith("prunable")) {
			current.prunable = true
			continue
		}
		if (line === "bare") {
			current.bare = true
			continue
		}
		if (line === "detached") {
			current.detached = true
		}
	}
	if (current) records.push(current)
	return records
}

export const listWorktrees = async (
	exec: ExecFn,
	repoRoot: string,
	config: WorktreesConfig,
	cwd: string,
): Promise<ExistingWorktree[]> => {
	const result = await runGit(exec, repoRoot, ["worktree", "list", "--porcelain"])
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Failed to list git worktrees")
	const resolvedCwd = canonicalizePath(cwd)
	return parseWorktreeList(result.stdout).map((worktree) => {
		const canonicalWorktreePath = canonicalizePath(worktree.path)
		return {
			...worktree,
			path: canonicalWorktreePath,
			isManaged: isManagedWorktreePath(config.root, canonicalWorktreePath),
			isCurrent: resolvedCwd === canonicalWorktreePath || resolvedCwd.startsWith(`${canonicalWorktreePath}/`),
		}
	})
}

export const getRepoContext = async (exec: ExecFn, cwd: string): Promise<RepoContext | undefined> => {
	const repoRoot = await getRepoRoot(exec, cwd)
	if (!repoRoot) return undefined
	const [currentBranch, defaultBranch, remoteUrl] = await Promise.all([
		getCurrentBranch(exec, repoRoot),
		getDefaultBranch(exec, repoRoot),
		getRemoteUrl(exec, repoRoot),
	])
	return {
		cwd: resolve(cwd),
		repoRoot,
		currentBranch,
		defaultBranch,
		remoteUrl,
		repoKey: parseRemoteRepoKey(remoteUrl, repoRoot),
	}
}

export const isWorktreeDirty = async (exec: ExecFn, worktreePath: string): Promise<boolean> => {
	if (!existsSync(worktreePath)) return false
	const result = await runGit(exec, worktreePath, ["status", "--porcelain"])
	if (result.code !== 0) return false
	return result.stdout.trim().length > 0
}

export const isBranchMerged = async (exec: ExecFn, repoRoot: string, branch: string, baseRef: string): Promise<boolean> => {
	const result = await runGit(exec, repoRoot, ["branch", "--merged", baseRef, "--format=%(refname:short)"])
	if (result.code !== 0) return false
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.includes(branch)
}

export const pruneWorktrees = async (exec: ExecFn, repoRoot: string): Promise<void> => {
	const result = await runGit(exec, repoRoot, ["worktree", "prune"])
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Failed to prune git worktrees")
}

export const createWorktreeFromNewBranch = async (
	exec: ExecFn,
	repoRoot: string,
	worktreePath: string,
	branchName: string,
	baseRef: string,
): Promise<void> => {
	mkdirSync(dirname(worktreePath), { recursive: true })
	const result = await runGit(exec, repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseRef])
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to create worktree ${worktreePath}`)
	}
}

export const createWorktreeFromExistingBranch = async (
	exec: ExecFn,
	repoRoot: string,
	worktreePath: string,
	branchName: string,
): Promise<void> => {
	mkdirSync(dirname(worktreePath), { recursive: true })
	const result = await runGit(exec, repoRoot, ["worktree", "add", worktreePath, branchName])
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to create worktree ${worktreePath}`)
	}
}

export const removeWorktree = async (exec: ExecFn, repoRoot: string, worktreePath: string, force = false): Promise<void> => {
	const args = ["worktree", "remove"]
	if (force) args.push("--force")
	args.push(worktreePath)
	const result = await runGit(exec, repoRoot, args)
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `Failed to remove worktree ${worktreePath}`)
	}
}
