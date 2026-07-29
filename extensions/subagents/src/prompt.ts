/** All model-facing strings for the subagents tools. */

/** Describes fire-and-forget Pi and Claude Code subagents. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
	"Spawn a fully autonomous background subagent with its own context window and normal host permissions. Choose pi (in-process Pi session that inherits this environment) or claude (Claude Code through the user's existing login). The tool returns an id immediately. The final output is delivered automatically or can be collected with subagent_wait. Claude sessions in orchestrator mode can autonomously create and manage visible Pi or Claude descendants. Children cannot ask the user or see the parent conversation, so prompts must be self-contained.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
	"Spawn a Pi or Claude Code background agent with its own context and normal tools for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
	"Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt. Use orchestrator mode when Claude should dynamically lead further visible Pi or Claude descendants.",
	"Pick the subagent harness deliberately: use pi by default and Claude Code when requested. Claude-family model hints always route to the Claude Code harness, even when pi was requested.",
	"After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
	prompt: "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
	name: "Short human-readable name for this subagent, shown in listings and the UI",
	harness:
		'Harness to run the subagent on: "pi" (in-process Pi session that inherits this environment) or "claude" (Claude Code through the user login). Claude-family models always route to Claude Code.',
	workingDir: "Working directory for the autonomous child (default: current working directory)",
	mode: '"worker" for a leaf agent (default), or "orchestrator" to give a Claude session direct host-managed delegation controls.',
	model:
		'Model hint interpreted by the harness (pi: "provider/model-id" or model id; claude: a Claude Code model alias). Claude-family hints and the fable/haiku/opus/sonnet aliases auto-route to Claude Code and drop any provider prefix. Omit for the harness default; pi inherits the current model.',
	reasoningEffort:
		"Reasoning effort on a shared scale, mapped to Pi thinking levels or Claude thinking budgets. Omit for the harness default; pi inherits the current level.",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
	id: string;
	title: string;
	harness: string;
	mode: string;
	modelLabel: string;
	cwd: string;
}) {
	return (
		`Spawned subagent ${options.id} "${options.title}" (${options.mode}, ${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
		`It runs in the background. Its result will be delivered to you when it finishes, ` +
		`or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
	);
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
	"Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
	ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
	"Cancel one or more running subagents and their active descendant subtrees. Partial native transcripts remain on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
	ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
	"Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
	id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION = "List the complete subagent tree (running and finished) with ownership, harness, and status.";

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
	"Steer a running subagent or start another turn in an idle one. Returns immediately and keeps the session and transcript intact.";

export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
	id: "Subagent id",
	message: "Guidance or follow-up message to send",
};

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
	id: string;
	title: string;
	status: "running" | "done" | "error";
	errorText?: string;
	output: string;
}) {
	const verb = options.status === "error" ? "failed" : "finished";
	let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
	if (options.errorText) text += `\nError: ${options.errorText}`;
	text += `\n\n${options.output}`;
	return text;
}
