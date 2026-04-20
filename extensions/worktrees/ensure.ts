import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import {
	createWorktreeFromExistingBranch,
	createWorktreeFromNewBranch,
	hasLocalBranch,
	hasRemoteBranch,
	listLocalBranches,
	listWorktrees,
} from "./git.ts"
import { rankWorktreeMatches } from "./match.ts"
import {
	buildManagedRepoRoot,
	buildUniqueBranchName,
	buildUniqueWorktreePath,
	canonicalizePath,
	deriveDesiredBranchName,
	deriveWorktreeName,
} from "./pathing.ts"
import { setupWorktree } from "./setup.ts"
import type { EnsureWorktreeOptions, EnsureWorktreeResult, ExistingWorktree, WorktreeMatch } from "./types.ts"

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

const buildStartCommand = (path: string): string => `cd ${shellQuote(path)} && pi`

const describeMatch = (match: WorktreeMatch): string => {
	const branch = match.worktree.branch ? `branch ${match.worktree.branch}` : basename(match.worktree.path)
	return `${branch} at ${match.worktree.path}`
}

const ensureUniquePathOnDisk = (initialPath: string): string => {
	if (!existsSync(initialPath)) return initialPath
	let attempt = 2
	while (existsSync(`${initialPath}-${attempt}`)) attempt += 1
	return `${initialPath}-${attempt}`
}

const promptForReuseDecision = async (
	ctx: EnsureWorktreeOptions["ctx"],
	bestMatch: WorktreeMatch,
	allowContinueHere: boolean,
): Promise<"reuse" | "create" | "continue" | "cancel"> => {
	if (!ctx.hasUI) return "reuse"
	const options = [
		`Reuse existing worktree (${describeMatch(bestMatch)})`,
		"Create a new worktree",
	]
	if (allowContinueHere) options.push("Continue here once")
	options.push("Cancel")
	const choice = await ctx.ui.select("Worktree needed", options)
	if (!choice || choice === "Cancel") return "cancel"
	if (choice === "Create a new worktree") return "create"
	if (choice === "Continue here once") return "continue"
	return "reuse"
}

const pickBaseRef = async (
	options: EnsureWorktreeOptions,
	desiredBranchName: string,
	existingLocalBranches: string[],
): Promise<string | undefined> => {
	const { ctx, exec, repoContext } = options
	const entries: Array<{ value: string; label: string }> = []
	const seen = new Set<string>()
	const addEntry = (value: string | undefined, label: string) => {
		if (!value || seen.has(value)) return
		seen.add(value)
		entries.push({ value, label })
	}

	if (options.intent.baseHint) {
		if (await hasLocalBranch(exec, repoContext.repoRoot, options.intent.baseHint)) {
			addEntry(options.intent.baseHint, `Use hinted base branch ${options.intent.baseHint}`)
		} else if (await hasRemoteBranch(exec, repoContext.repoRoot, options.intent.baseHint)) {
			addEntry(`origin/${options.intent.baseHint}`, `Use hinted remote branch origin/${options.intent.baseHint}`)
		}
	}
	addEntry(repoContext.currentBranch, `Use current branch ${repoContext.currentBranch}`)
	addEntry(repoContext.defaultBranch, `Use default branch ${repoContext.defaultBranch}`)
	for (const branch of existingLocalBranches.slice(0, 8)) {
		if (branch === desiredBranchName) continue
		addEntry(branch, `Use recent branch ${branch}`)
	}

	if (!ctx.hasUI) {
		return entries[0]?.value
	}

	const choice = await ctx.ui.select("Choose a base ref", [...entries.map((entry) => entry.label), "Type another ref", "Cancel"])
	if (!choice || choice === "Cancel") return undefined
	if (choice === "Type another ref") {
		const typed = await ctx.ui.input("Base ref", "branch, tag, or commit")
		return typed?.trim() || undefined
	}
	return entries.find((entry) => entry.label === choice)?.value
}

const reuseWorktree = async (options: EnsureWorktreeOptions, worktree: ExistingWorktree): Promise<EnsureWorktreeResult> => {
	const result: EnsureWorktreeResult = {
		action: worktree.isCurrent ? "continued-here" : "reused",
		repoRoot: options.repoContext.repoRoot,
		worktreePath: worktree.path,
		branchName: worktree.branch,
		startCommand: buildStartCommand(worktree.path),
		message: worktree.isCurrent ? `Already in matching worktree ${worktree.path}` : `Reusing worktree ${worktree.path}`,
		originalPrompt: options.originalPrompt,
	}
	if (!worktree.isCurrent) {
		result.setup = await setupWorktree({
			exec: options.exec,
			config: options.config,
			worktreePath: worktree.path,
			ctx: options.ctx,
		})
	}
	return result
}

