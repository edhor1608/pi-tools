import { existsSync, realpathSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { RepoKey, WorktreeIntent } from "./types.ts"

const REMOTE_HTTPS_REGEX = /^(?:https?:\/\/|ssh:\/\/)(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i
const REMOTE_SCP_REGEX = /^(?:[^@]+@)?([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i
const BRANCH_SAFE_REGEX = /[^A-Za-z0-9._/-]+/g

export const normalizeInline = (value: string): string => value.replace(/\s+/g, " ").trim()

export const slugify = (value: string): string =>
	normalizeInline(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "worktree"

const sanitizeBranchSegment = (value: string): string =>
	value
		.trim()
		.replace(BRANCH_SAFE_REGEX, "-")
		.replace(/\/+/g, "/")
		.replace(/-+\//g, "/")
		.replace(/\/-+/g, "/")
		.replace(/^-+|-+$/g, "") || "worktree"

export const parseRemoteRepoKey = (remoteUrl: string | undefined, repoRoot: string): RepoKey => {
	const fallbackRepo = slugify(basename(repoRoot))
	if (!remoteUrl) {
		return {
			host: "local",
			owner: "local",
			repo: fallbackRepo,
			fallback: true,
		}
	}
	const trimmed = remoteUrl.trim()
	const httpsMatch = REMOTE_HTTPS_REGEX.exec(trimmed)
	if (httpsMatch) {
		return {
			host: httpsMatch[1]!.toLowerCase(),
			owner: slugify(httpsMatch[2]!),
			repo: slugify(httpsMatch[3]!),
			fallback: false,
		}
	}
	const scpMatch = REMOTE_SCP_REGEX.exec(trimmed)
	if (scpMatch) {
		return {
			host: scpMatch[1]!.toLowerCase(),
			owner: slugify(scpMatch[2]!),
			repo: slugify(scpMatch[3]!),
			fallback: false,
		}
	}
	return {
		host: "local",
		owner: "local",
		repo: fallbackRepo,
		fallback: true,
	}
}

export const buildManagedRepoRoot = (root: string, repoKey: RepoKey): string =>
	repoKey.fallback ? join(resolve(root), "local", repoKey.repo) : join(resolve(root), repoKey.host, repoKey.owner, repoKey.repo)

export const deriveWorktreeName = (intent: WorktreeIntent): string => {
	if (intent.prNumber) return `pr-${intent.prNumber}`
	if (intent.issueKey) return slugify(intent.issueKey)
	if (intent.branchHint) return slugify(intent.branchHint.replace(/\//g, "-"))
	if (intent.query) return slugify(intent.query)
	return "worktree"
}

export const deriveDesiredBranchName = (intent: WorktreeIntent): string => {
	if (intent.branchHint) return sanitizeBranchSegment(intent.branchHint)
	if (intent.prNumber) return `pr-${intent.prNumber}`
	if (intent.issueKey) return slugify(intent.issueKey)
	if (intent.query) return slugify(intent.query)
	return "worktree"
}

export const makeUniqueName = (base: string, taken: Set<string>): string => {
	const normalizedBase = base || "worktree"
	if (!taken.has(normalizedBase)) return normalizedBase
	let attempt = 2
	while (taken.has(`${normalizedBase}-${attempt}`)) attempt += 1
	return `${normalizedBase}-${attempt}`
}

export const buildUniqueWorktreePath = (managedRepoRoot: string, desiredName: string, existingPaths: Iterable<string>): string => {
	const taken = new Set(Array.from(existingPaths, (path) => basename(path)))
	const uniqueName = makeUniqueName(desiredName, taken)
	return join(managedRepoRoot, uniqueName)
}

export const buildUniqueBranchName = (desiredBranch: string, existingBranches: Iterable<string>): string => {
	return makeUniqueName(desiredBranch, new Set(existingBranches))
}

export const canonicalizePath = (value: string): string => {
	const resolved = resolve(value)
	if (!existsSync(resolved)) return resolved
	try {
		return realpathSync.native(resolved)
	} catch {
		return resolved
	}
}

export const isManagedWorktreePath = (root: string, path: string): boolean => {
	const resolvedRoot = canonicalizePath(root)
	const resolvedPath = canonicalizePath(path)
	return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`)
}
