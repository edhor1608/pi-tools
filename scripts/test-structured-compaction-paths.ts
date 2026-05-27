import { getModel } from "@mariozechner/pi-ai";
import { convertAgentMessagesToResponsesInput } from "../extensions/structured-compaction/responses-adapter.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const model = getModel("openai-codex", "gpt-5.4") ?? getModel("openai", "gpt-4.1");
assert(model, "expected an OpenAI-compatible built-in model");

const items = await convertAgentMessagesToResponsesInput(model, [
	{
		role: "user",
		content: [{ type: "text", text: "Summarize the current repo state." }],
		timestamp: Date.now(),
	},
]);

assert(Array.isArray(items), "expected converted responses input items");
assert(items.length > 0, "expected at least one converted responses input item");

const firstItem = items[0];
const firstItemType =
	typeof firstItem === "object" && firstItem !== null && "type" in firstItem ? String(firstItem.type) : typeof firstItem;

console.log(
	JSON.stringify(
		{
			model: `${model.provider}/${model.id}`,
			itemCount: items.length,
			firstItemType,
		},
		null,
		2,
	),
);
