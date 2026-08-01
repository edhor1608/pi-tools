import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const GAP_MS = 2 * 24 * 60 * 60 * 1000;
const CURRENT_ACTIVITY_GRACE_MS = 60_000;

export type SessionGap = { milliseconds: number; days: number; hours: number };
export type SessionGapCheckState = { checked: boolean };

export function computeSessionGap(timestamps: number[], now: number): SessionGap | undefined {
	const previousActivity = timestamps
		.filter((timestamp) => Number.isFinite(timestamp) && timestamp < now - CURRENT_ACTIVITY_GRACE_MS)
		.reduce<number | undefined>((newest, timestamp) => (newest === undefined || timestamp > newest ? timestamp : newest), undefined);
	if (previousActivity === undefined) return undefined;
	const milliseconds = now - previousActivity;
	if (milliseconds <= GAP_MS) return undefined;
	return {
		milliseconds,
		days: Math.floor(milliseconds / (24 * 60 * 60 * 1000)),
		hours: Math.floor((milliseconds % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)),
	};
}

export function checkSessionGapOnce(
	state: SessionGapCheckState,
	timestamps: number[],
	now: number,
): { state: SessionGapCheckState; gap?: SessionGap } {
	if (state.checked) return { state };
	return { state: { checked: true }, gap: computeSessionGap(timestamps, now) };
}

export function buildSessionGapAlert(gap: Pick<SessionGap, "days" | "hours">): string {
	return `SESSION-GAP ALERT: The previous activity in this session was ${gap.days} day(s) ${gap.hours}h ago. Jonas has ADHD and has completely lost the context of this session. BEFORE addressing his new prompt, invoke the 'catchup' skill and follow it: verify the real current state (git, tasks, files, background agents — do not trust conversation memory alone) and deliver the re-orientation briefing it defines. Then explicitly connect his new prompt to that state — if his prompt seems to ignore or contradict where the session left off, point that out instead of silently following it.`;
}

export function buildSessionGapNotification(gap: Pick<SessionGap, "days" | "hours">): string {
	return `⏰ Session war ${gap.days}d ${gap.hours}h inaktiv — Re-Orientierungs-Briefing wird vorangestellt.`;
}

export default function sessionGapExtension(pi: ExtensionAPI): void {
	let resumed = false;
	let checkState: SessionGapCheckState = { checked: true };
	let pendingGap: SessionGap | undefined;

	pi.on("session_start", (event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
		resumed = event.reason === "resume" || (event.reason === "startup" && entries.length > 0);
		checkState = { checked: !resumed };
		pendingGap = undefined;
		if (!resumed) return;

		const result = checkSessionGapOnce(checkState, messageTimestamps(entries), Date.now());
		checkState = result.state;
		pendingGap = result.gap;
		if (pendingGap) ctx.ui.notify(buildSessionGapNotification(pendingGap), "warning");
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!resumed) return;
		if (!checkState.checked) {
			const result = checkSessionGapOnce(checkState, messageTimestamps(ctx.sessionManager.getBranch()), Date.now());
			checkState = result.state;
			pendingGap = result.gap;
			if (pendingGap) ctx.ui.notify(buildSessionGapNotification(pendingGap), "warning");
		}
		if (!pendingGap) return;
		const gap = pendingGap;
		pendingGap = undefined;
		resumed = false;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildSessionGapAlert(gap)}` };
	});
}

function messageTimestamps(entries: SessionEntry[]): number[] {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.message.timestamp] : []));
}
