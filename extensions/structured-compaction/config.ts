import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ensurePackagedDefaults } from "../shared/defaults.ts";
import type { StructuredCompactionConfig, StructuredCompactionPrompts } from "./types.ts";

const ROOT_DIR_NAME = "structured-compaction";
const CONFIG_FILE_NAME = "config.json";
const SYSTEM_PROMPT_RELATIVE_PATH = "prompts/system.md";
const COMPACT_PROMPT_RELATIVE_PATH = "prompts/compact.md";

const DEFAULT_CONFIG: StructuredCompactionConfig = {
	enabled: true,
	backend: {
		kind: "auto",
		model: null,
		fallbackToActiveModel: true,
		maxTokens: 8192,
		reasoning: "high",
		remote: {
			endpointMode: "auto",
			originator: "pi",
		},
	},
	renderer: {
		kind: "compaction-summary",
		customType: "structured-compaction-summary",
		display: false,
	},
	prompt: {},
	debug: {
		notify: false,
	},
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const deepMerge = <T>(base: T, override: unknown): T => {
	if (!isPlainObject(base) || !isPlainObject(override)) return (override as T) ?? base;

	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = merged[key];
		merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return merged as T;
};

const readJson = (path: string): unknown | undefined => {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
};

const readText = (path: string): string | undefined => {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8").trim();
	return text.length > 0 ? text : undefined;
};

const getRoots = (cwd: string) => ({
	globalRoot: join(homedir(), ".pi", "agent", ROOT_DIR_NAME),
	projectRoot: join(cwd, ".pi", ROOT_DIR_NAME),
});

const ensureStructuredCompactionDefaults = () => {
	ensurePackagedDefaults(
		import.meta.url,
		"defaults/structured-compaction",
		join(homedir(), ".pi", "agent", ROOT_DIR_NAME),
	);
};

const resolveCandidatePaths = (cwd: string, relativeOrAbsolutePath: string | undefined, defaultRelativePath: string): string[] => {
	const { globalRoot, projectRoot } = getRoots(cwd);
	if (relativeOrAbsolutePath) {
		if (isAbsolute(relativeOrAbsolutePath)) return [relativeOrAbsolutePath];
		return [join(projectRoot, relativeOrAbsolutePath), join(globalRoot, relativeOrAbsolutePath)];
	}
	return [join(projectRoot, defaultRelativePath), join(globalRoot, defaultRelativePath)];
};

export const getStructuredCompactionRoots = getRoots;

export const loadStructuredCompactionConfig = (cwd: string): StructuredCompactionConfig => {
	ensureStructuredCompactionDefaults();
	const { globalRoot, projectRoot } = getRoots(cwd);
	const globalConfig = readJson(join(globalRoot, CONFIG_FILE_NAME));
	const projectConfig = readJson(join(projectRoot, CONFIG_FILE_NAME));
	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
};

export const loadStructuredCompactionPrompts = (
	cwd: string,
	config: StructuredCompactionConfig,
): StructuredCompactionPrompts => {
	ensureStructuredCompactionDefaults();
	const systemCandidates = resolveCandidatePaths(cwd, config.prompt.systemPath, SYSTEM_PROMPT_RELATIVE_PATH);
	const compactCandidates = resolveCandidatePaths(cwd, config.prompt.compactPath, COMPACT_PROMPT_RELATIVE_PATH);

	const systemPath = systemCandidates.find(existsSync);
	const compactPath = compactCandidates.find(existsSync);
	const system = systemPath ? readText(systemPath) : undefined;
	const compact = compactPath ? readText(compactPath) : undefined;

	if (!system) {
		throw new Error(`Missing structured compaction system prompt. Checked: ${systemCandidates.join(", ")}`);
	}
	if (!compact) {
		throw new Error(`Missing structured compaction compact prompt. Checked: ${compactCandidates.join(", ")}`);
	}

	return {
		system,
		systemPath,
		compact,
		compactPath,
	};
};
