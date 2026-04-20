import { existsSync } from "node:fs"
import { join } from "node:path"
import type { SetupOptions, SetupResult } from "./types.ts"

interface SetupCommand {
	command: string
	args: string[]
	label: string
}

const detectSetupCommand = (worktreePath: string): SetupCommand | undefined => {
	if (existsSync(join(worktreePath, "pnpm-lock.yaml"))) {
		return { command: "pnpm", args: ["install"], label: "pnpm install" }
	}
	if (existsSync(join(worktreePath, "yarn.lock"))) {
		return { command: "yarn", args: ["install"], label: "yarn install" }
	}
	if (existsSync(join(worktreePath, "bun.lock")) || existsSync(join(worktreePath, "bun.lockb"))) {
		return { command: "bun", args: ["install"], label: "bun install" }
	}
	if (existsSync(join(worktreePath, "package-lock.json"))) {
		return { command: "npm", args: ["install"], label: "npm install" }
	}
	if (existsSync(join(worktreePath, "go.mod"))) {
		return { command: "go", args: ["mod", "download"], label: "go mod download" }
	}
	return undefined
}

export const setupWorktree = async ({ exec, config, worktreePath, ctx }: SetupOptions): Promise<SetupResult> => {
	const setupCommand = detectSetupCommand(worktreePath)
	if (!setupCommand) {
		return { ran: false }
	}

	let shouldRun = config.autoSetup
	if (ctx.hasUI) {
		shouldRun = await ctx.ui.confirm("Setup worktree?", `Run \`${setupCommand.label}\` in ${worktreePath}?`)
	}
	if (!shouldRun) {
		return {
			ran: false,
			command: setupCommand.label,
		}
	}

	const result = await exec(setupCommand.command, setupCommand.args, { cwd: worktreePath, timeout: 120_000 })
	return {
		ran: true,
		command: setupCommand.label,
		success: result.code === 0,
		stdout: result.stdout,
		stderr: result.stderr,
	}
}
