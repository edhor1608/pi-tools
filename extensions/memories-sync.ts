import { open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MEMORIES_REPO = join(homedir(), "memories");
const MEMORY_DIR = join(MEMORIES_REPO, "memory");
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;
const STALE_LOCK_MS = 30_000;

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface MemoryCommitOptions {
	repoRoot: string;
	basename: string;
	run?: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const runCommand = async (command: string, args: string[], cwd: string): Promise<CommandResult> => {
	const { spawn } = await import("node:child_process");
	return new Promise((resolveResult) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => resolveResult({ code: -1, stdout, stderr: error.message }));
		child.on("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
	});
};

export const isMemoryPath = (targetPath: string, cwd: string, memoryDir = MEMORY_DIR): boolean => {
	const normalizedTarget = resolve(cwd, targetPath.startsWith("@") ? targetPath.slice(1) : targetPath);
	const pathFromMemory = relative(resolve(memoryDir), normalizedTarget);
	return pathFromMemory !== "" && !pathFromMemory.startsWith("..") && !isAbsolute(pathFromMemory);
};

const acquireLock = async (lockPath: string): Promise<(() => Promise<void>) | undefined> => {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n`);
			return async () => {
				await handle.close().catch(() => undefined);
				await unlink(lockPath).catch(() => undefined);
			};
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return undefined;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) await unlink(lockPath);
			} catch {
				// A competing process may have released the lock between checks.
			}
			if (attempt + 1 < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS * (attempt + 1));
		}
	}
	return undefined;
};

const runGit = async (run: NonNullable<MemoryCommitOptions["run"]>, repoRoot: string, args: string[]): Promise<CommandResult> => {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const result = await run("git", args, repoRoot);
		if (result.code === 0 || !result.stderr.includes("index.lock") || attempt + 1 === MAX_ATTEMPTS) return result;
		await delay(RETRY_DELAY_MS * (attempt + 1));
	}
	return { code: -1, stdout: "", stderr: "" };
};

export const commitMemoryChanges = async (options: MemoryCommitOptions): Promise<boolean> => {
	try {
		const run = options.run ?? runCommand;
		const gitDirResult = await runGit(run, options.repoRoot, ["rev-parse", "--git-dir"]);
		if (gitDirResult.code !== 0) return false;

		const gitDir = gitDirResult.stdout.trim();
		const resolvedGitDir = resolve(options.repoRoot, gitDir || ".git");
		const release = await acquireLock(join(resolvedGitDir, "pi-memories-sync.lock"));
		if (!release) return false;
		try {
			if ((await runGit(run, options.repoRoot, ["add", "-A", "--", "memory"])).code !== 0) return false;
			const staged = await runGit(run, options.repoRoot, ["diff", "--cached", "--quiet", "--", "memory"]);
			if (staged.code === 0) return false;
			if (staged.code !== 1) return false;
			const committed = await runGit(run, options.repoRoot, ["commit", "-m", `memory: ${options.basename}`, "--", "memory"]);
			return committed.code === 0;
		} finally {
			await release();
		}
	} catch {
		return false;
	}
};

export default function memoriesSyncExtension(pi: ExtensionAPI) {
	let commitQueue = Promise.resolve();

	pi.on("tool_result", (event, ctx) => {
		try {
			if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
			const targetPath = event.input.path;
			if (typeof targetPath !== "string" || !isMemoryPath(targetPath, ctx.cwd)) return;
			commitQueue = commitQueue
				.then(async () => {
					await commitMemoryChanges({
						repoRoot: MEMORIES_REPO,
						basename: basename(resolve(ctx.cwd, targetPath.startsWith("@") ? targetPath.slice(1) : targetPath)),
					});
				})
				.catch(() => undefined);
		} catch {
			// Memory synchronization must never affect the agent run.
		}
	});
}
