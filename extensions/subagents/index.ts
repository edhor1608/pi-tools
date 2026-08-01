/**
 * Subagents — spawn background Pi and Claude Code agents behind one Effect
 * service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, name, harness, working_dir,
 *   model, reasoning_effort).
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_send: steer or continue a subagent.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list the complete subagent tree.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. Pi runs in-process SDK sessions and
 * Claude drives the Claude Agent SDK through the user's Claude Code login.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	keyHint,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	BACKEND_NAMES,
	formatElapsed,
	latestText,
	orderSubagentTree,
	REASONING_EFFORTS,
	SUBAGENT_MODES,
	type SubagentSnapshot,
} from "./src/domain.ts";
import { formatActivityStatus, formatContextUtilization } from "./src/format.ts";
import { claimSubagentPlane, releaseSubagentPlane } from "../review-loop/plane-claim.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
	buildSubagentResultMessage,
	buildSubagentSpawnResult,
	SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
	SUBAGENT_CANCEL_TOOL_DESCRIPTION,
	SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
	SUBAGENT_CHECK_TOOL_DESCRIPTION,
	SUBAGENT_LIST_TOOL_DESCRIPTION,
	SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
	SUBAGENT_SEND_TOOL_DESCRIPTION,
	SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
	SUBAGENT_SPAWN_PROMPT_GUIDELINES,
	SUBAGENT_SPAWN_PROMPT_SNIPPET,
	SUBAGENT_SPAWN_TOOL_DESCRIPTION,
	SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
	SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { createSubagentRuntime, runTool, type SubagentRuntime } from "./src/runtime.ts";
import { openSubagentPicker } from "./src/ui/takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
const PAID_OPENCODE_CONFIG_FILE = "pi-tools.json";

function loadPaidOpenCodeUserGate(configPath: string) {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"allowPaidOpencode" in parsed &&
			(parsed as { allowPaidOpencode?: unknown }).allowPaidOpencode === true
		);
	} catch {
		return false;
	}
}

function describeSubagent(snap: SubagentSnapshot) {
	const details = [
		`${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
		snap.mode,
		snap.parentId ? `parent ${snap.parentId}` : undefined,
		snap.waitingForChildren ? "waiting for descendants" : undefined,
		formatContextUtilization(snap.usage),
		formatElapsed(snap),
		snap.cwd,
	].filter(Boolean);
	return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(snap: SubagentSnapshot, maxBytes = SUBAGENT_OUTPUT_MAX_BYTES): string {
	const output = snap.finalText || "(no output)";
	const truncation = truncateHead(output, {
		maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
		maxLines: Math.min(600, DEFAULT_MAX_LINES),
	});
	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
	}
	return text;
}

export default function (pi: ExtensionAPI) {
	const paidOpencodeConfigPath = path.join(getAgentDir(), PAID_OPENCODE_CONFIG_FILE);
	const userAllowsPaidOpencode = loadPaidOpenCodeUserGate(paidOpencodeConfigPath);
	let runtime: SubagentRuntime | undefined;
	let managerPromise: Promise<SubagentManagerShape> | undefined;
	let sessionContext: ExtensionContext | undefined;
	let ui: ExtensionUIContext | undefined;
	let unsubStatus: (() => void) | undefined;
	const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

	const getRuntime = () => (runtime ??= createSubagentRuntime());

	/** Resolve the manager service once per runtime and wire the extension hooks. */
	const getManager = () => {
		managerPromise ??= getRuntime()
			.runPromise(SubagentManager)
			.then((manager) => {
				managerSync = manager;
				manager.view.setOnSettled(onSettled);
				manager.view.setOnStarted((id) => resultDelivery.consume([id]));
				unsubStatus?.();
				unsubStatus = manager.view.subscribe(() => updateStatus(manager));
				updateStatus(manager);
				return manager;
			});
		return managerPromise;
	};

	// --- Shared control-plane handle ---------------------------------------
	// Narrow handle over the LIVE manager for sibling extensions (review-loop),
	// published on globalThis under a well-known symbol — the same cross-jiti
	// sharing pattern as extensions/shared/status-bus.ts. Only spawn / waitFor
	// / cancel / send / get are exposed; everything is lazy so publishing does
	// not spin up the runtime early. Spawned agents appear in /subagents and
	// share the manager's model-routing invariants.
	//
	// Publication is FIRST-CLAIM-WINS (see plane-claim.ts): Pi children run
	// in-process and instantiate this extension again — without the ownership
	// token a child would overwrite the root's handle with its own hidden
	// manager and delete it on the child's shutdown. The root session loads
	// first, so the root instance claims; later instances get no token, never
	// publish, and never retract.
	let managerSync: SubagentManagerShape | undefined;
	const planeParent = () => ({
		parentCwd: sessionContext?.cwd ?? process.cwd(),
		inheritedModel: sessionContext?.model ? { provider: sessionContext.model.provider, id: sessionContext.model.id } : undefined,
		inheritedThinkingLevel: pi.getThinkingLevel(),
		modelRegistry: sessionContext?.modelRegistry,
	});
	const planeToken = claimSubagentPlane({
		spawn: async (backend: "pi" | "claude", request: { prompt: string; title: string; cwd: string; model?: string }) => {
			const manager = await getManager();
			return runTool(
				getRuntime(),
				manager.spawn(backend, {
					prompt: request.prompt,
					title: request.title,
					cwd: request.cwd,
					mode: "worker",
					model: request.model,
					parent: planeParent(),
				}),
			);
		},
		waitFor: async (ids: readonly string[]) => {
			const manager = await getManager();
			await runTool(getRuntime(), manager.waitFor([...ids]));
		},
		cancel: async (ids: readonly string[]) => {
			const manager = await getManager();
			await runTool(getRuntime(), manager.cancel([...ids]));
		},
		send: async (id: string, text: string) => {
			const manager = await getManager();
			await runTool(getRuntime(), manager.send(id, text));
		},
		get: (id: string) => managerSync?.view.get(id),
	});

	const updateStatus = (manager: SubagentManagerShape) => {
		if (!ui) return;
		const subs = manager.view.list();
		if (subs.length === 0) {
			ui.setStatus("subagents", undefined);
			return;
		}
		const running = subs.filter((snap) => snap.status === "running").length;
		const failed = subs.filter((snap) => snap.status === "error").length;
		const done = subs.length - running - failed;
		ui.setStatus("subagents", formatActivityStatus(ui.theme, { running, done, failed }));
	};

	const deliverResult = (snap: SubagentSnapshot) => {
		pi.sendMessage(
			{
				customType: "subagent-result",
				content: buildSubagentResultMessage({
					id: snap.id,
					title: snap.title,
					status: snap.status,
					errorText: snap.errorText,
					output: truncatedOutput(snap),
				}),
				display: true,
				details: { id: snap.id, title: snap.title, status: snap.status },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const flushResults = () => {
		for (const snap of resultDelivery.drain()) deliverResult(snap);
	};

	const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
		// A shutdown can settle children while disposing their scopes. Never
		// append into a session whose extension runtime is already closing.
		if (!sessionContext) return;
		if (consumed) {
			resultDelivery.consume([snap.id]);
			return;
		}
		// Keep the result retractable while the parent is working. A later
		// subagent_wait can consume it before agent_settled flushes follow-ups.
		// Defer a copy: the live snapshot keeps mutating if the subagent is
		// restarted before the deferred result flushes.
		resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
		if (sessionContext?.isIdle()) flushResults();
	};

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		if (ctx.hasUI) ui = ctx.ui;
	});

	pi.on("agent_settled", flushResults);

	pi.on("session_shutdown", async () => {
		sessionContext = undefined;
		resultDelivery.clear();
		unsubStatus?.();
		unsubStatus = undefined;
		ui?.setStatus("subagents", undefined);
		ui = undefined;
		// Retract the shared control-plane handle before the runtime dies so a
		// sibling extension can never drive a disposed manager. No-op without
		// the ownership token: a child's shutdown never clobbers the root's.
		releaseSubagentPlane(planeToken);
		managerSync = undefined;
		const closing = runtime;
		runtime = undefined;
		managerPromise = undefined;
		// Disposing the runtime runs the manager finalizer, which tears down all
		// subagent scopes (and, later, their real child processes).
		await closing?.dispose();
	});

	// --- Tools -------------------------------------------------------------

	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
		promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
		parameters: Type.Object({
			prompt: Type.String({
				description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
			}),
			name: Type.String({
				description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
			}),
			harness: StringEnum(BACKEND_NAMES, {
				description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
			}),
			working_dir: Type.Optional(
				Type.String({
					description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
				}),
			),
			model: Type.Optional(
				Type.String({
					description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
				}),
			),
			allowPaidOpencode: Type.Optional(
				Type.Boolean({
					description: `Per-spawn confirmation for paid OpenCode. Only effective when Jonas already enabled allowPaidOpencode in ${paidOpencodeConfigPath} before this extension loaded.`,
				}),
			),
			mode: Type.Optional(
				StringEnum(SUBAGENT_MODES, {
					description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.mode,
				}),
			),
			reasoning_effort: Type.Optional(
				StringEnum(REASONING_EFFORTS, {
					description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const manager = await getManager();

			const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
				throw new Error(`working_dir is not a directory: ${cwd}`);
			}

			const title = params.name.trim().slice(0, 160) || "subagent";
			const snap = await runTool(
				getRuntime(),
				manager.spawn(
					params.harness,
					{
						prompt: params.prompt,
						title,
						cwd,
						mode: params.mode,
						model: params.model,
						reasoningEffort: params.reasoning_effort,
						parent: {
							parentCwd: ctx.cwd,
							inheritedModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
							inheritedThinkingLevel: pi.getThinkingLevel(),
							modelRegistry: ctx.modelRegistry,
						},
					},
					{
						userAllowsPaidOpencode,
						allowPaidOpencode: params.allowPaidOpencode,
						paidOpencodeConfigPath,
					},
				),
				{ signal, interruptMessage: "Subagent spawn aborted." },
			);

			return {
				content: [
					{
						type: "text",
						text: buildSubagentSpawnResult({
							id: snap.id,
							title: snap.title,
							harness: snap.backend,
							mode: snap.mode,
							modelLabel: snap.meta.modelLabel ?? "?",
							cwd,
						}),
					},
				],
				details: {
					id: snap.id,
					title: snap.title,
					cwd,
					harness: snap.backend,
					mode: snap.mode,
					model: snap.meta.modelLabel,
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagents",
		description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
		parameters: Type.Object({
			ids: Type.Array(Type.String(), {
				maxItems: 64,
				description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const manager = await getManager();
			const ids = [...new Set(params.ids)];
			if (ids.length === 0) throw new Error("Provide at least one subagent id.");
			const known = manager.view.list().map((snap) => snap.id);
			const unknown = ids.filter((id) => !manager.view.get(id));
			if (unknown.length > 0) {
				throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`);
			}

			await runTool(
				getRuntime(),
				manager.waitFor(ids, (pending) => {
					onUpdate?.({
						content: [{ type: "text", text: `Waiting for ${pending.join(", ")}...` }],
						details: { pending },
					});
				}),
				{ signal, interruptMessage: "Wait aborted. Subagents keep running." },
			);

			// Settlement may have happened before this wait began. Remove any
			// deferred automatic delivery now that the tool is returning the result.
			resultDelivery.consume(ids);

			const sections: string[] = [];
			let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
			for (const id of ids) {
				const snap = manager.view.get(id);
				if (!snap) {
					sections.push(`## ${id}\n\n(no longer tracked)`);
					continue;
				}
				const verb = snap.status === "error" ? "failed" : "finished";
				let section = `## ${snap.id} "${snap.title}" ${verb}`;
				if (snap.errorText) section += `\nError: ${snap.errorText}`;
				const headerBytes = Buffer.byteLength(section, "utf8") + 2;
				const outputBudget = Math.max(512, Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes));
				section += `\n\n${truncatedOutput(snap, outputBudget)}`;
				const sectionBytes = Buffer.byteLength(section, "utf8");
				if (sectionBytes > remainingBytes) {
					sections.push(`## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`);
					break;
				}
				sections.push(section);
				remainingBytes -= sectionBytes;
			}

			const combined = sections.join("\n\n---\n\n");
			const bounded = truncateHead(combined, {
				maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
				maxLines: DEFAULT_MAX_LINES,
			});
			const text = bounded.truncated ? `${bounded.content}\n\n[wait output truncated at the total output limit]` : bounded.content;
			return {
				content: [{ type: "text", text }],
				details: {
					results: ids.map((id) => {
						const snap = manager.view.get(id);
						return { id, title: snap?.title, status: snap?.status };
					}),
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel Subagents",
		description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
		parameters: Type.Object({
			ids: Type.Array(Type.String(), {
				description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const manager = await getManager();
			const ids = [...new Set(params.ids)];
			if (ids.length === 0) throw new Error("Provide at least one subagent id.");

			const known = manager.view.list().map((snap) => snap.id);
			const unknown = ids.filter((id) => !manager.view.get(id));
			if (unknown.length > 0) {
				throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`);
			}

			const report = await runTool(getRuntime(), manager.cancel(ids), {
				signal,
				interruptMessage: "Subagent cancellation aborted.",
			});

			const lines = report.map((entry) =>
				entry.cancelled ? `Cancelled ${entry.id} "${entry.title}".` : `${entry.id} "${entry.title}" was already ${entry.status}.`,
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					results: report.map((entry) => ({
						id: entry.id,
						title: entry.title,
						status: entry.status,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Steer Subagent",
		description: SUBAGENT_SEND_TOOL_DESCRIPTION,
		parameters: Type.Object({
			id: Type.String({ description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id }),
			message: Type.String({ description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message }),
		}),
		async execute(_toolCallId, params, signal) {
			const manager = await getManager();
			if (!manager.view.get(params.id)) {
				const known = manager.view.list().map((entry) => entry.id);
				throw new Error(`Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`);
			}
			const message = params.message.trim();
			if (!message) throw new Error("Provide a non-empty message.");
			await runTool(getRuntime(), manager.send(params.id, message), {
				signal,
				interruptMessage: "Subagent steering aborted.",
			});
			resultDelivery.consume([params.id]);
			return {
				content: [{ type: "text", text: `Sent guidance to ${params.id}.` }],
				details: { id: params.id },
			};
		},
	});

	pi.registerTool({
		name: "subagent_check",
		label: "Check Subagent",
		description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
		parameters: Type.Object({
			id: Type.String({
				description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
			}),
		}),
		async execute(_toolCallId, params) {
			const manager = await getManager();
			const snap = manager.view.get(params.id);
			if (!snap) {
				const known = manager.view.list().map((entry) => entry.id);
				throw new Error(`Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`);
			}

			const children = manager.view.list().filter((entry) => entry.parentId === snap.id);
			let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}\nChildren: ${children.map((entry) => entry.id).join(", ") || "none"}`;
			if (snap.errorText) text += `\nError: ${snap.errorText}`;

			const output = latestText(snap);
			if (output) {
				const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
				text += `\n\nLatest output:\n${preview.content}`;
				if (preview.truncated) text += "\n[...]";
			} else if (snap.status === "running") {
				text += "\n\n(no text output yet)";
			}

			return {
				content: [{ type: "text", text }],
				details: {
					id: snap.id,
					parentId: snap.parentId,
					depth: snap.depth,
					mode: snap.mode,
					status: snap.status,
					turns: snap.turns,
					children: children.map((entry) => entry.id),
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List Subagents",
		description: SUBAGENT_LIST_TOOL_DESCRIPTION,
		parameters: Type.Object({}),
		async execute() {
			const manager = await getManager();
			const subs = orderSubagentTree(manager.view.list());
			const text =
				subs.length === 0
					? "No subagents."
					: subs.map((snap) => `${"  ".repeat(Math.min(snap.depth, 8))}${describeSubagent(snap)}`).join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					subagents: subs.map((snap) => ({
						id: snap.id,
						title: snap.title,
						parentId: snap.parentId,
						depth: snap.depth,
						mode: snap.mode,
						harness: snap.backend,
						status: snap.status,
					})),
				},
			};
		},
	});

	// --- Result message rendering ------------------------------------------

	pi.registerMessageRenderer("subagent-result", (message, { expanded }, theme) => {
		const details = (message.details ?? {}) as {
			id?: string;
			title?: string;
			status?: string;
		};
		const failed = details.status === "error";
		const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
		const header =
			`${icon} ` +
			theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
			theme.fg("muted", ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`);

		const content = typeof message.content === "string" ? message.content : "";
		// Remove only the summary line. The following Error line (when present)
		// is part of the actual result and must remain visible.
		const body = content.split("\n").slice(1).join("\n").trim();

		if (expanded) {
			const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
			const container = new Text(header, 0, 0);
			return {
				render: (width: number) => [...container.render(width), ...md.render(width)],
				invalidate: () => {
					container.invalidate();
					md.invalidate();
				},
			};
		}

		const previewLines = body.split("\n").slice(0, 8);
		let text = header;
		for (const line of previewLines) text += `\n${theme.fg("toolOutput", line)}`;
		if (body.split("\n").length > 8) text += `\n${theme.fg("dim", `... (${keyHint("app.tools.expand", "to expand")})`)}`;
		return new Text(text, 0, 0);
	});

	// --- Commands -----------------------------------------------------------

	pi.registerCommand("subagents", {
		description: "List, inspect, and take over subagents",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Subagent takeover is only available in the TUI", "error");
				return;
			}
			const manager = await getManager();
			if (manager.view.size() === 0) {
				ctx.ui.notify("No subagents yet. The agent spawns them with subagent_spawn.", "info");
				return;
			}
			await openSubagentPicker(ctx, manager.view);
		},
	});
}
