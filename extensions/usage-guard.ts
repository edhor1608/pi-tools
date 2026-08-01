import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codexUsageFromResponse, type CodexUsage, type CodexUsageWindow } from "./statusline.ts";
import { setExtensionStatus } from "./shared/status-bus.ts";

const CACHE_MAX_AGE_MS = 120_000;
const MID_TURN_CHECK_INTERVAL_MS = 15_000;
const LATCH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type GuardLevel = "warn" | "wrapup";
type GuardChannel = "directive" | "notification";
export type UsageGuardThresholds = { warnAt: number; wrapupAt: number };
export type UsageGuardLatches = Record<string, number>;
export type UsageGuardDecision = {
	level?: GuardLevel;
	windows: CodexUsageWindow[];
	latches: UsageGuardLatches;
	changed: boolean;
};

type CodexCredential = { access: string; accountId: string };

export function usageGuardThresholds(env: NodeJS.ProcessEnv = process.env): UsageGuardThresholds {
	return {
		warnAt: thresholdValue(env.PI_USAGE_GUARD_WARN_AT, 80),
		wrapupAt: thresholdValue(env.PI_USAGE_GUARD_WRAPUP_AT, 90),
	};
}

export function isCodexUsageCacheFresh(
	usage: Pick<CodexUsage, "fetchedAt"> | undefined,
	now: number,
	maxAgeMs = CACHE_MAX_AGE_MS,
): boolean {
	if (!usage || !Number.isFinite(usage.fetchedAt)) return false;
	const age = now - usage.fetchedAt;
	return age >= 0 && age <= maxAgeMs;
}

export function decideUsageGuard(
	windows: CodexUsageWindow[],
	latches: UsageGuardLatches,
	thresholds: UsageGuardThresholds,
	now: number,
	sessionId: string,
	channel: GuardChannel,
): UsageGuardDecision {
	const cutoff = now - LATCH_MAX_AGE_MS;
	const nextLatches = Object.fromEntries(Object.entries(latches).filter(([, firedAt]) => firedAt > cutoff));
	let changed = Object.keys(nextLatches).length !== Object.keys(latches).length;
	const level = windows.some((window) => window.usedPercent >= thresholds.wrapupAt)
		? "wrapup"
		: windows.some((window) => window.usedPercent >= thresholds.warnAt)
			? "warn"
			: undefined;
	if (!level) return { windows: [], latches: nextLatches, changed };

	const threshold = level === "wrapup" ? thresholds.wrapupAt : thresholds.warnAt;
	const freshWindows: CodexUsageWindow[] = [];
	for (const window of windows.filter((candidate) => candidate.usedPercent >= threshold)) {
		const key = latchKey(sessionId, window, level, channel);
		if (nextLatches[key] !== undefined) continue;
		nextLatches[key] = now;
		freshWindows.push(window);
		changed = true;
	}
	return { level: freshWindows.length > 0 ? level : undefined, windows: freshWindows, latches: nextLatches, changed };
}

export function buildUsageGuardDirective(
	level: GuardLevel,
	crossed: CodexUsageWindow[],
	allWindows: CodexUsageWindow[],
	thresholds: UsageGuardThresholds,
): string {
	const crossedLines = crossed.map(formatWindow).join("\n");
	if (level === "wrapup") {
		const status = allWindows.map((window) => `  ${window.label}: ${window.usedPercent}%`).join("\n");
		return `[usage-guard] CRITICAL: a Codex subscription usage window is nearly exhausted (>= ${thresholds.wrapupAt}% used):
${crossedLines}

All windows:
${status}

Wrap up this run NOW, gracefully:
1. Do NOT start any new tasks, subagents, or workflows. Let already-running background work finish or stop it if long.
2. Bring the current step to a safe state and persist work in progress so nothing is lost.
3. Write a handover report so a future session can resume seamlessly: goal, DONE (and verification), IN PROGRESS (exact state, paths, branches), PLANNED/open work, pitfalls, and the exact next step.
4. Tell the user which limit is nearly exhausted, when it resets, where the handover is, and what to do after reset.
5. Then END the turn. Do not continue working.`;
	}
	return `[usage-guard] Heads-up: Codex subscription usage crossed ${thresholds.warnAt}%:
${crossedLines}

Keep working, but stop expanding scope: avoid new fan-outs or long-running work, finish what is in flight, and persist intermediate results so an abrupt stop loses nothing. At ${thresholds.wrapupAt}% you will be asked to wrap up and write a handover.`;
}

export function shouldCheckUsageMidTurn(lastCheckedAt: number, now: number): boolean {
	return now - lastCheckedAt >= MID_TURN_CHECK_INTERVAL_MS;
}

