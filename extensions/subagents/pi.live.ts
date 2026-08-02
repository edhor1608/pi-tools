import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

await test("Pi backend completes a live inherited-model run", { timeout: 60_000 }, async (context) => {
	const modelRuntime = await ModelRuntime.create();
	const modelRegistry = new ModelRegistry(modelRuntime);
	const model = modelRegistry.find("openai-codex", "gpt-5.6-sol");
	if (!model || !modelRegistry.hasConfiguredAuth(model)) {
		context.skip("openai-codex/gpt-5.6-sol is unavailable");
		return;
	}

	const runtime = createSubagentRuntime();
	try {
		const manager = await runtime.runPromise(SubagentManager);
		const started = await runTool(
			runtime,
			manager.spawn("pi", {
				prompt: "Reply with exactly: hello pi subagent",
				title: "live Pi test",
				cwd: process.cwd(),
				parent: {
					parentCwd: process.cwd(),
					inheritedModel: { provider: model.provider, id: model.id },
					inheritedThinkingLevel: "off",
					modelRegistry,
				},
			}),
		);
		await runTool(runtime, manager.waitFor([started.id]));

		const done = manager.view.get(started.id);
		assert.equal(done?.status, "done");
		assert.match(done?.finalText ?? "", /hello pi subagent/i);
		assert.equal(done?.meta.modelLabel, "openai-codex/gpt-5.6-sol");
		assert.ok(done?.meta.sessionFilePath?.endsWith(".jsonl") === true);
	} finally {
		await runtime.dispose();
	}
});
