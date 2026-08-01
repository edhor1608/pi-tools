/**
 * Review-loop extension entry — the IO shell around the pure FSM in fsm.ts.
 *
 * Surfaces:
 * - `/review-loop on|off|status|now` (user control; `now` forces a round when
 *   the entry gate is green, and is the explicit way out of "blocked").
 * - `review_loop` tool (same controls for the agent — the hybrid automatic
 *   mode is agent-toggleable by design; `owner_subagent_id` records the
 *   fix-owner lineage when the reviewed work came from a tracked subagent).
 * - Footer status via the shared status bus (`setExtensionStatus`); the
 *   statusline extension is the only footer compositor.
 *
 * Event wiring (see pi-coding-agent dist types, core/extensions/types.d.ts):
 * - `agent_settled` — "an agent run has fully settled and no automatic retry,
 *   compaction, or queued continuation will run": the natural "work maybe
 *   settled" trigger for the entry gate, and the completion signal for a
 *   root-owned fix turn (subagent-owned fixes settle via the plane's waitFor).
 * - `session_start` / `session_tree` — reconstruct persisted state, then feed
 *   the FSM a `resumed` event so every active phase reconciles into a durable
 *   pending action (pending review -> gate check, fixing -> re-dispatched
 *   fix, verifying -> re-run verification).
 * - `session_before_switch` / `session_shutdown` — cancel in-flight
 *   reviewers, bump the async generation, reset runtime state.
 *
 * Staleness: FSM (epoch, opId) matching kills cross-cycle races; the
 * `generation` token here additionally invalidates async continuations
 * across session switches, where a restored state legitimately carries the
 * same persisted epoch.
 *
 * Only read-only git commands are ever executed for fingerprints; this mode
 * has no code path that could push, merge, or land work. The optional verify
 * command from `.pi/review-loop.json` runs exactly as configured by the user.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearExtensionStatus, setExtensionStatus } from "../shared/status-bus.ts";
import {
	DEFAULT_CONFIG,
	type Finding,
	type FixOwner,
	initialState,
	isModeOn,
	type ReviewLoopConfig,
	type ReviewLoopEffect,
	type ReviewLoopEvent,
	type ReviewLoopState,
	transition,
} from "./fsm.ts";
import { readReviewLoopStateFromEntries, REVIEW_LOOP_ENTRY_TYPE, serializeReviewLoopState } from "./persistence.ts";
import { buildReviewPrompt, DEFAULT_NON_CLAUDE_REVIEWER_MODEL, parseReviewOutcome, pickReviewerRouting } from "./review-contract.ts";
import { createSubagentReviewerBackend, getSubagentPlane, type ReviewerBackend } from "./reviewer.ts";

const execFileAsync = promisify(execFile);
const STATUS_ID = "review-loop";
const STABILITY_WINDOW_MS = 500;
const CONFIG_FILE_RELATIVE_PATH = ".pi/review-loop.json";
const VERIFY_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIONS = ["on", "off", "status", "now"] as const;
type Action = (typeof ACTIONS)[number];

// --- Settings ---------------------------------------------------------------

interface ReviewLoopSettings {
	fsm: ReviewLoopConfig;
	/** Optional verification command ([cmd, ...args]); exit 0 = verified. */
	verifyCommand?: string[];
	/** Explicit diverse reviewer for Claude-authored work (finding: inheritance would re-route). */
	nonClaudeReviewerModel: string;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Project-local settings, merged over defaults (pattern: structured-compaction/config.ts). */
function loadSettings(cwd: string): ReviewLoopSettings {
	const settings: ReviewLoopSettings = {
		fsm: { ...DEFAULT_CONFIG },
		nonClaudeReviewerModel: DEFAULT_NON_CLAUDE_REVIEWER_MODEL,
	};
	try {
		const raw: unknown = JSON.parse(readFileSync(join(cwd, CONFIG_FILE_RELATIVE_PATH), "utf8"));
		if (typeof raw !== "object" || raw === null) return settings;
		const record = raw as Record<string, unknown>;
		if (typeof record.maxRounds === "number" && record.maxRounds > 0) settings.fsm.maxRounds = record.maxRounds;
		if (typeof record.maxInvalidRetries === "number" && record.maxInvalidRetries >= 0) {
			settings.fsm.maxInvalidRetries = record.maxInvalidRetries;
		}
		if (typeof record.maxFixAttempts === "number" && record.maxFixAttempts >= 0) settings.fsm.maxFixAttempts = record.maxFixAttempts;
		if (isStringArray(record.verifyCommand) && record.verifyCommand.length > 0) settings.verifyCommand = record.verifyCommand;
		if (typeof record.nonClaudeReviewerModel === "string" && record.nonClaudeReviewerModel.trim()) {
			settings.nonClaudeReviewerModel = record.nonClaudeReviewerModel.trim();
		}
	} catch {
		// Missing or malformed config falls back to defaults.
	}
	return settings;
}

