import type { AuthCredential } from "@mariozechner/pi-coding-agent";
import { AuthStorage, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

const STATUS_KEY = "context-health";
const CUSTOM_TYPE = "context-health";
const ROLLING_CACHE_WINDOW = 8;
const PLAN_MONTHLY_PRICE_USD: Record<string, number | undefined> = {
	plus: 20,
	pro: 200,
	business: undefined,
	enterprise: undefined,
	edu: undefined,
	free: 0,
};

interface AssistantUsageSnapshot {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

interface SubscriptionUsage {
	kind: "exact" | "estimate" | "unknown";
	label: string;
	shortLabel: string;
	detail: string;
	percent?: number;
	plan?: string;
}

interface CacheHealth {
	label: "hot" | "warm" | "cold" | "unknown";
	percent?: number;
	sampleSize: number;
	shortLabel: string;
	detail: string;
}

interface RotHealth {
	label: "fresh" | "aging" | "stale" | "rotten";
	score: number;
	contextPercent?: number;
	contextWindow?: number;
	contextPercentKind: "exact" | "estimated" | "unknown";
	assistantTurnsSinceCompaction: number;
	uncachedInputSinceCompaction: number;
	shortLabel: string;
	detail: string;
}

interface ContextHealthSnapshot {
	subscription: SubscriptionUsage;
	cache: CacheHealth;
	rot: RotHealth;
}

interface ContextHealthMessageDetails {
	preview: string;
	timestamp: number;
	snapshot: ContextHealthSnapshot;
}

const formatNumber = (value: number): string => value.toLocaleString("en-US");
const formatPercent = (value: number): string => `${value.toFixed(1)}%`;
const formatCompactPercent = (value: number): string => (value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`);
const formatUsd = (value: number): string => `$${value.toFixed(2)}`;
const formatTokenCount = (count: number): string => {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
};

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return undefined;
		const payload = parts[1];
		if (!payload) return undefined;
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
};

const getOpenAICodexPlan = (credential: AuthCredential | undefined): string | undefined => {
	if (!credential || credential.type !== "oauth") return undefined;
	const payload = decodeJwtPayload(credential.access);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const plan = (auth as Record<string, unknown>).chatgpt_plan_type;
	return typeof plan === "string" && plan.length > 0 ? plan : undefined;
};

const getAssistantUsageSnapshots = (branch: SessionEntry[]): AssistantUsageSnapshot[] =>
	branch
		.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
		.filter((entry) => entry.message.role === "assistant")
		.map((entry) => ({
			input: entry.message.usage.input,
			cacheRead: entry.message.usage.cacheRead,
			cacheWrite: entry.message.usage.cacheWrite,
			totalTokens: entry.message.usage.totalTokens,
			costTotal: entry.message.usage.cost.total,
		}));

const computeRollingCacheHealth = (branch: SessionEntry[]): CacheHealth => {
	const snapshots = getAssistantUsageSnapshots(branch)
		.filter((snapshot) => snapshot.input > 0 || snapshot.cacheRead > 0)
		.slice(-ROLLING_CACHE_WINDOW);
	if (snapshots.length === 0) {
		return {
			label: "unknown",
			sampleSize: 0,
			shortLabel: "cache?",
			detail: "No assistant turns with cache telemetry yet.",
		};
	}
	const input = snapshots.reduce((sum, snapshot) => sum + snapshot.input, 0);
	const cacheRead = snapshots.reduce((sum, snapshot) => sum + snapshot.cacheRead, 0);
	const total = input + cacheRead;
	const percent = total > 0 ? (cacheRead / total) * 100 : 0;
	const label = percent >= 75 ? "hot" : percent >= 40 ? "warm" : "cold";
	return {
		label,
		percent: Number(percent.toFixed(1)),
		sampleSize: snapshots.length,
		shortLabel: `cache ${formatCompactPercent(percent)}`,
		detail: `${formatPercent(percent)} rolling cache-read ratio across the last ${snapshots.length} assistant turn${snapshots.length === 1 ? "" : "s"}.`,
	};
};

const estimateContextPercent = (ctx: ExtensionContext, branch: SessionEntry[]): { percent?: number; kind: "exact" | "estimated" | "unknown"; contextWindow?: number } => {
	const usage = ctx.getContextUsage();
	if (usage?.percent !== undefined && usage.percent !== null) {
		return { percent: Number(usage.percent.toFixed(1)), kind: "exact", contextWindow: usage.contextWindow };
	}
	const contextWindow = ctx.model?.contextWindow;
	if (!contextWindow) {
		return { kind: "unknown" };
	}
	const latestAssistant = getAssistantUsageSnapshots(branch).at(-1);
	if (!latestAssistant || latestAssistant.totalTokens <= 0) {
		return { kind: "unknown", contextWindow };
	}
	const percent = Math.min(100, (latestAssistant.totalTokens / contextWindow) * 100);
	return { percent: Number(percent.toFixed(1)), kind: "estimated", contextWindow };
};

const findLatestCompactionIndex = (branch: SessionEntry[]): number => {
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") return i;
	}
	return -1;
};

const computeRotHealth = (ctx: ExtensionContext, branch: SessionEntry[]): RotHealth => {
	const context = estimateContextPercent(ctx, branch);
	const latestCompactionIndex = findLatestCompactionIndex(branch);
	const entriesSinceCompaction = latestCompactionIndex >= 0 ? branch.slice(latestCompactionIndex + 1) : branch;
	const assistantSnapshots = getAssistantUsageSnapshots(entriesSinceCompaction);
	const assistantTurnsSinceCompaction = assistantSnapshots.length;
	const uncachedInputSinceCompaction = assistantSnapshots.reduce((sum, snapshot) => sum + snapshot.input, 0);
	const contextScore = context.percent ?? 50;
	const turnScore = Math.min(100, assistantTurnsSinceCompaction * 7);
	const uncachedScore = Math.min(100, (uncachedInputSinceCompaction / 20000) * 100);
	const score = Math.round(contextScore * 0.45 + turnScore * 0.3 + uncachedScore * 0.25);
	const label = score >= 80 ? "rotten" : score >= 60 ? "stale" : score >= 35 ? "aging" : "fresh";
	const contextPart =
		context.percent !== undefined && context.contextWindow
			? `${formatPercent(context.percent)} of ${formatTokenCount(context.contextWindow)} context (${context.kind})`
			: "context usage unavailable";
	return {
		label,
		score,
		contextPercent: context.percent,
		contextWindow: context.contextWindow,
		contextPercentKind: context.kind,
		assistantTurnsSinceCompaction,
		uncachedInputSinceCompaction,
		shortLabel: `rot ${label}`,
		detail: `${label} rot score ${score}/100 from ${contextPart}, ${assistantTurnsSinceCompaction} assistant turns since the last compaction, and ${formatTokenCount(uncachedInputSinceCompaction)} uncached input tokens since then.`,
	};
};

const computeSubscriptionUsage = (ctx: ExtensionContext, branch: SessionEntry[]): SubscriptionUsage => {
	const model = ctx.model;
	if (!model) {
		return {
			kind: "unknown",
			label: "unknown",
			shortLabel: "sub?",
			detail: "No active model.",
		};
	}
	const usingOAuth = ctx.modelRegistry.isUsingOAuth(model);
	if (!usingOAuth) {
		return {
			kind: "unknown",
			label: "n/a",
			shortLabel: "sub n/a",
			detail: `Model ${model.provider}/${model.id} is not using OAuth subscription auth.`,
		};
	}
	const equivalentCost = getAssistantUsageSnapshots(branch).reduce((sum, snapshot) => sum + snapshot.costTotal, 0);
	const credential = AuthStorage.create().get(model.provider);
	const plan = model.provider === "openai-codex" ? getOpenAICodexPlan(credential) : undefined;
	const planPrice = plan ? PLAN_MONTHLY_PRICE_USD[plan] : undefined;
	if (planPrice !== undefined && planPrice > 0) {
		const percent = Number(((equivalentCost / planPrice) * 100).toFixed(1));
		return {
			kind: "estimate",
			label: `${formatPercent(percent)} estimated`,
			shortLabel: `sub~${formatCompactPercent(percent)}`,
			detail: `Estimated from current-branch equivalent cost ${formatUsd(equivalentCost)} against ChatGPT ${plan} plan value ${formatUsd(planPrice)}. Exact provider quota usage is not exposed through Pi's current runtime/auth surface.`,
			percent,
			plan,
		};
	}
	if (equivalentCost > 0) {
		return {
			kind: "estimate",
			label: `${formatUsd(equivalentCost)} equivalent cost`,
			shortLabel: "sub~?",
			detail: plan
				? `Equivalent current-branch cost is ${formatUsd(equivalentCost)} on plan ${plan}, but no plan-value reference is available for a percentage estimate.`
				: `Equivalent current-branch cost is ${formatUsd(equivalentCost)}, but no exact or plan-based usage percentage is available.`,
			plan,
		};
	}
	return {
		kind: "unknown",
		label: "unknown",
		shortLabel: "sub?",
		detail: "No subscription usage signal is available yet.",
		plan,
	};
};

