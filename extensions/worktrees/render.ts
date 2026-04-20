import { basename } from "node:path"
import { Box, Text } from "@mariozechner/pi-tui"
import type { MessageRenderer, MessageRenderOptions } from "@mariozechner/pi-coding-agent"
import type { CleanupCandidate, CleanupResult, EnsureWorktreeResult, ExistingWorktree } from "./types.ts"

export const WORKTREES_REPORT_MESSAGE_TYPE = "worktrees-report"

export interface WorktreesReportDetails {
	title: string
	preview: string
	hint: string
}

const formatWorktreeLabel = (worktree: ExistingWorktree): string => {
	const branch = worktree.branch ? ` (${worktree.branch})` : ""
	const managed = worktree.isManaged ? " managed" : ""
	const current = worktree.isCurrent ? " current" : ""
	return `- ${worktree.path}${branch}${managed}${current}`
}

export const buildEnsureReport = (result: EnsureWorktreeResult): { content: string; details: WorktreesReportDetails } => {
	const lines = ["Worktrees", `- result: ${result.message}`]
	if (result.worktreePath) lines.push(`- path: ${result.worktreePath}`)
	if (result.branchName) lines.push(`- branch: ${result.branchName}`)
	if (result.baseRef) lines.push(`- base ref: ${result.baseRef}`)
	if (result.setup?.command) {
		lines.push(`- setup: ${result.setup.command}${result.setup.ran ? result.setup.success === false ? " (failed)" : " (done)" : " (skipped)"}`)
	}
	if (result.startCommand) lines.push(`- start: ${result.startCommand}`)
	if (result.originalPrompt) {
		lines.push("", "Original prompt:", result.originalPrompt)
	}
	return {
		content: lines.join("\n"),
		details: {
			title: "Worktrees",
			preview: [result.message, result.worktreePath ? `path: ${result.worktreePath}` : undefined].filter(Boolean).join("\n"),
			hint: result.startCommand ? "Expand for path, setup, and next command" : "Expand for details",
		},
	}
}

export const buildListReport = (worktrees: ExistingWorktree[]): { content: string; details: WorktreesReportDetails } => {
	if (worktrees.length === 0) {
		return {
			content: "Worktrees\n- no worktrees found for this repository",
			details: { title: "Worktrees", preview: "- no worktrees found", hint: "Repository worktree inventory" },
		}
	}
	return {
		content: ["Worktrees", ...worktrees.map(formatWorktreeLabel)].join("\n"),
		details: {
			title: "Worktrees",
			preview: worktrees.slice(0, 4).map((worktree) => `- ${basename(worktree.path)}`).join("\n"),
			hint: "Expand for paths and branch details",
		},
	}
}

export const buildCleanupPreview = (candidates: CleanupCandidate[]): string => {
	if (candidates.length === 0) return "- no cleanup candidates"
	return candidates.slice(0, 4).map((candidate) => `- ${basename(candidate.worktree.path)}: ${candidate.reason}`).join("\n")
}

export const buildCleanupReport = (
	candidates: CleanupCandidate[],
	result?: CleanupResult,
): { content: string; details: WorktreesReportDetails } => {
	const lines = ["Worktree Cleanup"]
	if (result) lines.push(`- result: ${result.message}`)
	if (candidates.length === 0) {
		lines.push("- no cleanup candidates")
	} else {
		for (const candidate of candidates) {
			lines.push(`- ${candidate.worktree.path}${candidate.worktree.branch ? ` (${candidate.worktree.branch})` : ""}`)
			lines.push(`  reason: ${candidate.reason}`)
			lines.push(`  safe: ${candidate.safe ? "yes" : "no"}`)
			lines.push(`  dirty: ${candidate.dirty ? "yes" : "no"}`)
		}
	}
	if (result?.removed.length) {
		lines.push(`- removed: ${result.removed.length}`)
	}
	return {
		content: lines.join("\n"),
		details: {
			title: "Worktree Cleanup",
			preview: result ? `${result.message}\n${buildCleanupPreview(candidates)}` : buildCleanupPreview(candidates),
			hint: "Expand for cleanup candidate details",
		},
	}
}

export const createWorktreesReportRenderer = (): MessageRenderer => (message, options: MessageRenderOptions, theme) => {
	const details = message.details as WorktreesReportDetails | undefined
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
	const title = theme.fg("accent", details?.title ?? "Worktrees")
	const body = options.expanded ? String(message.content) : details?.preview ?? String(message.content)
	const hint = theme.fg("dim", details?.hint ?? "Expand for details")
	box.addChild(new Text(`${title}\n${body}\n${hint}`, 0, 0))
	return box
}