// --- Git fingerprint --------------------------------------------------------

type FingerprintResult = { ok: true; fingerprint: string } | { ok: false; reason: string };

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

/**
 * Caps: untracked files are content-hashed up to 1 MiB each (larger files
 * contribute path+size, which still detects create/delete/grow) and up to
 * 1000 files (beyond that, the overflow count is hashed so the fingerprint
 * still changes when more files appear). These bounds keep the gate cheap on
 * pathological trees without letting changes become invisible.
 */
const UNTRACKED_CONTENT_CAP_BYTES = 1024 * 1024;
const UNTRACKED_FILE_CAP = 1000;

/**
 * Stable identity of the review target: HEAD sha plus a hash of the working
 * tree (porcelain status, staged+unstaged diff, and untracked file CONTENT —
 * `git diff` alone cannot see edits inside untracked files). A non-git
 * directory or a failing git invocation is an ERROR state that the caller
 * turns into visible "blocked", never a stable constant that could pass the
 * entry gate.
 */
async function computeGitFingerprint(cwd: string): Promise<FingerprintResult> {
	try {
		await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	} catch (error) {
		return { ok: false, reason: `not a git repository: ${cwd} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
	}
	try {
		// An unborn HEAD (fresh repo) is a legitimate reviewable state.
		const head = (await git(cwd, ["rev-parse", "HEAD"]).catch(() => "NO_HEAD")).trim();
		const status = await git(cwd, ["status", "--porcelain"]);
		const diff = await git(cwd, ["diff", "HEAD"]).catch(() => git(cwd, ["diff"]));
		// NUL separators are the escape sequence backslash-u0000 on purpose — never put
		// a literal NUL byte into this source file (it breaks tooling).
		const hash = createHash("sha256").update(status).update("\u0000").update(diff);
		const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\u0000").filter(Boolean).sort();
		for (const path of untracked.slice(0, UNTRACKED_FILE_CAP)) {
			hash.update("\u0000").update(path).update("\u0000");
			try {
				const info = await stat(join(cwd, path));
				if (info.size <= UNTRACKED_CONTENT_CAP_BYTES) {
					hash.update(await readFile(join(cwd, path)));
				} else {
					hash.update(`oversize:${info.size}`);
				}
			} catch {
				// Raced deletion/unreadable: still influences the fingerprint.
				hash.update("unreadable");
			}
		}
		if (untracked.length > UNTRACKED_FILE_CAP) hash.update(`overflow:${untracked.length}`);
		return { ok: true, fingerprint: `${head.slice(0, 12)}+${hash.digest("hex").slice(0, 16)}` };
	} catch (error) {
		return { ok: false, reason: `git fingerprint failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
	}
}

// --- Presentation -----------------------------------------------------------

function describeState(state: ReviewLoopState, settings: ReviewLoopSettings): string {
	const verifyMode = settings.verifyCommand ? `cmd: ${settings.verifyCommand.join(" ")}` : "fingerprint-only";
	switch (state.phase) {
		case "idle":
			return "review-loop off";
		case "armed":
			return "review-loop armed (waiting for stable work)";
		case "reviewing":
		case "re-reviewing":
			return `review-loop r${state.round}/${settings.fsm.maxRounds} ${state.phase}${state.reviewInFlight ? "" : " (pending)"}${
				state.reviewer?.model ? ` · ${state.reviewer.model}` : ""
			}`;
		case "triage":
			return `review-loop r${state.round}/${settings.fsm.maxRounds} triage · ${state.findings.length} finding(s)`;
		case "fixing":
			return `review-loop r${state.round}/${settings.fsm.maxRounds} fixing · ${state.findings.length} finding(s) · owner: ${
				state.owner.kind === "root" ? "root session" : `subagent ${state.owner.id}`
			}`;
		case "verifying":
			return `review-loop r${state.round}/${settings.fsm.maxRounds} verifying fix (verify: ${verifyMode})`;
		case "clean":
			return `review-loop clean after ${state.round} round(s)`;
		case "blocked":
			return `review-loop BLOCKED: ${state.blockedReason ?? "unknown"}`;
		case "hard-stop":
			return `review-loop HARD STOP: ${state.hardStopReason ?? "unknown"}`;
	}
}

function buildFixInstruction(findings: Finding[], round: number): string {
	const lines = [
		`Review-loop round ${round}: the independent reviewer returned ${findings.length} accepted finding(s).`,
		"Fix ALL of them now, then stop. Do not expand scope, do not commit/push/merge anything new beyond the fixes.",
		"",
	];
	for (const finding of findings) {
		lines.push(`- [${finding.severity}] ${finding.title}${finding.detail ? ` — ${finding.detail}` : ""}`);
	}
	lines.push("", "When done, simply end your turn; the review loop verifies and re-reviews automatically.");
	return lines.join("\n");
}

// --- Extension --------------------------------------------------------------

export default function reviewLoopExtension(pi: ExtensionAPI) {
	let settings: ReviewLoopSettings = { fsm: { ...DEFAULT_CONFIG }, nonClaudeReviewerModel: DEFAULT_NON_CLAUDE_REVIEWER_MODEL };
	let state = initialState();
	let sessionContext: ExtensionContext | undefined;
	let reviewerBackend: ReviewerBackend | undefined;
	let gateCheckRunning = false;
	/** Bumped on session switch/tree/shutdown: invalidates ALL in-flight async. */
	let generation = 0;

	const getReviewerBackend = () =>
		(reviewerBackend ??= createSubagentReviewerBackend(() => ({
			parentCwd: sessionContext?.cwd ?? process.cwd(),
			inheritedModel: sessionContext?.model ? { provider: sessionContext.model.provider, id: sessionContext.model.id } : undefined,
			inheritedThinkingLevel: pi.getThinkingLevel(),
			modelRegistry: sessionContext?.modelRegistry,
		})));

	const publishStatus = () => {
		if (!isModeOn(state)) {
			clearExtensionStatus(STATUS_ID);
			return;
		}
		const tone = state.phase === "blocked" || state.phase === "hard-stop" ? "error" : state.phase === "clean" ? "info" : "warn";
		setExtensionStatus(STATUS_ID, describeState(state, settings), { tone, order: 20 });
	};

	const persist = () => {
		pi.appendEntry(REVIEW_LOOP_ENTRY_TYPE, serializeReviewLoopState(state));
	};

	/** Apply one FSM event: transition, persist, publish, run effects. */
	const apply = (event: ReviewLoopEvent) => {
		const result = transition(state, event, settings.fsm);
		const changed = result.state !== state;
		state = result.state;
		if (changed) {
			persist();
			publishStatus();
		}
		for (const effect of result.effects) runEffect(effect);
	};

	const runEffect = (effect: ReviewLoopEffect) => {
		switch (effect.type) {
			case "check-gate":
				void runGateCheck(false);
				return;
			case "dispatch-review":
				void runReview(effect);
				return;
			case "dispatch-triage":
				// v1 triage policy: every reviewer finding is accepted. The FSM
				// supports partial acceptance for a later interactive triage surface.
				apply({ type: "findings-accepted", accepted: effect.findings });
				return;
			case "dispatch-fix":
				runFixDispatch(effect);
				return;
			case "dispatch-verify":
				void runVerify(effect);
				return;
		}
	};

	/**
	 * Entry gate: the target is stable when two fingerprints computed
	 * STABILITY_WINDOW_MS apart agree while the agent is idle. Fingerprint
	 * errors (non-git dir, failing git) block VISIBLY instead of gating on a
	 * constant.
	 */
	const runGateCheck = async (forced: boolean) => {
		const ctx = sessionContext;
		if (!ctx || gateCheckRunning || !isModeOn(state)) return;
		gateCheckRunning = true;
		const gen = generation;
		const epoch = state.epoch;
		try {
			const first = await computeGitFingerprint(ctx.cwd);
			if (generation !== gen) return;
			if (!first.ok) {
				apply({ type: "backend-failure", epoch, reason: first.reason });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, STABILITY_WINDOW_MS));
			const second = await computeGitFingerprint(ctx.cwd);
			if (generation !== gen) return;
			if (!second.ok) {
				apply({ type: "backend-failure", epoch, reason: second.reason });
				return;
			}
			const stable = first.fingerprint === second.fingerprint && ctx.isIdle();
			apply({ type: "work-settled", epoch, fingerprint: second.fingerprint, stable, forced });
		} finally {
			gateCheckRunning = false;
		}
	};

	const runReview = async (effect: Extract<ReviewLoopEffect, { type: "dispatch-review" }>) => {
		const ctx = sessionContext;
		if (!ctx) return;
		const gen = generation;
		const routing = pickReviewerRouting({
			workProducerModelId: ctx.model?.id,
			preferDifferentFamily: true,
			nonClaudeModel: settings.nonClaudeReviewerModel,
		});
		const result = await getReviewerBackend().runReview({
			prompt: buildReviewPrompt({ fingerprint: effect.fingerprint, round: effect.round, kind: effect.kind }),
			title: `review-loop r${effect.round} (${effect.kind})`,
			cwd: ctx.cwd,
			backend: routing.backend,
			model: routing.model,
		});
		if (generation !== gen || result.cancelled) return;
		const reviewer = { backend: routing.backend, model: result.modelLabel ?? routing.model, subagentId: result.subagentId };
		if (!result.ok) {
			// Backend failure blocks VISIBLY. Never fall back to another provider.
			apply({
				type: "backend-failure",
				epoch: effect.epoch,
				opId: effect.opId,
				reason: `reviewer backend failed: ${result.error ?? "unknown"}`,
			});
			return;
		}
		const outcome = parseReviewOutcome(result.raw, effect.fingerprint);
		const current = await computeGitFingerprint(ctx.cwd);
		if (generation !== gen) return;
		if (!current.ok) {
			apply({ type: "backend-failure", epoch: effect.epoch, opId: effect.opId, reason: current.reason });
			return;
		}
		apply({
			type: "review-completed",
			epoch: effect.epoch,
			opId: effect.opId,
			outcome,
			currentFingerprint: current.fingerprint,
			reviewer,
		});
	};

	/**
	 * Fix batches go to the OWNING lineage (ADR: same-worker fix lineage):
	 * root-authored work -> a follow-up turn in this session; subagent-owned
	 * work -> `send` through the live subagent plane, awaited via `waitFor`.
	 * An unresolvable owner blocks visibly — never silently substituted.
	 */
	const runFixDispatch = (effect: Extract<ReviewLoopEffect, { type: "dispatch-fix" }>) => {
		const instruction = buildFixInstruction(effect.findings, effect.round);
		if (effect.owner.kind === "root") {
			// Completion arrives via agent_settled while phase === "fixing".
			pi.sendMessage(
				{ customType: "review-loop-fix-request", content: instruction, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		void runSubagentFix(effect, effect.owner.id, instruction);
	};

	const runSubagentFix = async (effect: Extract<ReviewLoopEffect, { type: "dispatch-fix" }>, ownerId: string, instruction: string) => {
		const gen = generation;
		const plane = getSubagentPlane();
		if (!plane || !plane.get(ownerId)) {
			apply({
				type: "backend-failure",
				epoch: effect.epoch,
				opId: effect.opId,
				reason: `fix owner subagent ${ownerId} is unavailable — cannot route the fix batch to its lineage`,
			});
			return;
		}
		try {
			await plane.send(ownerId, instruction);
			await plane.waitFor([ownerId]);
			if (generation !== gen) return;
			apply({ type: "fix-completed", epoch: effect.epoch, opId: effect.opId });
		} catch (error) {
			if (generation !== gen) return;
			apply({
				type: "backend-failure",
				epoch: effect.epoch,
				opId: effect.opId,
				reason: `fix dispatch to subagent ${ownerId} failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	};

	/**
	 * Verification gate: the fix must have CHANGED the reviewed tree
	 * (fingerprint moved) AND, when `.pi/review-loop.json` configures a
	 * `verifyCommand`, that command must exit 0. Without a configured
	 * command the status surface says "verify: fingerprint-only".
	 */
	const runVerify = async (effect: Extract<ReviewLoopEffect, { type: "dispatch-verify" }>) => {
		const ctx = sessionContext;
		if (!ctx) return;
		const gen = generation;
		const current = await computeGitFingerprint(ctx.cwd);
		if (generation !== gen) return;
		if (!current.ok) {
			apply({ type: "backend-failure", epoch: effect.epoch, opId: effect.opId, reason: current.reason });
			return;
		}
		if (current.fingerprint === effect.reviewedFingerprint) {
			apply({ type: "verify-failed", epoch: effect.epoch, opId: effect.opId, reason: "working tree unchanged after fix turn" });
			return;
		}
		const [command, ...args] = settings.verifyCommand ?? [];
		if (command) {
			try {
				await execFileAsync(command, args, { cwd: ctx.cwd, maxBuffer: 32 * 1024 * 1024, timeout: VERIFY_COMMAND_TIMEOUT_MS });
			} catch (error) {
				if (generation !== gen) return;
				apply({
					type: "verify-failed",
					epoch: effect.epoch,
					opId: effect.opId,
					reason: `verification command failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
				});
				return;
			}
			if (generation !== gen) return;
		}
		apply({ type: "verify-passed", epoch: effect.epoch, opId: effect.opId, fingerprint: current.fingerprint });
	};

	const teardownInFlight = () => {
		generation += 1;
		void reviewerBackend?.cancelActive();
	};

	const handleAction = (action: Action, by: "user" | "agent", owner?: FixOwner): string => {
		switch (action) {
			case "on":
				apply({ type: "mode-on", by, owner });
				return "Review loop enabled. It reviews automatically once work settles.";
			case "off":
				teardownInFlight();
				apply({ type: "mode-off", by });
				return "Review loop disabled; in-flight reviewers cancelled.";
			case "now":
				if (!isModeOn(state)) apply({ type: "mode-on", by, owner });
				void runGateCheck(true);
				return "Gate check triggered; a review starts if the target is stable.";
			case "status":
				return describeState(state, settings);
		}
	};

	// --- Surfaces -----------------------------------------------------------

	pi.registerCommand("review-loop", {
		description: "Automatic review-fix loop (usage: /review-loop on|off|status|now)",
		handler: async (args, ctx) => {
			const action = ACTIONS.find((candidate) => candidate === args.trim());
			if (!action) {
				ctx.ui.notify("Usage: /review-loop on|off|status|now", "warning");
				return;
			}
			ctx.ui.notify(handleAction(action, "user"), "info");
		},
	});

	pi.registerTool({
		name: "review_loop",
		label: "Review Loop",
		description:
			"Control the automatic review-fix loop. `on` arms it (a fresh independent reviewer runs once work settles; accepted findings force fix -> verify -> re-review until clean or hard stop). `now` forces a round when the target is stable and retries out of a blocked state. `status` reports phase/round/reviewer/blocked reason. Pass owner_subagent_id with on/now when the reviewed work was produced by a tracked subagent, so the fix batch is routed to that lineage. The loop never merges or lands work.",
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "on | off | status | now" }),
			owner_subagent_id: Type.Optional(
				Type.String({ description: "Subagent id that produced the work under review; fixes are sent to it instead of this session." }),
			),
		}),
		async execute(_toolCallId, params) {
			const owner: FixOwner | undefined = params.owner_subagent_id ? { kind: "subagent", id: params.owner_subagent_id } : undefined;
			const message = handleAction(params.action, "agent", owner);
			return {
				content: [{ type: "text", text: `${message}\n${describeState(state, settings)}` }],
				details: { phase: state.phase, round: state.round, blockedReason: state.blockedReason },
			};
		},
	});

	// --- Lifecycle ----------------------------------------------------------

	const reconstruct = (ctx: ExtensionContext) => {
		sessionContext = ctx;
		settings = loadSettings(ctx.cwd);
		state = readReviewLoopStateFromEntries(ctx.sessionManager.getBranch());
		publishStatus();
		// Reconcile restored active phases into pending actions (fresh op ids).
		apply({ type: "resumed" });
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		teardownInFlight();
		reconstruct(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionContext = ctx;
		if (!isModeOn(state)) return;
		if (state.phase === "fixing") {
			// A root-owned fix turn has fully settled. Subagent-owned fixes
			// complete through the plane's waitFor instead.
			if (state.owner.kind === "root" && state.activeOp?.kind === "fix") {
				apply({ type: "fix-completed", epoch: state.epoch, opId: state.activeOp.id });
			}
			return;
		}
		await runGateCheck(false);
	});

	pi.on("session_before_switch", async () => {
		teardownInFlight();
		state = initialState();
		clearExtensionStatus(STATUS_ID);
	});

	pi.on("session_shutdown", async () => {
		teardownInFlight();
		sessionContext = undefined;
		state = initialState();
		clearExtensionStatus(STATUS_ID);
		const closing = reviewerBackend;
		reviewerBackend = undefined;
		await closing?.dispose();
	});
}
