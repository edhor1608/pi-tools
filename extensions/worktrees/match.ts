import { basename } from "node:path"
import type { ExistingWorktree, WorktreeIntent, WorktreeMatch } from "./types.ts"
import { deriveWorktreeName, normalizeInline, slugify } from "./pathing.ts"

const normalizeComparable = (value: string | undefined): string => normalizeInline(value ?? "").toLowerCase()

const tokenizeBranch = (value: string | undefined): string[] => {
	const normalized = normalizeComparable(value).replace(/\//g, "-")
	return normalized.length > 0 ? [normalized, slugify(normalized)] : []
}

const tokenizePath = (path: string): string[] => {
	const name = basename(path)
	const normalized = normalizeComparable(name)
	return normalized.length > 0 ? [normalized, slugify(normalized)] : []
}

const containsToken = (haystack: string[], needle: string): boolean => haystack.some((part) => part.includes(needle))

const buildMatch = (worktree: ExistingWorktree, score: number, reason: string, exact: boolean): WorktreeMatch => ({
	worktree,
	score,
	reason,
	exact,
})

const scoreWorktree = (intent: WorktreeIntent, worktree: ExistingWorktree): WorktreeMatch | undefined => {
	const branchTokens = tokenizeBranch(worktree.branch)
	const pathTokens = tokenizePath(worktree.path)

	if (intent.branchHint) {
		const exactBranch = normalizeComparable(intent.branchHint)
		if (branchTokens.includes(exactBranch) || branchTokens.includes(slugify(exactBranch))) {
			return buildMatch(worktree, 100, "Exact branch match", true)
		}
	}

	if (intent.prNumber) {
		const prToken = `pr-${intent.prNumber}`
		const numberToken = String(intent.prNumber)
		if (branchTokens.includes(prToken) || pathTokens.includes(prToken)) {
			return buildMatch(worktree, 95, "Exact PR match", true)
		}
		if (containsToken(branchTokens, numberToken) || containsToken(pathTokens, numberToken)) {
			return buildMatch(worktree, 90, "PR number token match", true)
		}
	}

	if (intent.issueKey) {
		const issueToken = slugify(intent.issueKey)
		if (branchTokens.includes(issueToken) || pathTokens.includes(issueToken)) {
			return buildMatch(worktree, 90, "Exact issue-key match", true)
		}
	}

	const slug = deriveWorktreeName(intent)
	if (slug.length > 0) {
		if (branchTokens.includes(slug) || pathTokens.includes(slug)) {
			return buildMatch(worktree, 80, "Exact slug match", true)
		}
		if (containsToken(branchTokens, slug) || containsToken(pathTokens, slug)) {
			return buildMatch(worktree, 60, "Partial slug match", false)
		}
	}

	return undefined
}

export const rankWorktreeMatches = (intent: WorktreeIntent, worktrees: ExistingWorktree[]): WorktreeMatch[] =>
	worktrees
		.map((worktree) => scoreWorktree(intent, worktree))
		.filter((match): match is WorktreeMatch => !!match)
		.sort((left, right) => right.score - left.score || Number(right.exact) - Number(left.exact))

export const getBestWorktreeMatch = (intent: WorktreeIntent, worktrees: ExistingWorktree[]): WorktreeMatch | undefined =>
	rankWorktreeMatches(intent, worktrees)[0]
