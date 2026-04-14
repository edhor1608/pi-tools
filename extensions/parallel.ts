import { existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import {
	WORKGRAPH_STATE_ENTRY_TYPE,
	attachPreparedWorkspace,
	cloneWorkgraphState,
	findWorkgraphItem,
	isResolvedStatus,
	readWorkgraphStateFromBranch,
	summarizeText,
	type WorkgraphItem,
	type WorkgraphState,
} from "./shared/workgraph-state.ts";

const REPORT_MESSAGE_TYPE = "parallel-report";

interface ParallelReportMessageDetails {
	preview: string;
}

interface PreparedItemReport {
	id: number;
	text: string;
	branchName: string;
	worktreePath: string;
	workerPrompt: string;
}

const slugify = (value: string): string =>
	summarizeText(value, 42)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "item";

const runGit = (cwd: string, args: string[]): string => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		const stderr = result.stderr.trim();
		throw new Error(stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
};

const hasGitRef = (cwd: string, ref: string): boolean => {
	const result = spawnSync("git", ["rev-parse", "--verify", ref], { cwd, encoding: "utf8" });
	return result.status === 0;
};

const getRepoRoot = (cwd: string): string => runGit(cwd, ["rev-parse", "--show-toplevel"]);

const ensureCleanRepo = (repoRoot: string): void => {
	const status = runGit(repoRoot, ["status", "--porcelain"]);
	if (status.length > 0) {
		throw new Error("parallel prepare requires a clean git working tree because worktrees branch from HEAD");
	}
};

const buildWorktreePath = (repoRoot: string, item: WorkgraphItem): string => {
	const parent = dirname(repoRoot);
	const repoName = basename(repoRoot);
	const base = `${repoName}-wg-${item.id}-${slugify(item.text)}`;
	let attempt = 0;
	while (true) {
		const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
		const candidate = join(parent, `${base}${suffix}`);
		if (!existsSync(candidate)) return candidate;
		attempt += 1;
	}
};

const buildBranchName = (repoRoot: string, item: WorkgraphItem): string => {
	const base = `pi/workgraph-${item.id}-${slugify(item.text)}`;
	let attempt = 0;
	while (true) {
		const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
		const candidate = `${base}${suffix}`;
		if (!hasGitRef(repoRoot, `refs/heads/${candidate}`)) return candidate;
		attempt += 1;
	}
};

const summarizeState = (state: WorkgraphState): string => {
	if (state.items.length === 0) return "- no workgraph items";
	return state.items
		.map((item) => {
			const tags: string[] = [];
			if (item.execution === "parallel") tags.push("parallel");
			if (item.kind === "merge") tags.push("merge");
			const prefix = tags.length > 0 ? ` [${tags.join(",")}]` : "";
			const deps = item.dependTo.length > 0 ? ` depends on ${item.dependTo.map((id) => `#${id}`).join(", ")}` : "";
			return `- #${item.id}${prefix} ${summarizeText(item.text)} (${item.status})${deps}`;
		})
		.join("\n");
};

const buildWorkerPrompt = (state: WorkgraphState, item: WorkgraphItem, repoRoot: string, worktreePath: string, branchName: string): string => {
	const currentBranch = runGit(repoRoot, ["branch", "--show-current"]);
	return [
		`Continue workgraph item #${item.id} in the prepared worktree.`,
		"",
		"## Focus",
		item.text,
		"",
		"## Workspace",
		`- repo root: ${repoRoot}`,
		`- source branch: ${currentBranch || "HEAD"}`,
		`- worktree path: ${worktreePath}`,
		`- worker branch: ${branchName}`,
		"",
		"## Rules",
		"- Work only on this one item inside the prepared worktree.",
		"- Do not merge back automatically; merges are represented as explicit workgraph items.",
		"- If this item becomes blocked, keep the workgraph item blocked instead of pretending it is done.",
		"",
		"## Current Workgraph",
		summarizeState(state),
	].join("\n");
};

const ensureItemCanPrepare = (state: WorkgraphState, item: WorkgraphItem): void => {
	if (item.kind === "merge") throw new Error(`Item #${item.id} is a merge item and must stay local`);
	if (item.execution !== "parallel") throw new Error(`Item #${item.id} is not marked for parallel execution`);
	if (item.status === "blocked") throw new Error(`Item #${item.id} is blocked`);
	if (isResolvedStatus(item.status)) throw new Error(`Item #${item.id} is already resolved`);
	if (item.dependTo.length > 0) {
		const unresolved = item.dependTo.filter((id) => {
			const dependency = findWorkgraphItem(state, id);
			return !dependency || !isResolvedStatus(dependency.status);
		});
		if (unresolved.length > 0) {
			throw new Error(`Item #${item.id} is still waiting on ${unresolved.map((id) => `#${id}`).join(", ")}`);
		}
	}
	if (item.worktreePath && item.branchName) {
		throw new Error(`Item #${item.id} is already prepared at ${item.worktreePath}`);
	}
};

const prepareItem = (state: WorkgraphState, cwd: string, item: WorkgraphItem): PreparedItemReport => {
	ensureItemCanPrepare(state, item);
	const repoRoot = getRepoRoot(cwd);
	ensureCleanRepo(repoRoot);
	const worktreePath = buildWorktreePath(repoRoot, item);
	const branchName = buildBranchName(repoRoot, item);
	runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath]);
	const preparedAt = Date.now();
	const workerPrompt = buildWorkerPrompt(state, item, repoRoot, worktreePath, branchName);
	attachPreparedWorkspace(state, item.id, {
		repoRoot,
		worktreePath,
		branchName,
		preparedAt,
		workerPrompt,
	});
	return {
		id: item.id,
		text: item.text,
		branchName,
		worktreePath,
		workerPrompt,
	};
};