const createWorktree = async (options: EnsureWorktreeOptions, existingWorktrees: ExistingWorktree[]): Promise<EnsureWorktreeResult> => {
	const managedRepoRoot = buildManagedRepoRoot(options.config.root, options.repoContext.repoKey)
	const worktreeName = deriveWorktreeName(options.intent)
	const desiredBranchName = deriveDesiredBranchName(options.intent)
	const existingLocalBranches = await listLocalBranches(options.exec, options.repoContext.repoRoot)
	const existingBranchSet = new Set(existingLocalBranches)
	const activeBranchSet = new Set(existingWorktrees.map((worktree) => worktree.branch).filter((branch): branch is string => !!branch))
	const existingPathCandidates = existingWorktrees.map((worktree) => worktree.path)
	const initialPath = buildUniqueWorktreePath(join(managedRepoRoot), worktreeName, existingPathCandidates)
	const worktreePath = ensureUniquePathOnDisk(initialPath)

	const localDesiredBranchExists = existingBranchSet.has(desiredBranchName)
	const desiredBranchInUse = activeBranchSet.has(desiredBranchName)
	const remoteDesiredBranchExists = options.intent.branchHint
		? await hasRemoteBranch(options.exec, options.repoContext.repoRoot, options.intent.branchHint)
		: false

	let branchName = desiredBranchName
	let baseRef: string | undefined
	if (localDesiredBranchExists && !desiredBranchInUse) {
		await createWorktreeFromExistingBranch(options.exec, options.repoContext.repoRoot, worktreePath, desiredBranchName)
	} else {
		if (localDesiredBranchExists || desiredBranchInUse) {
			branchName = buildUniqueBranchName(desiredBranchName, existingBranchSet)
		}
		if (options.intent.branchHint && !localDesiredBranchExists && remoteDesiredBranchExists) {
			baseRef = `origin/${options.intent.branchHint}`
		} else {
			baseRef = await pickBaseRef(options, branchName, existingLocalBranches)
		}
		if (!baseRef) {
			return {
				action: "cancelled",
				repoRoot: options.repoContext.repoRoot,
				message: "Worktree creation cancelled",
				originalPrompt: options.originalPrompt,
			}
		}
		await createWorktreeFromNewBranch(options.exec, options.repoContext.repoRoot, worktreePath, branchName, baseRef)
	}

	const canonicalWorktreePath = canonicalizePath(worktreePath)
	const setup = await setupWorktree({
		exec: options.exec,
		config: options.config,
		worktreePath: canonicalWorktreePath,
		ctx: options.ctx,
	})
	return {
		action: "created",
		repoRoot: options.repoContext.repoRoot,
		worktreePath: canonicalWorktreePath,
		branchName,
		baseRef,
		setup,
		startCommand: buildStartCommand(canonicalWorktreePath),
		message: `Created worktree ${canonicalWorktreePath}`,
		originalPrompt: options.originalPrompt,
	}
}

export const ensureWorktree = async (options: EnsureWorktreeOptions): Promise<EnsureWorktreeResult> => {
	const mode = options.mode ?? "auto"
	const worktrees = await listWorktrees(options.exec, options.repoContext.repoRoot, options.config, options.ctx.cwd)
	const matches = rankWorktreeMatches(options.intent, worktrees)
	const bestMatch = matches[0]

	if (bestMatch?.exact && bestMatch.worktree.isCurrent) {
		return {
			action: "continued-here",
			repoRoot: options.repoContext.repoRoot,
			worktreePath: bestMatch.worktree.path,
			branchName: bestMatch.worktree.branch,
			startCommand: buildStartCommand(bestMatch.worktree.path),
			message: `Already in matching worktree ${bestMatch.worktree.path}`,
			originalPrompt: options.originalPrompt,
		}
	}

	if (mode === "reuse-only") {
		if (!bestMatch?.exact) {
			return {
				action: "cancelled",
				repoRoot: options.repoContext.repoRoot,
				message: "No matching worktree found to reuse",
				originalPrompt: options.originalPrompt,
			}
		}
		return reuseWorktree(options, bestMatch.worktree)
	}

	if (mode !== "create-only" && bestMatch && bestMatch.score >= 80) {
		const decision = await promptForReuseDecision(options.ctx, bestMatch, options.allowContinueHere === true)
		if (decision === "continue") {
			return {
				action: "continued-here",
				repoRoot: options.repoContext.repoRoot,
				message: "Continuing in the current directory for this prompt",
				originalPrompt: options.originalPrompt,
			}
		}
		if (decision === "cancel") {
			return {
				action: "cancelled",
				repoRoot: options.repoContext.repoRoot,
				message: "Worktree handling cancelled",
				originalPrompt: options.originalPrompt,
			}
		}
		if (decision === "reuse") {
			return reuseWorktree(options, bestMatch.worktree)
		}
	}

	return createWorktree(options, worktrees)
}
