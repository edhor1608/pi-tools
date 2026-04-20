import type { ExecOptions, ExecResult } from "@mariozechner/pi-coding-agent"

export const WORKTREE_TRIGGER_CONFIDENCE = ["low", "medium", "high", "very-high"] as const
export const WORKTREE_INTENT_KINDS = ["pr", "issue", "branch", "task", "unknown"] as const
export const WORKTREE_ENSURE_MODES = ["auto", "reuse-or-create", "reuse-only", "create-only"] as const

export type WorktreeTriggerConfidence = (typeof WORKTREE_TRIGGER_CONFIDENCE)[number]
export type WorktreeIntentKind = (typeof WORKTREE_INTENT_KINDS)[number]
export type WorktreeEnsureMode = (typeof WORKTREE_ENSURE_MODES)[number]
export type NotifyLevel = "info" | "warning" | "error"

export interface WorktreesConfig {
	root: string
	autoSetup: boolean
	enableInputTrigger: boolean
	triggerMinConfidence: WorktreeTriggerConfidence
}

export interface RepoKey {
	host: string
	owner: string
	repo: string
	fallback: boolean
}

export interface RepoContext {
	cwd: string
	repoRoot: string
	currentBranch?: string
	defaultBranch?: string
	remoteUrl?: string
	repoKey: RepoKey
}

export interface ExistingWorktree {
	path: string
	branch?: string
	head?: string
	bare: boolean
	detached: boolean
	locked: boolean
	prunable: boolean
	isManaged: boolean
	isCurrent: boolean
}

export interface WorktreeIntent {
	kind: WorktreeIntentKind
	query: string
	prNumber?: number
	issueKey?: string
	branchHint?: string
	baseHint?: string
	confidence: WorktreeTriggerConfidence
}

export interface WorktreeMatch {
	worktree: ExistingWorktree
	score: number
	reason: string
	exact: boolean
}

export interface SetupResult {
	ran: boolean
	command?: string
	success?: boolean
	stdout?: string
	stderr?: string
}

export interface EnsureWorktreeResult {
	action: "reused" | "created" | "continued-here" | "cancelled"
	repoRoot: string
	worktreePath?: string
	branchName?: string
	baseRef?: string
	setup?: SetupResult
	startCommand?: string
	message: string
	originalPrompt?: string
}

export interface CleanupCandidate {
	worktree: ExistingWorktree
	reason: string
	safe: boolean
	dirty: boolean
}

export interface CleanupResult {
	removed: string[]
	skippedDirty: CleanupCandidate[]
	skippedUnsafe: CleanupCandidate[]
	message: string
}

export interface WorktreesUI {
	select(title: string, items: string[]): Promise<string | null | undefined>
	confirm(title: string, message: string): Promise<boolean>
	input(title: string, placeholder?: string): Promise<string | undefined>
	notify(message: string, level: NotifyLevel): void
}

export interface WorktreesInteractionContext {
	cwd: string
	hasUI: boolean
	ui: WorktreesUI
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

export interface EnsureWorktreeOptions {
	ctx: WorktreesInteractionContext
	exec: ExecFn
	config: WorktreesConfig
	repoContext: RepoContext
	intent: WorktreeIntent
	mode?: WorktreeEnsureMode
	allowContinueHere?: boolean
	originalPrompt?: string
}

export interface SetupOptions {
	exec: ExecFn
	config: WorktreesConfig
	worktreePath: string
	ctx: WorktreesInteractionContext
}
