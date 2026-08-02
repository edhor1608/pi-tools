import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getExtensionStatuses, onStatusChange, type ExtensionStatus } from "./shared/status-bus.ts";

const rawAgentDir = process.env.PI_CODING_AGENT_DIR;
const PI_AGENT_DIR = rawAgentDir != null && rawAgentDir !== "" ? rawAgentDir : join(homedir(), ".pi", "agent");
const CACHE_PATH = join(PI_AGENT_DIR, "pi-statusline-cache.json");
const AUTH_PATH = join(PI_AGENT_DIR, "auth.json");
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const CODEX_USAGE_TTL_MS = 60_000;
const LOCATION_TTL_MS = 2_000;
const LIMIT_HEADER_TTL_MS = 6 * 60 * 60 * 1000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_ACCOUNT_ID_HEADER = "chatgpt-account-id";

type LimitBucket = {
	name: string;
	limit: number;
	remaining: number;
	resetAt?: number;
	observedAt: number;
};

export type CodexUsageWindow = {
	label: string;
	usedPercent: number;
	resetAt?: number;
	windowSeconds?: number;
};

export type CodexUsage = {
	windows: CodexUsageWindow[];
	planType?: string;
	creditsAvailable?: number;
	fetchedAt: number;
};

type Cache = {
	limits?: LimitBucket[];
	codexUsage?: CodexUsage;
	lastError?: string;
};

export type RenderTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type PiContext = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

let enabled = true;
let cache: Cache = readCache();
let requestRender: (() => void) | undefined;
let usageRefresh: Promise<void> | undefined;
let locationCache: { cwd: string; dir: string; dirty: boolean; checkedAt: number; refresh?: Promise<void> } | undefined;
let totalsCache: { input: number; output: number; cost: number } = { input: 0, output: 0, cost: 0 };

export default function statuslineExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		updateTotals(ctx);
		if (enabled) installFooter(ctx);
		void refreshCodexUsage(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (enabled) installFooter(ctx);
		void refreshCodexUsage(ctx, true);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (enabled) installFooter(ctx);
	});

	pi.on("message_end", (_event, ctx) => {
		updateTotals(ctx);
		requestRender?.();
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider === "openai-codex") {
			const limits = limitsFromHeaders(event.headers, Date.now());
			if (limits.length > 0) {
				cache = { ...cache, limits };
				delete cache.lastError;
				writeCache(cache);
			}
		}
		void refreshCodexUsage(ctx);
		requestRender?.();
	});

	pi.registerCommand("pi-statusline", {
		description: "Toggle or inspect the Claude-style Pi footer",
		handler: async (args, ctx) => {
			if (args.trim() === "debug") {
				await refreshCodexUsage(ctx, true);
				ctx.ui.notify(renderDebug(), cache.lastError !== undefined ? "warning" : "info");
				return;
			}
			enabled = !enabled;
			if (enabled) {
				installFooter(ctx);
				void refreshCodexUsage(ctx, true);
				ctx.ui.notify("Pi statusline enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Pi statusline disabled", "info");
			}
		},
	});
}

function installFooter(ctx: PiContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		requestRender = () => tui.requestRender();
		const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
		const unsubscribeStatus = onStatusChange(() => requestRender?.());
		return {
			dispose: () => {
				if (requestRender) requestRender = undefined;
				unsubscribeBranch();
				unsubscribeStatus();
			},
			invalidate() {},
			render(width: number): string[] {
				const parts = [
					renderLocation(ctx, theme, footerData.getGitBranch()),
					renderContext(ctx, theme),
					renderTotals(ctx, theme),
					renderModel(ctx, theme),
					renderLimits(theme, ctx),
				].filter((part) => part.length > 0);
				const firstLine = truncateToWidth(parts.join(theme.fg("dim", "  │  ")), width);
				return composeFooterLines(firstLine, theme, width, getExtensionStatuses(), footerData.getExtensionStatuses());
			},
		};
	});
}

