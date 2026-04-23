import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	getSettingsListTheme,
	getAgentDir,
	loadProjectContextFiles,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@mariozechner/pi-tui";
import { join, relative, resolve, sep } from "node:path";

const STATUS_KEY = "context-files";
const CONFIG_PATH = [".pi", "context-files.json"] as const;
const ENABLED_VALUE = "✓ enabled";
const DISABLED_VALUE = "× disabled";
const CONTEXT_SECTION_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_SECTION_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_MARKER = "\nCurrent date: ";

interface ContextFile {
	path: string;
	content: string;
}

interface ContextFilesConfig {
	version: 1;
	disabledPaths: string[];
}

const emptyConfig = (): ContextFilesConfig => ({
	version: 1,
	disabledPaths: [],
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isConfig = (value: unknown): value is ContextFilesConfig =>
	isObject(value) && value.version === 1 && Array.isArray(value.disabledPaths) && value.disabledPaths.every((item) => typeof item === "string");

const getConfigPath = (cwd: string): string => join(cwd, ...CONFIG_PATH);

const loadConfig = (cwd: string): ContextFilesConfig => {
	const path = getConfigPath(cwd);
	if (!existsSync(path)) return emptyConfig();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return isConfig(parsed) ? parsed : emptyConfig();
	} catch {
		return emptyConfig();
	}
};

const saveConfig = (cwd: string, config: ContextFilesConfig): void => {
	const path = getConfigPath(cwd);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: 1, disabledPaths: [...new Set(config.disabledPaths)].sort() }, null, 2)}\n`, "utf-8");
};

const discoverContextFiles = (cwd: string, agentDir = getAgentDir()): ContextFile[] =>
	loadProjectContextFiles({ cwd: resolve(cwd), agentDir: resolve(agentDir) }).map((file) => ({
		path: file.path,
		content: file.content,
	}));

const renderContextSection = (files: ContextFile[]): string => {
	if (files.length === 0) return "";
	return `${CONTEXT_SECTION_HEADER}${files.map((file) => `## ${file.path}\n\n${file.content.replace(/\n+$/g, "")}\n\n`).join("")}`;
};

const findContextSectionRange = (systemPrompt: string): { start: number; end: number } | undefined => {
	const start = systemPrompt.indexOf(CONTEXT_SECTION_HEADER);
	if (start === -1) return undefined;
	const searchFrom = start + CONTEXT_SECTION_HEADER.length;
	const skillStart = systemPrompt.indexOf(SKILLS_SECTION_HEADER, searchFrom);
	const dateStart = systemPrompt.indexOf(DATE_MARKER, searchFrom);
	let end = systemPrompt.length;
	if (skillStart !== -1) end = skillStart;
	if (dateStart !== -1 && dateStart < end) end = dateStart;
	return { start, end };
};

const replaceContextSection = (systemPrompt: string, allFiles: ContextFile[], enabledFiles: ContextFile[]): string => {
	const originalSection = renderContextSection(allFiles);
	const filteredSection = renderContextSection(enabledFiles);
	if (originalSection.length > 0) {
		const exactStart = systemPrompt.indexOf(originalSection);
		if (exactStart !== -1) {
			return `${systemPrompt.slice(0, exactStart)}${filteredSection}${systemPrompt.slice(exactStart + originalSection.length)}`;
		}
	}
	const range = findContextSectionRange(systemPrompt);
	if (!range) return systemPrompt;
	return `${systemPrompt.slice(0, range.start)}${filteredSection}${systemPrompt.slice(range.end)}`;
};

const filterSystemPrompt = (systemPrompt: string, cwd: string, agentDir = getAgentDir()): string => {
	const config = loadConfig(cwd);
	if (config.disabledPaths.length === 0) return systemPrompt;
	const files = discoverContextFiles(cwd, agentDir);
	if (files.length === 0) return systemPrompt;
	const disabled = new Set(config.disabledPaths.map((path) => resolve(path)));
	const enabledFiles = files.filter((file) => !disabled.has(resolve(file.path)));
	const filtered = replaceContextSection(systemPrompt, files, enabledFiles);
	return filtered;
};

const formatDisplayPath = (path: string, cwd: string, agentDir = getAgentDir()): string => {
	const resolvedPath = resolve(path);
	const resolvedAgentDir = resolve(agentDir);
	const agentPrefix = `${resolvedAgentDir}${sep}`;
	if (resolvedPath === resolvedAgentDir || resolvedPath.startsWith(agentPrefix)) {
		return `~/.pi/agent/${relative(resolvedAgentDir, resolvedPath).split(sep).join("/")}`.replace(/\/$/, "");
	}
	const rel = relative(resolve(cwd), resolvedPath).split(sep).join("/");
	if (!rel || rel === "") return ".";
	if (rel.startsWith(".")) return rel;
	return rel.startsWith("..") ? rel : `./${rel}`;
};

const getDisabledCount = (cwd: string): number => {
	const config = loadConfig(cwd);
	if (config.disabledPaths.length === 0) return 0;
	const disabled = new Set(config.disabledPaths.map((path) => resolve(path)));
	return discoverContextFiles(cwd).filter((file) => disabled.has(resolve(file.path))).length;
};

const updateUi = (ctx: ExtensionContext): void => {
	const disabledCount = getDisabledCount(ctx.cwd);
	ctx.ui.setStatus(
		STATUS_KEY,
		disabledCount > 0 ? ctx.ui.theme.fg("accent", `context ${disabledCount} off`) : undefined,
	);
};

const buildSnapshotText = (cwd: string): string => {
	const config = loadConfig(cwd);
	const disabled = new Set(config.disabledPaths.map((path) => resolve(path)));
	const files = discoverContextFiles(cwd);
	if (files.length === 0) return "Context files\n- no AGENTS.md or CLAUDE.md files discovered";
	const lines = ["Context files"];
	for (const file of files) {
		const enabled = !disabled.has(resolve(file.path));
		lines.push(`- ${enabled ? "✓" : "×"} ${formatDisplayPath(file.path, cwd)}`);
	}
	return lines.join("\n");
};

const openContextFilesUi = async (ctx: ExtensionCommandContext): Promise<void> => {
	if (!ctx.hasUI) {
		ctx.ui.notify(buildSnapshotText(ctx.cwd), "info");
		return;
	}
	const files = discoverContextFiles(ctx.cwd);
	if (files.length === 0) {
		ctx.ui.notify("No AGENTS.md or CLAUDE.md files discovered", "info");
		return;
	}
	let config = loadConfig(ctx.cwd);
	const disabled = new Set(config.disabledPaths.map((path) => resolve(path)));
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const items: SettingItem[] = files.map((file) => {
			const resolvedPath = resolve(file.path);
			return {
				id: resolvedPath,
				label: formatDisplayPath(file.path, ctx.cwd),
				description: file.path,
				currentValue: disabled.has(resolvedPath) ? DISABLED_VALUE : ENABLED_VALUE,
				values: [ENABLED_VALUE, DISABLED_VALUE],
			};
		});
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Context Files")), 1, 0));
		container.addChild(
			new Text(
				theme.fg("dim", "Toggle whether discovered AGENTS.md and CLAUDE.md files are sent to the model."),
				1,
				0,
			),
		);
		container.addChild(
			new Text(
				theme.fg("dim", "Note: Pi's startup context list still comes from core discovery; this extension filters the final prompt."),
				1,
				0,
			),
		);
		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 14),
			getSettingsListTheme(),
			(id, newValue) => {
				if (newValue === DISABLED_VALUE) disabled.add(id);
				else disabled.delete(id);
				config = {
					version: 1,
					disabledPaths: [...disabled],
				};
				saveConfig(ctx.cwd, config);
				updateUi(ctx);
			},
			() => done(undefined),
		);
		container.addChild(settingsList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter/space toggle • esc close"), 1, 0));
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

export { discoverContextFiles, filterSystemPrompt };

export default function contextFilesExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const filtered = filterSystemPrompt(event.systemPrompt, ctx.cwd);
		return filtered === event.systemPrompt ? undefined : { systemPrompt: filtered };
	});

	pi.on("session_start", async (_event, ctx) => {
		updateUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("context-files", {
		description: "Enable or disable discovered AGENTS.md and CLAUDE.md files for the model prompt",
		handler: async (_args, ctx) => {
			await openContextFilesUi(ctx);
		},
	});
}