export default function usageGuardExtension(pi: ExtensionAPI): void {
	let inMemoryUsage: CodexUsage | undefined;
	let lastMidTurnCheckAt = 0;

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (ctx.model?.provider !== "openai-codex") return;
			const now = Date.now();
			const usage = await readOrFetchUsage(now, inMemoryUsage);
			if (!usage) return;
			inMemoryUsage = usage;
			const statePath = usageGuardStatePath();
			const currentLatches = await readLatches(statePath);
			const thresholds = usageGuardThresholds();
			const decision = decideUsageGuard(usage.windows, currentLatches, thresholds, now, ctx.sessionManager.getSessionId(), "directive");
			if (decision.changed) await writeLatches(statePath, decision.latches);
			if (!decision.level) return;

			const directive = buildUsageGuardDirective(decision.level, decision.windows, usage.windows, thresholds);
			publishGuardStatus(decision.level, thresholds);
			return { systemPrompt: `${event.systemPrompt}\n\n${directive}` };
		} catch {
			return;
		}
	});

	pi.on("tool_result", async (_event, ctx) => {
		try {
			if (ctx.model?.provider !== "openai-codex") return;
			const now = Date.now();
			if (!shouldCheckUsageMidTurn(lastMidTurnCheckAt, now)) return;
			lastMidTurnCheckAt = now;
			const usage = await readOrFetchUsage(now, inMemoryUsage);
			if (!usage) return;
			inMemoryUsage = usage;
			const statePath = usageGuardStatePath();
			const currentLatches = await readLatches(statePath);
			const thresholds = usageGuardThresholds();
			const decision = decideUsageGuard(usage.windows, currentLatches, thresholds, now, ctx.sessionManager.getSessionId(), "notification");
			if (decision.changed) await writeLatches(statePath, decision.latches);
			if (!decision.level) return;

			publishGuardStatus(decision.level, thresholds);
			ctx.ui.notify(midTurnNotification(decision.level, decision.windows, thresholds), decision.level === "wrapup" ? "error" : "warning");
		} catch {
			return;
		}
	});
}

function thresholdValue(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

function latchKey(sessionId: string, window: CodexUsageWindow, level: GuardLevel, channel: GuardChannel): string {
	return `${sessionId}|${window.label}|${window.resetAt ?? "unknown"}|${level}|${channel}`;
}

function publishGuardStatus(level: GuardLevel, thresholds: UsageGuardThresholds): void {
	setExtensionStatus(
		"usage-guard",
		level === "wrapup" ? `Codex >=${thresholds.wrapupAt}% — wrap up now` : `Codex >=${thresholds.warnAt}% — stop expanding scope`,
		{ tone: level === "wrapup" ? "error" : "warn", order: 20 },
	);
}

function midTurnNotification(level: GuardLevel, windows: CodexUsageWindow[], thresholds: UsageGuardThresholds): string {
	const usage = windows.map((window) => `${window.label} ${window.usedPercent}%`).join(", ");
	return level === "wrapup"
		? `Codex usage crossed ${thresholds.wrapupAt}% mid-turn (${usage}) — wrap up and persist work now.`
		: `Codex usage crossed ${thresholds.warnAt}% mid-turn (${usage}) — stop expanding scope.`;
}

function formatWindow(window: CodexUsageWindow): string {
	const reset = window.resetAt === undefined ? "reset time unavailable" : `resets ${new Date(window.resetAt).toISOString()}`;
	return `- ${window.label}: ${window.usedPercent}% used, ${reset}`;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function usageGuardStatePath(): string {
	return join(process.env.PI_USAGE_GUARD_STATE_DIR || agentDir(), "usage-guard-state.json");
}

async function readOrFetchUsage(now: number, inMemoryUsage: CodexUsage | undefined): Promise<CodexUsage | undefined> {
	const statuslineUsage = await readStatuslineUsage();
	const cached = [statuslineUsage, inMemoryUsage]
		.filter((usage): usage is CodexUsage => isCodexUsageCacheFresh(usage, now))
		.sort((left, right) => right.fetchedAt - left.fetchedAt)[0];
	if (cached) return cached;
	const credential = await readStoredCodexCredential();
	if (!credential) return undefined;
	const response = await fetch(CODEX_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${credential.access}`,
			"chatgpt-account-id": credential.accountId,
			"User-Agent": "pi-tools-usage-guard",
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return undefined;
	const payload: unknown = await response.json();
	return codexUsageFromResponse(payload, now);
}

async function readStatuslineUsage(): Promise<CodexUsage | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(agentDir(), "pi-statusline-cache.json"), "utf8"));
		if (!isObject(parsed) || !validCodexUsage(parsed.codexUsage)) return undefined;
		return parsed.codexUsage;
	} catch {
		return undefined;
	}
}

async function readStoredCodexCredential(): Promise<CodexCredential | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(agentDir(), "auth.json"), "utf8"));
		if (!isObject(parsed) || !isObject(parsed["openai-codex"])) return undefined;
		const credential = parsed["openai-codex"];
		if (typeof credential.expires === "number" && Date.now() > credential.expires - 60_000) return undefined;
		if (typeof credential.access !== "string") return undefined;
		const accountId = typeof credential.accountId === "string" ? credential.accountId : extractCodexAccountId(credential.access);
		return accountId ? { access: credential.access, accountId } : undefined;
	} catch {
		return undefined;
	}
}

function extractCodexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isObject(payload) || !isObject(payload[JWT_CLAIM_PATH])) return undefined;
		const accountId = payload[JWT_CLAIM_PATH].chatgpt_account_id;
		return typeof accountId === "string" ? accountId : undefined;
	} catch {
		return undefined;
	}
}

async function readLatches(path: string): Promise<UsageGuardLatches> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isObject(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
		);
	} catch {
		return {};
	}
}

async function writeLatches(path: string, latches: UsageGuardLatches): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, JSON.stringify(latches), "utf8");
	await rename(temporaryPath, path);
}

function validCodexUsage(value: unknown): value is CodexUsage {
	return (
		isObject(value) &&
		Array.isArray(value.windows) &&
		value.windows.length > 0 &&
		value.windows.every(validCodexUsageWindow) &&
		typeof value.fetchedAt === "number"
	);
}

function validCodexUsageWindow(value: unknown): value is CodexUsageWindow {
	return (
		isObject(value) &&
		typeof value.label === "string" &&
		typeof value.usedPercent === "number" &&
		(value.resetAt === undefined || typeof value.resetAt === "number") &&
		(value.windowSeconds === undefined || typeof value.windowSeconds === "number")
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
