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

assert(gpt54.length > 0, "expected non-empty seeded gpt-5.4 prompt");
assert(gpt55.length > 0, "expected non-empty seeded gpt-5.5 prompt");
assert(gpt54 === gpt55, "expected gpt-5.5 seeded prompt coverage to match the current GPT-5 Codex family prompt text");

console.log(
	JSON.stringify(
		{
			gpt54Path,
			gpt55Path,
			promptLength: gpt55.length,
			matching: gpt54 === gpt55,
		},
		null,
		2,
	),
);
