import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { WorktreeTriggerConfidence, WorktreesConfig } from "./types.ts"

const DEFAULT_CONFIG: WorktreesConfig = {
	root: join(homedir(), "worktrees"),
	autoSetup: true,
	enableInputTrigger: true,
	triggerMinConfidence: "high",
}

interface WorktreesConfigFile {
	root?: string
	autoSetup?: boolean
	enableInputTrigger?: boolean
	triggerMinConfidence?: WorktreeTriggerConfidence
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isTriggerConfidence = (value: unknown): value is WorktreeTriggerConfidence =>
	value === "low" || value === "medium" || value === "high" || value === "very-high"

const expandHome = (value: string): string => {
	if (value === "~") return homedir()
	if (value.startsWith("~/")) return join(homedir(), value.slice(2))
	return value
}

const toConfigFile = (value: unknown): WorktreesConfigFile | undefined => {
	if (!isObject(value)) return undefined
	const root = typeof value.root === "string" && value.root.trim().length > 0 ? value.root.trim() : undefined
	const autoSetup = typeof value.autoSetup === "boolean" ? value.autoSetup : undefined
	const enableInputTrigger = typeof value.enableInputTrigger === "boolean" ? value.enableInputTrigger : undefined
	const triggerMinConfidence = isTriggerConfidence(value.triggerMinConfidence) ? value.triggerMinConfidence : undefined
	return {
		root,
		autoSetup,
		enableInputTrigger,
		triggerMinConfidence,
	}
}

export const getWorktreesConfigPath = (repoRoot: string): string => join(repoRoot, ".pi", "worktrees.json")

export const loadWorktreesConfig = (repoRoot: string): WorktreesConfig => {
	const configPath = getWorktreesConfigPath(repoRoot)
	if (!existsSync(configPath)) return DEFAULT_CONFIG
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8"))
		const file = toConfigFile(parsed)
		if (!file) return DEFAULT_CONFIG
		return {
			root: resolve(expandHome(file.root ?? DEFAULT_CONFIG.root)),
			autoSetup: file.autoSetup ?? DEFAULT_CONFIG.autoSetup,
			enableInputTrigger: file.enableInputTrigger ?? DEFAULT_CONFIG.enableInputTrigger,
			triggerMinConfidence: file.triggerMinConfidence ?? DEFAULT_CONFIG.triggerMinConfidence,
		}
	} catch {
		return DEFAULT_CONFIG
	}
}

export const getDefaultWorktreesConfig = (): WorktreesConfig => ({ ...DEFAULT_CONFIG })
