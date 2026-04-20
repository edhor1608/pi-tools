import { Type } from "@sinclair/typebox"
import { StringEnum } from "@mariozechner/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { defineTool } from "@mariozechner/pi-coding-agent"
import { computeCleanupCandidates, removeCleanupCandidates } from "./worktrees/cleanup.ts"
import { getDefaultWorktreesConfig, loadWorktreesConfig } from "./worktrees/config.ts"
import { ensureWorktree } from "./worktrees/ensure.ts"
import { getRepoContext, listWorktrees } from "./worktrees/git.ts"
import { compareConfidence, extractWorktreeIntent } from "./worktrees/intent.ts"
import { buildCleanupReport, buildEnsureReport, buildListReport, createWorktreesReportRenderer, WORKTREES_REPORT_MESSAGE_TYPE } from "./worktrees/render.ts"
import type { CleanupCandidate, EnsureWorktreeResult, WorktreeIntent, WorktreeEnsureMode, WorktreesConfig } from "./worktrees/types.ts"

const COMMAND_NAME = "worktrees"
const ENSURE_TOOL_NAME = "ensure_worktree"

const WORKTREE_SUBCOMMANDS = ["ensure", "list", "cleanup"] as const

type WorktreesSubcommand = (typeof WORKTREE_SUBCOMMANDS)[number]

const isSubcommand = (value: string): value is WorktreesSubcommand => (WORKTREE_SUBCOMMANDS as readonly string[]).includes(value)

const normalizeExplicitIntent = (query: string): WorktreeIntent => {
	const intent = extractWorktreeIntent(query)
	if (intent.kind !== "unknown") {
		return {
			...intent,
			confidence: "very-high",
		}
	}
	return {
		kind: "task",
		query: query.trim(),
		confidence: "very-high",
	}
}

const adaptContext = (ctx: ExtensionContext | ExtensionCommandContext) => ({
	cwd: ctx.cwd,
	hasUI: ctx.hasUI,
	ui: {
		select: (title: string, items: string[]) => ctx.ui.select(title, items),
		confirm: (title: string, message: string) => ctx.ui.confirm(title, message),
		input: (title: string, placeholder?: string) => ctx.ui.input(title, placeholder),
		notify: (message: string, level: "info" | "warning" | "error") => ctx.ui.notify(message, level),
	},
})

const sendEnsureReport = (pi: ExtensionAPI, result: EnsureWorktreeResult) => {
	const report = buildEnsureReport(result)
	pi.sendMessage({
		customType: WORKTREES_REPORT_MESSAGE_TYPE,
		content: report.content,
		display: true,
		details: report.details,
	})
}

const sendListReport = (pi: ExtensionAPI, worktrees: Awaited<ReturnType<typeof listWorktrees>>) => {
	const report = buildListReport(worktrees)
	pi.sendMessage({
		customType: WORKTREES_REPORT_MESSAGE_TYPE,
		content: report.content,
		display: true,
		details: report.details,
	})
}

const sendCleanupReport = (pi: ExtensionAPI, candidates: CleanupCandidate[], result?: ReturnType<typeof removeCleanupCandidates> extends Promise<infer T> ? T : never) => {
	const report = buildCleanupReport(candidates, result)
	pi.sendMessage({
		customType: WORKTREES_REPORT_MESSAGE_TYPE,
		content: report.content,
		display: true,
		details: report.details,
	})
}

const loadRepoConfig = async (pi: ExtensionAPI, cwd: string): Promise<{ repoContext?: Awaited<ReturnType<typeof getRepoContext>>; config: WorktreesConfig }> => {
	const repoContext = await getRepoContext(pi.exec.bind(pi), cwd)
	if (!repoContext) return { config: getDefaultWorktreesConfig() }
	return {
		repoContext,
		config: loadWorktreesConfig(repoContext.repoRoot),
	}
}

