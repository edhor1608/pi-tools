import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const root = resolve(import.meta.dir, "..");
const gpt54Path = resolve(root, "defaults/model-system-prompts/openai-codex/gpt-5.4.md");
const gpt55Path = resolve(root, "defaults/model-system-prompts/openai-codex/gpt-5.5.md");

assert(existsSync(gpt54Path), "expected seeded gpt-5.4 prompt file");
assert(existsSync(gpt55Path), "expected seeded gpt-5.5 prompt file");

const gpt54 = readFileSync(gpt54Path, "utf8").trim();
const gpt55 = readFileSync(gpt55Path, "utf8").trim();

const normalizeSharedPrompt = (value: string): string =>
	value
		.replace("Use markdown links (not inline code) for clickable file paths.", "__FILE_LINKS__")
		.replace("Use Markdown links (not inline code) for clickable file paths.", "__FILE_LINKS__")
		.replace("Each reference should have a stand alone path. Even if it's the same file.", "__FILE_PATH__")
		.replace("Each reference should have a standalone path, even if it's the same file.", "__FILE_PATH__");

assert(gpt54.length > 0, "expected non-empty seeded gpt-5.4 prompt");
assert(gpt55.length > 0, "expected non-empty seeded gpt-5.5 prompt");
assert(gpt55.includes("Use Markdown links (not inline code) for clickable file paths."), "expected gpt-5.5 to keep the cleaned-up Markdown wording");
assert(gpt55.includes("Each reference should have a standalone path, even if it's the same file."), "expected gpt-5.5 to keep the cleaned-up standalone-path wording");
assert(
	normalizeSharedPrompt(gpt54) === normalizeSharedPrompt(gpt55),
	"expected gpt-5.5 seeded prompt coverage to stay aligned with the GPT-5 Codex family prompt apart from the intentional file-reference wording cleanup",
);

console.log(
	JSON.stringify(
		{
			gpt54Path,
			gpt55Path,
			promptLength: gpt55.length,
			normalizedMatching: normalizeSharedPrompt(gpt54) === normalizeSharedPrompt(gpt55),
		},
		null,
		2,
	),
);