export function composeFooterLines(
	firstLine: string,
	theme: RenderTheme,
	width: number,
	statuses: readonly ExtensionStatus[],
	nativeStatuses: ReadonlyMap<string, string> = new Map(),
): string[] {
	const busIds = new Set(statuses.map(({ id }) => id));
	const segments = [...statuses]
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
		.map(({ text, tone }) => theme.fg(toneColor(tone), sanitizeStatusText(text)));
	for (const [id, text] of [...nativeStatuses].sort(([a], [b]) => a.localeCompare(b))) {
		if (!busIds.has(id)) segments.push(sanitizeStatusText(text));
	}
	if (segments.length === 0) return [firstLine];
	return [firstLine, truncateToWidth(segments.join(theme.fg("dim", " | ")), width)];
}

function toneColor(tone: ExtensionStatus["tone"]): string {
	if (tone === "warn") return "warning";
	if (tone === "error") return "error";
	return "dim";
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function renderLocation(ctx: PiContext, theme: RenderTheme, branch: string | null): string {
	void refreshLocation(ctx.cwd);
	const location = locationCache?.cwd === ctx.cwd ? locationCache : undefined;
	const dir = location?.dir ?? basename(ctx.cwd);
	const git = branch !== null ? `  ${branch}${location?.dirty === true ? " *" : ""}` : "";
	return `${theme.fg("accent", dir)}${theme.fg("dim", git)}`;
}

function renderContext(ctx: PiContext, theme: RenderTheme): string {
	const usage = ctx.getContextUsage();
	const max = ctx.model?.contextWindow ?? 0;
	const used = usage?.tokens ?? 0;
	if (!max || !used) return "";
	const pct = Math.min(100, Math.round((used / max) * 100));
	return `${contextBar(used, max)} ${contextColor(theme, pct, fmtTokens(used))}${theme.fg("dim", `/${fmtTokens(max)}`)}`;
}

function renderTotals(_ctx: PiContext, theme: RenderTheme): string {
	if (!totalsCache.input && !totalsCache.output && !totalsCache.cost) return "";
	return theme.fg("dim", `↑${fmtTokens(totalsCache.input)} ↓${fmtTokens(totalsCache.output)} $${totalsCache.cost.toFixed(3)}`);
}

function updateTotals(ctx: PiContext): void {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}
	totalsCache = { input, output, cost };
}

function renderModel(ctx: PiContext, theme: RenderTheme): string {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
	const thinking = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? `:${ctx.thinkingLevel}` : "";
	return theme.fg("dim", `${model}${thinking}`);
}

function renderLimits(theme: RenderTheme, ctx?: PiContext): string {
	if (ctx && ctx.model?.provider !== "openai-codex") return "";
	const usage = freshCodexUsage();
	if (usage) return renderCodexUsage(theme, usage);

	const bucket = freshestLimit(cache.limits ?? []);
	if (!bucket) {
		return cache.lastError !== undefined ? theme.fg("warning", "Codex limits unavailable") : theme.fg("dim", "Codex limits: loading");
	}

	const now = Date.now();
	const usedPct = Math.max(0, Math.min(100, Math.round(((bucket.limit - bucket.remaining) / bucket.limit) * 100)));
	const label = bucket.name === "tokens" ? "tok" : "req";
	const stale = now - bucket.observedAt > LIMIT_HEADER_TTL_MS;
	const reset = bucket.resetAt !== undefined ? ` ↻${formatTime(bucket.resetAt)}` : "";
	const warning = usedPct >= 90 ? "warning" : usedPct >= 75 ? "accent" : "success";
	const suffix = stale ? " stale" : reset;
	return `${theme.fg("dim", `Codex ${label}`)} ${limitBar(usedPct)} ${theme.fg(warning, `${usedPct}%`)}${theme.fg("dim", suffix)}`;
}

function renderCodexUsage(theme: RenderTheme, usage: CodexUsage): string {
	const plan = usage.planType !== undefined ? ` ${usage.planType}` : "";
	const credits = usage.creditsAvailable !== undefined && usage.creditsAvailable > 0 ? ` +${usage.creditsAvailable} reset` : "";
	const windows = usage.windows.map((window) => renderCodexUsageWindow(theme, window)).join(theme.fg("dim", " · "));
	return `${theme.fg("dim", `Codex${plan}`)} ${windows}${theme.fg("dim", credits)}`;
}