const buildReportPreview = (prepared: PreparedItemReport[]): string => {
	if (prepared.length === 0) return "- no prepared worktrees";
	return prepared.map((item) => `- #${item.id} ${basename(item.worktreePath)}`).join("\n");
};

const buildReportText = (prepared: PreparedItemReport[]): string => {
	if (prepared.length === 0) return "Parallel\n- no prepared worktrees";
	const lines = ["Parallel Prepared Worktrees"];
	for (const item of prepared) {
		lines.push(`- #${item.id} ${summarizeText(item.text)}`);
		lines.push(`  branch: ${item.branchName}`);
		lines.push(`  path: ${item.worktreePath}`);
		lines.push(`  start: cd ${item.worktreePath} && pi`);
	}
	return lines.join("\n");
};

const sendReport = (pi: ExtensionAPI, prepared: PreparedItemReport[]) => {
	pi.sendMessage({
		customType: REPORT_MESSAGE_TYPE,
		content: buildReportText(prepared),
		display: true,
		details: {
			preview: buildReportPreview(prepared),
		} satisfies ParallelReportMessageDetails,
	});
};

export default function parallelExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(REPORT_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as ParallelReportMessageDetails | undefined;
		const box = new Container();
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		box.addChild(new Text(theme.fg("accent", theme.bold("Parallel")), 1, 0));
		box.addChild(new Text(options.expanded ? String(message.content) : details?.preview ?? String(message.content), 1, 0));
		box.addChild(new Text(theme.fg("dim", options.expanded ? "Prepared worktrees" : "Expand for paths and commands"), 1, 0));
		box.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return box;
	});

	pi.registerCommand("parallel", {
		description: "Prepare parallel workgraph items into git worktrees",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command, arg] = trimmed ? trimmed.split(/\s+/, 2) : ["list", undefined];
			try {
				if (command === "list") {
					const state = readWorkgraphStateFromBranch(ctx.sessionManager.getBranch());
					const prepared = state.items
						.filter((item) => item.worktreePath && item.branchName)
						.map((item) => ({
							id: item.id,
							text: item.text,
							branchName: item.branchName!,
							worktreePath: item.worktreePath!,
							workerPrompt: item.workerPrompt || "",
						}));
					sendReport(pi, prepared);
					return;
				}
				if (command === "prompt") {
					const id = Number(arg);
					if (!Number.isInteger(id)) throw new Error("Usage: /parallel prompt <id>");
					const state = readWorkgraphStateFromBranch(ctx.sessionManager.getBranch());
					const item = findWorkgraphItem(state, id);
					if (!item || !item.workerPrompt) throw new Error(`Item #${id} has no prepared worker prompt`);
					pi.sendMessage({
						customType: REPORT_MESSAGE_TYPE,
						content: item.workerPrompt,
						display: true,
						details: { preview: `- #${item.id} worker prompt` } satisfies ParallelReportMessageDetails,
					});
					return;
				}
				if (command !== "prepare") {
					throw new Error("Usage: /parallel [list|prepare|prompt <id>]");
				}
				const state = readWorkgraphStateFromBranch(ctx.sessionManager.getBranch());
				const prepared: PreparedItemReport[] = [];
				if (!arg) {
					for (const item of state.items) {
						if (item.execution !== "parallel" || item.kind === "merge") continue;
						if (item.status === "blocked" || isResolvedStatus(item.status)) continue;
						const unresolved = item.dependTo.filter((id) => {
							const dependency = findWorkgraphItem(state, id);
							return !dependency || !isResolvedStatus(dependency.status);
						});
						if (unresolved.length > 0) continue;
						if (item.worktreePath || item.branchName) continue;
						prepared.push(prepareItem(state, ctx.cwd, item));
					}
					if (prepared.length === 0) {
						ctx.ui.notify("No ready parallel items to prepare", "info");
						return;
					}
				} else {
					const id = Number(arg);
					if (!Number.isInteger(id)) throw new Error("Usage: /parallel prepare [id]");
					const item = findWorkgraphItem(state, id);
					if (!item) throw new Error(`Item #${id} not found`);
					prepared.push(prepareItem(state, ctx.cwd, item));
				}
				pi.appendEntry(WORKGRAPH_STATE_ENTRY_TYPE, cloneWorkgraphState(state));
				sendReport(pi, prepared);
				ctx.ui.notify(prepared.length === 1 ? `Prepared worktree for #${prepared[0]!.id}` : `Prepared ${prepared.length} worktrees`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
		},
	});
}