const ensureFromCommand = async (pi: ExtensionAPI, query: string, ctx: ExtensionCommandContext) => {
	const { repoContext, config } = await loadRepoConfig(pi, ctx.cwd)
	if (!repoContext) {
		ctx.ui.notify("worktrees requires a git repository", "warning")
		return
	}
	const trimmed = query.trim() || (ctx.hasUI ? ((await ctx.ui.input("Worktree query", "PR number, issue key, branch, or short task name")) ?? "") : "")
	const fallbackQuery = trimmed.trim() || repoContext.currentBranch || repoContext.defaultBranch || ""
	if (!fallbackQuery) {
		ctx.ui.notify("Usage: /worktrees ensure <query>", "warning")
		return
	}
	const result = await ensureWorktree({
		ctx: adaptContext(ctx),
		exec: pi.exec.bind(pi),
		config,
		repoContext,
		intent: normalizeExplicitIntent(fallbackQuery),
		mode: "reuse-or-create",
	})
	if (result.action === "cancelled") {
		ctx.ui.notify(result.message, "warning")
		return
	}
	sendEnsureReport(pi, result)
	ctx.ui.notify(result.message, "info")
}

const listFromCommand = async (pi: ExtensionAPI, ctx: ExtensionCommandContext) => {
	const { repoContext, config } = await loadRepoConfig(pi, ctx.cwd)
	if (!repoContext) {
		ctx.ui.notify("worktrees requires a git repository", "warning")
		return
	}
	const worktrees = await listWorktrees(pi.exec.bind(pi), repoContext.repoRoot, config, ctx.cwd)
	sendListReport(pi, worktrees)
}

const cleanupFromCommand = async (pi: ExtensionAPI, ctx: ExtensionCommandContext) => {
	const { repoContext, config } = await loadRepoConfig(pi, ctx.cwd)
	if (!repoContext) {
		ctx.ui.notify("worktrees requires a git repository", "warning")
		return
	}
	const candidates = await computeCleanupCandidates(pi.exec.bind(pi), repoContext, config)
	if (candidates.length === 0) {
		sendCleanupReport(pi, candidates)
		ctx.ui.notify("No cleanup candidates found", "info")
		return
	}
	if (!ctx.hasUI) {
		sendCleanupReport(pi, candidates)
		ctx.ui.notify("Cleanup requires interactive mode to confirm removals", "warning")
		return
	}
	const safeCandidates = candidates.filter((candidate) => candidate.safe)
	if (safeCandidates.length === 0) {
		sendCleanupReport(pi, candidates)
		ctx.ui.notify("Cleanup candidates exist, but none are safe to remove automatically", "warning")
		return
	}
	const selectionLabels = [
		`Remove all safe candidates (${safeCandidates.length})`,
		...safeCandidates.map((candidate) => `${candidate.worktree.path}${candidate.worktree.branch ? ` (${candidate.worktree.branch})` : ""}`),
		"Cancel",
	]
	const choice = await ctx.ui.select("Cleanup worktrees", selectionLabels)
	if (!choice || choice === "Cancel") {
		ctx.ui.notify("Cleanup cancelled", "info")
		return
	}
	const selected =
		choice.startsWith("Remove all safe candidates")
			? safeCandidates
			: safeCandidates.filter(
				(candidate) => `${candidate.worktree.path}${candidate.worktree.branch ? ` (${candidate.worktree.branch})` : ""}` === choice,
			)
	if (selected.length === 0) {
		ctx.ui.notify("No cleanup candidates selected", "warning")
		return
	}
	const confirm = await ctx.ui.confirm(
		"Remove worktrees?",
		selected.map((candidate) => `- ${candidate.worktree.path}`).join("\n"),
	)
	if (!confirm) {
		ctx.ui.notify("Cleanup cancelled", "info")
		return
	}
	const result = await removeCleanupCandidates(pi.exec.bind(pi), repoContext, selected)
	sendCleanupReport(pi, candidates, result)
	ctx.ui.notify(result.message, "info")
}

const parseSubcommand = (args: string): { subcommand: WorktreesSubcommand; rest: string } | undefined => {
	const trimmed = args.trim()
	if (!trimmed) return { subcommand: "list", rest: "" }
	const [command, ...restParts] = trimmed.split(/\s+/)
	if (!isSubcommand(command)) return undefined
	return {
		subcommand: command,
		rest: restParts.join(" ").trim(),
	}
}