function renderCodexUsageWindow(theme: RenderTheme, window: CodexUsageWindow): string {
	const warning = window.usedPercent >= 90 ? "warning" : window.usedPercent >= 75 ? "accent" : "success";
	const reset = window.resetAt !== undefined ? ` ↻${formatTime(window.resetAt)}` : "";
	return `${theme.fg("dim", window.label)} ${limitBar(window.usedPercent)} ${theme.fg(warning, `${window.usedPercent}%`)}${theme.fg("dim", reset)}`;
}

async function refreshCodexUsage(ctx: PiContext, force = false): Promise<void> {
	if (ctx.model?.provider !== "openai-codex") return;
	if (!force && freshCodexUsage()) return;
	if (usageRefresh && !force) return usageRefresh;
	usageRefresh = doRefreshCodexUsage(ctx)
		.catch((error: unknown) => {
			cache = { ...cache, lastError: shortError(error) };
			writeCache(cache);
		})
		.finally(() => {
			usageRefresh = undefined;
			requestRender?.();
		});
	return usageRefresh;
}

async function doRefreshCodexUsage(ctx: PiContext): Promise<void> {
	if (!ctx.model) return;
	const credentials = [await resolveModelCodexCredential(ctx), readStoredCodexCredential()].filter(
		(credential): credential is { access: string; accountId: string } => Boolean(credential),
	);
	if (credentials.length === 0) throw new Error("OpenAI Codex auth unavailable");

	let lastError: unknown;
	for (const credential of credentials) {
		try {
			const payload = await fetchCodexUsageWithPython(credential);
			const usage = codexUsageFromResponse(payload, Date.now());
			if (!usage) throw new Error("Codex usage response did not include a primary rate-limit window");
			cache = { ...cache, codexUsage: usage };
			delete cache.lastError;
			writeCache(cache);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchCodexUsageWithPython(credential: { access: string; accountId: string }): Promise<unknown> {
	const script = String.raw`
import json, sys, urllib.error, urllib.request
payload = json.load(sys.stdin)
request = urllib.request.Request(
    payload["url"],
    headers={
        "Authorization": "Bearer " + payload["access"],
        "chatgpt-account-id": payload["accountId"],
        "User-Agent": "pi-tools-statusline",
        "Accept": "application/json",
    },
)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        sys.stdout.write(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    raise SystemExit(f"HTTP {error.code}")
`;
	const input = JSON.stringify({ url: CODEX_USAGE_URL, ...credential });
	const output = await runPython(script, input);
	return JSON.parse(output) as unknown;
}

async function runPython(script: string, input: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr.trim() || `python3 exited with ${code ?? "unknown status"}`));
		});
		child.stdin.end(input);
	});
}

export function codexUsageFromResponse(payload: unknown, now: number): CodexUsage | undefined {
	if (!isObject(payload)) return undefined;
	const rateLimit = payload.rate_limit;
	if (!isObject(rateLimit)) return undefined;
	const windows = [windowFromResponse(rateLimit.secondary_window), windowFromResponse(rateLimit.primary_window)].filter(
		(window): window is CodexUsageWindow => Boolean(window),
	);
	if (windows.length === 0) return undefined;
	const credits = isObject(payload.rate_limit_reset_credits)
		? (numberValue(payload.rate_limit_reset_credits.applicable_available_count) ??
			numberValue(payload.rate_limit_reset_credits.available_count))
		: undefined;
	const planType = typeof payload.plan_type === "string" ? payload.plan_type : undefined;
	return {
		windows: windows.sort((a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER)),
		...(planType !== undefined ? { planType } : {}),
		...(credits !== undefined ? { creditsAvailable: credits } : {}),
		fetchedAt: now,
	};
}

function windowFromResponse(value: unknown): CodexUsageWindow | undefined {
	if (!isObject(value)) return undefined;
	const usedPercent = numberValue(value.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowSeconds = numberValue(value.limit_window_seconds);
	const resetAtSeconds = numberValue(value.reset_at);
	return {
		label: codexWindowLabel(windowSeconds),
		usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))),
		...(resetAtSeconds !== undefined && resetAtSeconds !== 0 ? { resetAt: resetAtSeconds * 1000 } : {}),
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
	};
}

