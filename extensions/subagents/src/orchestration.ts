import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BACKEND_NAMES, REASONING_EFFORTS, SUBAGENT_MODES, type OrchestrationController, type SubagentSnapshot } from "./domain.ts";

const TOOL_OUTPUT_MAX_LENGTH = 48 * 1_024;
const RESULT_OUTPUT_MAX_LENGTH = 16 * 1_024;

function requestSignal(extra: unknown) {
	if (!extra || typeof extra !== "object") return undefined;
	const signal = (extra as { signal?: unknown }).signal;
	return signal instanceof AbortSignal ? signal : undefined;
}

function textResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text: text.slice(-TOOL_OUTPUT_MAX_LENGTH) }],
		...(isError ? { isError: true } : {}),
	};
}

async function handle(work: () => Promise<string>) {
	try {
		return textResult(await work());
	} catch (error) {
		return textResult(error instanceof Error ? error.message : String(error), true);
	}
}

function describe(snap: SubagentSnapshot) {
	const relation = snap.parentId ? `, parent ${snap.parentId}` : "";
	return `${snap.id} [${snap.status}] "${snap.title}" (${snap.backend}: ${snap.meta.modelLabel ?? "?"}, ${snap.mode}${relation})`;
}

function resultText(snap: SubagentSnapshot) {
	const verb = snap.status === "error" ? "failed" : "finished";
	const error = snap.errorText ? `\nError: ${snap.errorText}` : "";
	const output = (snap.finalText || "(no output)").slice(-RESULT_OUTPUT_MAX_LENGTH);
	return `## ${snap.id} "${snap.title}" ${verb}${error}\n\n${output}`;
}

export function createOrchestrationTools(controller: OrchestrationController) {
	return [
		tool(
			"subagent_spawn",
			"Spawn a host-managed Pi or Claude descendant. It starts immediately and remains visible to the main agent.",
			{
				prompt: z.string().min(1).describe("Complete standalone task prompt for the child"),
				name: z.string().min(1).describe("Short display name"),
				harness: z.enum(BACKEND_NAMES),
				working_dir: z.string().optional().describe("Working directory relative to this orchestrator, or an absolute path"),
				model: z.string().optional(),
				reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
				mode: z.enum(SUBAGENT_MODES).optional().describe("Use orchestrator only when this child should also delegate"),
			},
			(args, extra) =>
				handle(async () => {
					const snap = await controller.spawn(
						{
							prompt: args.prompt,
							title: args.name,
							harness: args.harness,
							...(args.working_dir !== undefined ? { workingDir: args.working_dir } : {}),
							...(args.model !== undefined ? { model: args.model } : {}),
							...(args.reasoning_effort !== undefined ? { reasoningEffort: args.reasoning_effort } : {}),
							...(args.mode !== undefined ? { mode: args.mode } : {}),
						},
						requestSignal(extra),
					);
					return `Spawned ${describe(snap)}. Continue working; its result will return automatically, or wait when blocked on it.`;
				}),
			{ alwaysLoad: true },
		),
		tool(
			"subagent_wait",
			"Wait for descendant agents only when their outputs are required before continuing.",
			{ ids: z.array(z.string()).min(1).max(64) },
			(args, extra) =>
				handle(async () => {
					const results = await controller.wait(args.ids, requestSignal(extra));
					return results.map(resultText).join("\n\n---\n\n");
				}),
			{ alwaysLoad: true },
		),
		tool(
			"subagent_cancel",
			"Cancel descendant agents and their active descendant subtrees.",
			{ ids: z.array(z.string()).min(1).max(64) },
			(args, extra) =>
				handle(async () => {
					const results = await controller.cancel(args.ids, requestSignal(extra));
					return results
						.map((result) =>
							result.cancelled
								? `Cancelled ${result.id} "${result.title}".`
								: `${result.id} "${result.title}" was already ${result.status}.`,
						)
						.join("\n");
				}),
			{ alwaysLoad: true },
		),
		tool(
			"subagent_send",
			"Steer or continue a descendant agent without waiting for it.",
			{ id: z.string(), message: z.string().min(1) },
			(args, extra) =>
				handle(async () => {
					await controller.send(args.id, args.message, requestSignal(extra));
					return `Sent guidance to ${args.id}.`;
				}),
			{ alwaysLoad: true },
		),
		tool(
			"subagent_check",
			"Inspect one descendant without blocking or consuming its result.",
			{ id: z.string() },
			(args) =>
				handle(async () => {
					const snap = await controller.get(args.id);
					if (!snap) throw new Error(`Subagent "${args.id}" was not found in this descendant tree.`);
					const output = snap.finalText ? `\n\nLatest output:\n${snap.finalText.slice(-2_048)}` : "";
					return `${describe(snap)}\nTurns: ${snap.turns}${snap.errorText ? `\nError: ${snap.errorText}` : ""}${output}`;
				}),
			{ alwaysLoad: true },
		),
		tool(
			"subagent_list",
			"List this orchestrator's complete descendant tree with current status.",
			{},
			() =>
				handle(async () => {
					const descendants = await controller.list();
					return descendants.length > 0 ? descendants.map(describe).join("\n") : "No descendants.";
				}),
			{ alwaysLoad: true },
		),
	];
}

export function createOrchestrationServer(controller: OrchestrationController) {
	return createSdkMcpServer({
		name: "pi-subagents",
		version: "1.0.0",
		alwaysLoad: true,
		instructions:
			"You may autonomously delegate through these host-managed controls. Decide dynamically whether workers help; there is no required workflow or approval step. Child prompts must be self-contained. Unawaited results return automatically. The main agent and user can observe and steer every descendant.",
		tools: createOrchestrationTools(controller),
	});
}
