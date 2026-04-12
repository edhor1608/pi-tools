import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensurePackagedDefaults } from "./shared/defaults.ts";

const PROMPTS_DIR = "model-system-prompts";
const DEFAULT_FILE = "_default.md";

const sanitizeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const getRoots = (cwd: string): string[] => [join(homedir(), ".pi", "agent", PROMPTS_DIR), join(cwd, ".pi", PROMPTS_DIR)];

const ensureModelPromptDefaults = () => {
	ensurePackagedDefaults(import.meta.url, "defaults/model-system-prompts", join(homedir(), ".pi", "agent", PROMPTS_DIR));
};

const getPromptPaths = (cwd: string, provider: string, model: string): string[] => {
	const providerDir = sanitizeSegment(provider);
	const modelFile = `${sanitizeSegment(model)}.md`;

	return getRoots(cwd).flatMap((root) => [
		join(root, DEFAULT_FILE),
		join(root, providerDir, DEFAULT_FILE),
		join(root, providerDir, modelFile),
	]);
};

const readPromptFile = (path: string): string | undefined => {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8").trim();
	return text.length > 0 ? text : undefined;
};

export default function modelSystemPromptExtension(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		ensureModelPromptDefaults();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ensureModelPromptDefaults();
		const model = ctx.model;
		if (!model) return undefined;

		const fragments = getPromptPaths(ctx.cwd, model.provider, model.id)
			.map(readPromptFile)
			.filter((fragment): fragment is string => fragment !== undefined);

		if (fragments.length === 0) return undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${fragments.join("\n\n")}`,
		};
	});
}
