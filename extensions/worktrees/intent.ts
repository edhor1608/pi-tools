import type { WorktreeIntent, WorktreeTriggerConfidence } from "./types.ts"
import { normalizeInline } from "./pathing.ts"

const ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/
const PR_URL_REGEX = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i
const PR_REFERENCE_REGEX = /\b(?:review|continue|work on|resume|fix|check|look at|inspect)\s+(?:the\s+)?(?:pr|pull request)\s*#?(\d+)\b/i
const ANY_PR_REGEX = /\b(?:pr|pull request)\s*#?(\d+)\b/i
const CREATE_WORKTREE_REGEX = /\bcreate\s+(?:a\s+)?worktree\b/i
const STACK_BASE_REGEX = /\b(?:stack(?:ed)?\s+on|base(?:d)?\s+on|onto)\s+(?:branch\s+)?([A-Za-z0-9._/-]+)\b/i
const BRANCH_HINT_REGEX = /\bbranch\s+([A-Za-z0-9._/-]+)\b/i
const TASK_LANGUAGE_REGEX = /\b(review|continue|work on|resume|implement|fix|debug|investigate|address|prepare|check)\b/i
const SLASH_COMMAND_REGEX = /^\/\S+/

const priority: Record<WorktreeTriggerConfidence, number> = {
	low: 0,
	medium: 1,
	high: 2,
	"very-high": 3,
}

const maxConfidence = (left: WorktreeTriggerConfidence, right: WorktreeTriggerConfidence): WorktreeTriggerConfidence =>
	priority[left] >= priority[right] ? left : right

export const compareConfidence = (left: WorktreeTriggerConfidence, right: WorktreeTriggerConfidence): number => priority[left] - priority[right]

export const extractWorktreeIntent = (text: string): WorktreeIntent => {
	const normalized = normalizeInline(text)
	if (!normalized || SLASH_COMMAND_REGEX.test(normalized)) {
		return { kind: "unknown", query: normalized, confidence: "low" }
	}

	const prUrlMatch = PR_URL_REGEX.exec(normalized)
	if (prUrlMatch) {
		return {
			kind: "pr",
			query: normalized,
			prNumber: Number(prUrlMatch[1]),
			confidence: "very-high",
		}
	}

	const explicitCreate = CREATE_WORKTREE_REGEX.test(normalized)
	const prReferenceMatch = PR_REFERENCE_REGEX.exec(normalized)
	if (prReferenceMatch) {
		return {
			kind: "pr",
			query: normalized,
			prNumber: Number(prReferenceMatch[1]),
			confidence: "very-high",
		}
	}

	const anyPrMatch = ANY_PR_REGEX.exec(normalized)
	if (anyPrMatch) {
		return {
			kind: "pr",
			query: normalized,
			prNumber: Number(anyPrMatch[1]),
			confidence: explicitCreate ? "very-high" : "high",
		}
	}

	const issueKeyMatch = ISSUE_KEY_REGEX.exec(normalized)
	const stackBaseMatch = STACK_BASE_REGEX.exec(normalized)
	const branchHintMatch = BRANCH_HINT_REGEX.exec(normalized)
	const hasTaskLanguage = TASK_LANGUAGE_REGEX.test(normalized)

	if (stackBaseMatch) {
		const baseHint = stackBaseMatch[1]!
		const confidence = explicitCreate || hasTaskLanguage ? "high" : "medium"
		return {
			kind: "branch",
			query: normalized,
			baseHint,
			branchHint: branchHintMatch?.[1],
			confidence,
		}
	}

	if (branchHintMatch) {
		const branchHint = branchHintMatch[1]!
		const confidence = explicitCreate || hasTaskLanguage ? "high" : "medium"
		return {
			kind: "branch",
			query: normalized,
			branchHint,
			confidence,
		}
	}

	if (issueKeyMatch) {
		let confidence: WorktreeTriggerConfidence = "medium"
		if (explicitCreate || hasTaskLanguage) confidence = maxConfidence(confidence, "high")
		return {
			kind: "issue",
			query: normalized,
			issueKey: issueKeyMatch[1],
			confidence,
		}
	}

	if (explicitCreate) {
		return {
			kind: "task",
			query: normalized.replace(CREATE_WORKTREE_REGEX, "").trim() || normalized,
			confidence: "very-high",
		}
	}

	return {
		kind: "unknown",
		query: normalized,
		confidence: "low",
	}
}