const buildSnapshot = (ctx: ExtensionContext): ContextHealthSnapshot => {
	const branch = ctx.sessionManager.getBranch();
	return {
		subscription: computeSubscriptionUsage(ctx, branch),
		cache: computeRollingCacheHealth(branch),
		rot: computeRotHealth(ctx, branch),
	};
};

const renderStatusLine = (ctx: ExtensionContext, snapshot: ContextHealthSnapshot): string => {
	const theme = ctx.ui.theme;
	const subscriptionColor = snapshot.subscription.kind === "exact" ? "accent" : snapshot.subscription.kind === "estimate" ? "warning" : "dim";
	const cacheColor = snapshot.cache.label === "hot" ? "success" : snapshot.cache.label === "warm" ? "warning" : snapshot.cache.label === "cold" ? "error" : "dim";
	const rotColor = snapshot.rot.label === "fresh" ? "success" : snapshot.rot.label === "aging" ? "warning" : "error";
	return [
		theme.fg(subscriptionColor, snapshot.subscription.shortLabel),
		theme.fg(cacheColor, snapshot.cache.shortLabel),
		theme.fg(rotColor, snapshot.rot.shortLabel),
	].join(" ");
};

const buildPreview = (snapshot: ContextHealthSnapshot): string =>
	[
		`- subscription: ${snapshot.subscription.label}`,
		`- cache: ${snapshot.cache.percent !== undefined ? `${formatPercent(snapshot.cache.percent)} ${snapshot.cache.label}` : snapshot.cache.label}`,
		`- rot: ${snapshot.rot.label} (${snapshot.rot.score}/100)`,
	].join("\n");

