import { hasLocalBranch, isBranchMerged, isWorktreeDirty, listWorktrees, pruneWorktrees, removeWorktree } from "./git.ts"
import type { CleanupCandidate, CleanupResult, ExecFn, RepoContext, WorktreesConfig } from "./types.ts"

export const computeCleanupCandidates = async (
	exec: ExecFn,
	repoContext: RepoContext,
	config: WorktreesConfig,
): Promise<CleanupCandidate[]> => {
	await pruneWorktrees(exec, repoContext.repoRoot)
	const worktrees = await listWorktrees(exec, repoContext.repoRoot, config, repoContext.cwd)
	const baseRef = repoContext.defaultBranch ?? repoContext.currentBranch
	const candidates: CleanupCandidate[] = []

	for (const worktree of worktrees) {
		if (!worktree.isManaged) continue
		if (worktree.path === repoContext.repoRoot) continue
		if (worktree.prunable) {
			candidates.push({ worktree, reason: "prunable worktree", safe: true, dirty: false })
			continue
		}
		const dirty = await isWorktreeDirty(exec, worktree.path)
		if (!worktree.branch) {
			candidates.push({
				worktree,
				reason: dirty ? "detached or unknown branch with local changes" : "detached or unknown branch",
				safe: false,
				dirty,
			})
			continue
		}
		if (worktree.branch === repoContext.currentBranch || worktree.branch === repoContext.defaultBranch) continue
		const exists = await hasLocalBranch(exec, repoContext.repoRoot, worktree.branch)
		if (!exists) {
			candidates.push({
				worktree,
				reason: dirty ? `branch ${worktree.branch} no longer exists, but worktree is dirty` : `branch ${worktree.branch} no longer exists`,
				safe: !dirty,
				dirty,
			})
			continue
		}
		if (baseRef && (await isBranchMerged(exec, repoContext.repoRoot, worktree.branch, baseRef))) {
			candidates.push({
				worktree,
				reason: dirty ? `branch ${worktree.branch} is merged into ${baseRef}, but worktree is dirty` : `branch ${worktree.branch} is merged into ${baseRef}`,
				safe: !dirty,
				dirty,
			})
		}
	}

	return candidates
}

export const removeCleanupCandidates = async (
	exec: ExecFn,
	repoContext: RepoContext,
	selectedCandidates: CleanupCandidate[],
): Promise<CleanupResult> => {
	const removed: string[] = []
	const skippedDirty: CleanupCandidate[] = []
	const skippedUnsafe: CleanupCandidate[] = []
	for (const candidate of selectedCandidates) {
		if (candidate.dirty) {
			skippedDirty.push(candidate)
			continue
		}
		if (!candidate.safe) {
			skippedUnsafe.push(candidate)
			continue
		}
		await removeWorktree(exec, repoContext.repoRoot, candidate.worktree.path)
		removed.push(candidate.worktree.path)
	}
	return {
		removed,
		skippedDirty,
		skippedUnsafe,
		message:
			removed.length > 0
				? `Removed ${removed.length} worktree${removed.length === 1 ? "" : "s"}`
				: "No worktrees were removed",
	}
}