function codexWindowLabel(windowSeconds: number | undefined): string {
	if (windowSeconds === undefined) return "limit";
	if (windowSeconds <= 5 * 60 * 60) return "5h";
	if (windowSeconds <= 24 * 60 * 60) return "24h";
	if (windowSeconds <= 7 * 24 * 60 * 60) return "7d";
	return `${Math.round(windowSeconds / (24 * 60 * 60))}d`;
}

function limitsFromHeaders(headers: Record<string, string | string[] | undefined>, now: number): LimitBucket[] {
	const get = (name: string): string | undefined => {
		const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
		const value = entry?.[1];
		return Array.isArray(value) ? value[0] : value;
	};
	const buckets: LimitBucket[] = [];
	for (const name of ["requests", "tokens"] as const) {
		const limit = parseNumber(get(`x-ratelimit-limit-${name}`));
		const remaining = parseNumber(get(`x-ratelimit-remaining-${name}`));
		if (limit === undefined || limit === 0 || remaining === undefined) continue;
		const resetAt = parseReset(get(`x-ratelimit-reset-${name}`), now);
		buckets.push({
			name,
			limit,
			remaining,
			...(resetAt !== undefined ? { resetAt } : {}),
			observedAt: now,
		});
	}
	return buckets;
}

function freshestLimit(limits: LimitBucket[]): LimitBucket | undefined {
	const fresh = limits.filter((limit) => Date.now() - limit.observedAt <= LIMIT_HEADER_TTL_MS);
	const usable = fresh.length > 0 ? fresh : limits;
	return [...usable].sort((a, b) => utilization(b) - utilization(a))[0];
}

function freshCodexUsage(): CodexUsage | undefined {
	const usage = cache.codexUsage;
	return usage && Date.now() - usage.fetchedAt <= CODEX_USAGE_TTL_MS ? usage : undefined;
}

function contextBar(used: number, max: number): string {
	const width = 20;
	const fraction = max > 0 ? Math.min(1, Math.max(0, used / max)) : 0;
	return zonedBar(Math.round(fraction * width), width);
}

function limitBar(usedPct: number): string {
	return zonedBar(Math.round(usedPct / 10), 10);
}

function zonedBar(filled: number, width: number): string {
	let out = "";
	for (let i = 0; i < width; i++) {
		const bright = i < width * 0.7 ? "\u001b[38;5;42m" : i < width * 0.9 ? "\u001b[38;5;214m" : "\u001b[38;5;203m";
		const dim = i < width * 0.7 ? "\u001b[38;5;22m" : i < width * 0.9 ? "\u001b[38;5;94m" : "\u001b[38;5;52m";
		out += `${i < filled ? bright : dim}${i < filled ? "█" : "░"}`;
	}
	return `${out}\u001b[0m`;
}

function contextColor(theme: RenderTheme, pct: number, text: string): string {
	if (pct >= 80) return theme.fg("warning", text);
	if (pct >= 55) return theme.fg("accent", text);
	return theme.fg("success", text);
}

function refreshLocation(cwd: string): Promise<void> | undefined {
	const now = Date.now();
	if (locationCache?.cwd === cwd && now - locationCache.checkedAt < LOCATION_TTL_MS) return locationCache.refresh;
	if (locationCache?.cwd === cwd && locationCache.refresh) return locationCache.refresh;
	const fallback = locationCache?.cwd === cwd ? locationCache : { cwd, dir: basename(cwd), dirty: false, checkedAt: now };
	const refresh = loadLocation(cwd)
		.then((location) => {
			locationCache = { ...location };
			delete locationCache.refresh;
		})
		.catch(() => {
			locationCache = { ...fallback, checkedAt: Date.now() };
			delete locationCache.refresh;
		})
		.finally(() => requestRender?.());
	locationCache = { ...fallback, refresh };
	return refresh;
}