const ensureTool = defineTool({
	name: ENSURE_TOOL_NAME,
	label: "Ensure Worktree",
	description: "Prepare or reuse a git worktree for PR, issue, or branch work",
	promptSnippet: "Prepare or reuse a git worktree for PR, issue, or branch work when isolated checkout context matters",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: "PR number, PR URL, issue key, branch, or short task name" })),
		mode: Type.Optional(StringEnum(["auto", "reuse-or-create", "reuse-only", "create-only"] as const)),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const repoContext = await getRepoContext(pi.exec.bind(pi), ctx.cwd)
		if (!repoContext) {
			return {
				content: [{ type: "text", text: "worktrees requires a git repository" }],
				details: {},
			}
		}
		const config = loadWorktreesConfig(repoContext.repoRoot)
		const query = params.query?.trim() || repoContext.currentBranch || repoContext.defaultBranch || ""
		if (!query) {
			return {
				content: [{ type: "text", text: "No worktree query available. Use /worktrees ensure <query> or pass a query to ensure_worktree." }],
				details: {},
			}
		}
		const result = await ensureWorktree({
			ctx: adaptContext(ctx),
			exec: pi.exec.bind(pi),
			config,
			repoContext,
			intent: normalizeExplicitIntent(query),
			mode: (params.mode as WorktreeEnsureMode | undefined) ?? "reuse-or-create",
		})
		const report = buildEnsureReport(result)
		return {
			content: [{ type: "text", text: report.content }],
			details: result,
		}
	},
})

export default function worktreesExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(WORKTREES_REPORT_MESSAGE_TYPE, createWorktreesReportRenderer())

	pi.registerCommand(COMMAND_NAME, {
		description: "Manage git worktrees (usage: /worktrees [ensure <query>|list|cleanup])",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart()
			if (trimmed.includes(" ")) return null
			const items = WORKTREE_SUBCOMMANDS.filter((command) => command.startsWith(trimmed)).map((command) => ({
				value: command,
				label: command,
			}))
			return items.length > 0 ? items : null
		},
		handler: async (args, ctx) => {
			const parsed = parseSubcommand(args)
			if (!parsed) {
				ctx.ui.notify("Usage: /worktrees [ensure <query>|list|cleanup]", "warning")
				return
			}
			if (parsed.subcommand === "ensure") {
				await ensureFromCommand(pi, parsed.rest, ctx)
				return
			}
			if (parsed.subcommand === "cleanup") {
				await cleanupFromCommand(pi, ctx)
				return
			}
			await listFromCommand(pi, ctx)
		},
	})

	pi.registerTool(ensureTool)

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" }
		const repoContext = await getRepoContext(pi.exec.bind(pi), ctx.cwd)
		if (!repoContext) return { action: "continue" }
		const config = loadWorktreesConfig(repoContext.repoRoot)
		if (!config.enableInputTrigger || !ctx.hasUI) return { action: "continue" }
		const intent = extractWorktreeIntent(event.text)
		if (compareConfidence(intent.confidence, config.triggerMinConfidence) < 0) return { action: "continue" }
		const worktrees = await listWorktrees(pi.exec.bind(pi), repoContext.repoRoot, config, ctx.cwd)
		const currentMatch = worktrees.find((worktree) => worktree.isCurrent)
		if (
			currentMatch?.branch &&
			((intent.branchHint && currentMatch.branch === intent.branchHint) ||
				(intent.prNumber && currentMatch.branch.includes(String(intent.prNumber))) ||
				(intent.issueKey && currentMatch.branch.toLowerCase().includes(intent.issueKey.toLowerCase())))
		) {
			return { action: "continue" }
		}
		const result = await ensureWorktree({
			ctx: adaptContext(ctx),
			exec: pi.exec.bind(pi),
			config,
			repoContext,
			intent,
			allowContinueHere: true,
			originalPrompt: event.text,
		})
		if (result.action === "continued-here") {
			if (result.worktreePath) return { action: "continue" }
			ctx.ui.notify(result.message, "info")
			return { action: "continue" }
		}
		sendEnsureReport(pi, result)
		ctx.ui.notify(result.message, result.action === "cancelled" ? "warning" : "info")
		return { action: "handled" }
	})
}
