import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { classifyAgentEndState, type AgentEndClassification } from "./shared/agent-end-state.ts";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORKING_INDICATOR_FRAME = "●";

interface WorkingIndicatorOptions {
	frames: string[];
	intervalMs?: number;
}

type NotifyKind = "ready" | "question" | "error" | "queued" | "stopped";

interface NotifyOutcome {
	kind: NotifyKind;
	title: string;
	body: string;
	titlePrefix: string;
}

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const summarizeText = (value: string, max = 120): string => {
	const normalized = normalizeText(value);
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
};

const sanitizeForTerminal = (value: string): string => value.replace(/[\x00-\x1f\x7f\x1b\x07]/g, " ").replace(/[;]+/g, ",").trim();

const escapePowerShell = (value: string): string => sanitizeForTerminal(value).replace(/'/g, "''");

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapePowerShell(body)}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${escapePowerShell(title)}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${sanitizeForTerminal(title)};${sanitizeForTerminal(body)}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${sanitizeForTerminal(title)}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${sanitizeForTerminal(body)}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => undefined);
}

function sendTerminalNotification(title: string, body: string): void {
	if (!process.stdout.isTTY) return;
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

function getBaseTitle(pi: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = pi.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

function toNotifyOutcome(classification: AgentEndClassification): NotifyOutcome {
	if (classification.kind === "question") {
		return {
			kind: "question",
			title: "Pi needs input",
			body: classification.summary,
			titlePrefix: "❓",
		};
	}
	if (classification.kind === "error") {
		return {
			kind: "error",
			title: "Pi error",
			body: classification.summary,
			titlePrefix: "⚠",
		};
	}
	if (classification.kind === "queued") {
		return {
			kind: "queued",
			title: "Pi queued",
			body: classification.summary,
			titlePrefix: "↻",
		};
		}
	if (classification.kind === "stopped") {
		return {
			kind: "stopped",
			title: "Pi stopped",
			body: classification.summary,
			titlePrefix: "■",
		};
	}
	return {
		kind: "ready",
		title: "Pi ready",
		body: classification.summary,
		titlePrefix: "✓",
	};
}

export function classifyAgentEnd(messages: AgentMessage[], hasPendingMessages = false): NotifyOutcome {
	return toNotifyOutcome(classifyAgentEndState(messages, { hasPendingMessages }));
}

function setWorkingIndicator(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	const ui = ctx.ui as typeof ctx.ui & {
		setWorkingIndicator?: (options?: WorkingIndicatorOptions) => void;
	};
	ui.setWorkingIndicator?.(active ? { frames: [ui.theme.fg("accent", WORKING_INDICATOR_FRAME)] } : undefined);
}

function stopAnimation(ctx: ExtensionContext, pi: ExtensionAPI, prefix?: string) {
	ctx.ui.setTitle(prefix ? `${prefix} ${getBaseTitle(pi)}` : getBaseTitle(pi));
}

export default function notifyExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	const stopTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
		frameIndex = 0;
	};

	const startAnimation = (ctx: ExtensionContext) => {
		stopTimer();
		if (!ctx.hasUI) return;
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			ctx.ui.setTitle(`${frame} ${getBaseTitle(pi)}`);
			frameIndex++;
		}, 80);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setWorkingIndicator(ctx, false);
		stopAnimation(ctx, pi);
	});

	pi.on("agent_start", async (_event, ctx) => {
		setWorkingIndicator(ctx, true);
		startAnimation(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		stopTimer();
		if (!ctx.hasUI) return;
		setWorkingIndicator(ctx, false);
		const outcome = classifyAgentEnd(event.messages, ctx.hasPendingMessages());
		stopAnimation(ctx, pi, outcome.titlePrefix);
		if (outcome.kind === "queued" || outcome.kind === "stopped") return;
		sendTerminalNotification(outcome.title, outcome.body);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		if (!ctx.hasUI) return;
		setWorkingIndicator(ctx, false);
		stopAnimation(ctx, pi);
	});
}