async function loadLocation(cwd: string): Promise<{ cwd: string; dir: string; dirty: boolean; checkedAt: number }> {
	const [root, dirtyOutput] = await Promise.all([
		gitOutput(cwd, ["rev-parse", "--show-toplevel"]),
		gitOutput(cwd, ["status", "--porcelain"]),
	]);
	const trimmedRoot = root.trim();
	let dir = basename(cwd);
	if (trimmedRoot && cwd !== trimmedRoot && cwd.startsWith(`${trimmedRoot}/`)) {
		const parts = cwd.slice(trimmedRoot.length + 1).split("/");
		dir = parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
	}
	return { cwd, dir, dirty: dirtyOutput.trim().length > 0, checkedAt: Date.now() };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
	return await new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function fmtTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1000)}k`;
	return `${value}`;
}

function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value.replace(/,/g, ""));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseReset(value: string | undefined, now: number): number | undefined {
	if (value === undefined || value === "") return undefined;
	const trimmed = value.trim();
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
	const relative = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
	if (relative?.[1] !== undefined && relative[2] !== undefined) {
		const amount = Number(relative[1]);
		const unit = relative[2].toLowerCase();
		const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
		return now + amount * factor;
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function utilization(bucket: LimitBucket): number {
	return bucket.limit > 0 ? (bucket.limit - bucket.remaining) / bucket.limit : 0;
}

async function resolveModelCodexCredential(ctx: PiContext): Promise<{ access: string; accountId: string } | undefined> {
	if (!ctx.model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || auth.apiKey === undefined) return undefined;
	const accountId = getHeader(auth.headers, CODEX_ACCOUNT_ID_HEADER) ?? extractCodexAccountId(auth.apiKey);
	return accountId !== undefined ? { access: auth.apiKey, accountId } : undefined;
}

function readStoredCodexCredential(): { access: string; accountId: string } | undefined {
	try {
		if (!existsSync(AUTH_PATH)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
		if (!isObject(parsed)) return undefined;
		const credential = parsed["openai-codex"];
		if (!isObject(credential)) return undefined;
		const access = credential.access;
		const accountId = credential.accountId;
		const expires = credential.expires;
		if (typeof expires === "number" && Date.now() > expires - 60_000) return undefined;
		return typeof access === "string" && typeof accountId === "string" ? { access, accountId } : undefined;
	} catch {
		return undefined;
	}
}

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return found?.[1];
}

function extractCodexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[1] === undefined) return undefined;
	try {
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isObject(payload)) return undefined;
		const authClaim = payload[JWT_CLAIM_PATH];
		if (!isObject(authClaim)) return undefined;
		return typeof authClaim.chatgpt_account_id === "string" ? authClaim.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCache(): Cache {
	try {
		if (!existsSync(CACHE_PATH)) return {};
		const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
		return validCache(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function validCache(value: unknown): value is Cache {
	if (!isObject(value)) return false;
	if (value.lastError !== undefined && typeof value.lastError !== "string") return false;
	if (value.limits !== undefined && (!Array.isArray(value.limits) || !value.limits.every(validLimitBucket))) return false;
	if (value.codexUsage !== undefined && !validCodexUsage(value.codexUsage)) return false;
	return true;
}

function validLimitBucket(value: unknown): value is LimitBucket {
	return (
		isObject(value) &&
		typeof value.name === "string" &&
		typeof value.limit === "number" &&
		typeof value.remaining === "number" &&
		typeof value.observedAt === "number" &&
		(value.resetAt === undefined || typeof value.resetAt === "number")
	);
}

function validCodexUsage(value: unknown): value is CodexUsage {
	return (
		isObject(value) &&
		Array.isArray(value.windows) &&
		value.windows.length > 0 &&
		value.windows.every(validCodexUsageWindow) &&
		(value.planType === undefined || typeof value.planType === "string") &&
		(value.creditsAvailable === undefined || typeof value.creditsAvailable === "number") &&
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

function writeCache(next: Cache): void {
	try {
		writeFileSync(CACHE_PATH, JSON.stringify(next), "utf8");
	} catch {}
}

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n", 1)[0]?.slice(0, 120);
	return firstLine !== undefined && firstLine !== "" ? firstLine : "unknown error";
}

function renderDebug(): string {
	const usage = cache.codexUsage;
	if (usage) {
		const windows = usage.windows.map((window) => `${window.label} ${window.usedPercent}%`).join(", ");
		return `Codex usage ${windows}${cache.lastError !== undefined ? `; last error: ${cache.lastError}` : ""}`;
	}
	return cache.lastError !== undefined ? `Codex usage unavailable: ${cache.lastError}` : "Codex usage has not been fetched yet";
}