const buildDetails = (snapshot: ContextHealthSnapshot): string => {
	const lines = [
		"Context Health",
		`- subscription: ${snapshot.subscription.label}`,
		`- subscription detail: ${snapshot.subscription.detail}`,
		`- cache: ${snapshot.cache.percent !== undefined ? `${formatPercent(snapshot.cache.percent)} ${snapshot.cache.label}` : snapshot.cache.label}`,
		`- cache detail: ${snapshot.cache.detail}`,
		`- rot: ${snapshot.rot.label} (${snapshot.rot.score}/100)`,
		`- rot detail: ${snapshot.rot.detail}`,
	];
	if (snapshot.subscription.plan) {
		lines.splice(2, 0, `- plan: ${snapshot.subscription.plan}`);
	}
	if (snapshot.rot.contextPercent !== undefined && snapshot.rot.contextWindow) {
		lines.push(
			`- context usage: ${formatPercent(snapshot.rot.contextPercent)} of ${formatTokenCount(snapshot.rot.contextWindow)} (${snapshot.rot.contextPercentKind})`,
		);
	}
	lines.push(`- turns since compaction: ${formatNumber(snapshot.rot.assistantTurnsSinceCompaction)}`);
	lines.push(`- uncached input since compaction: ${formatNumber(snapshot.rot.uncachedInputSinceCompaction)} tokens`);
	return lines.join("\n");
};

const updateStatus = (ctx: ExtensionContext) => {
	const snapshot = buildSnapshot(ctx);
	ctx.ui.setStatus(STATUS_KEY, renderStatusLine(ctx, snapshot));
};

export default function contextHealthExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details as ContextHealthMessageDetails | undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const title = theme.fg("accent", "Context Health");
		const body = options.expanded ? String(message.content) : details?.preview ?? String(message.content);
		const hint = theme.fg("dim", options.expanded ? "Live snapshot" : "Expand for metric details");
		box.addChild(new Text(`${title}\n${body}\n${hint}`, 0, 0));
		return box;
	});

	pi.registerCommand("context-health", {
		description: "Show subscription, cache, and rot health for the current branch",
		handler: async (_args, ctx) => {
			const snapshot = buildSnapshot(ctx);
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: buildDetails(snapshot),
				display: true,
				details: {
					preview: buildPreview(snapshot),
					timestamp: Date.now(),
					snapshot,
				} satisfies ContextHealthMessageDetails,
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});
}
