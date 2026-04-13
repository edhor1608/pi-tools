import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type NotifyKind = "ready" | "question" | "error" | "queued";

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

function getAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return normalizeText(content);
	if (!Array.isArray(content)) return "";
	return normalizeText(
		content
			.filter((block): block is { type: "text"; text: string } => {
				if (typeof block !== "object" || block === null) return false;
				return "type" in block && block.type === "text" && "text" in block && typeof block.text === "string";
			})
			.map((block) => block.text)
			.join("\n"),
	);
}

function findQuestionLine(text: string): string | undefined {
	const lines = text
		.split(/\r?\n/)
		.map((line) => normalizeText(line))
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("```"));
	const directQuestion = lines.find((line) => /\?$/.test(line));
	if (directQuestion) return directQuestion;
	return lines.find((line) =>
		/(do you want|would you like|should i|should we|can you|could you|please confirm|let me know|which option|which one|what should|how should)/i.test(
			line,
		),
	);
}

export function classifyAgentEnd(messages: AgentMessage[]): NotifyOutcome {
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	if (!lastAssistant) {
		return {
			kind: "ready",
			title: "Pi ready",
			body: "Ready for input",
			titlePrefix: "✓",
		};
	}

	const stopReason = typeof (lastAssistant as { stopReason?: unknown }).stopReason === "string"
		? (lastAssistant as { stopReason: string }).stopReason
		: undefined;
	const errorMessage = typeof (lastAssistant as { errorMessage?: unknown }).errorMessage === "string"
		? normalizeText((lastAssistant as { errorMessage: string }).errorMessage)
		: "";
	if (errorMessage) {
		return {
			kind: "error",
			title: "Pi error",
			body: summarizeText(errorMessage),
			titlePrefix: "⚠",
		};
	}
	if (stopReason && stopReason !== "stop" && stopReason !== "toolUse") {
		if (stopReason === "aborted") {
			return {
				kind: "ready",
				title: "Pi stopped",
				body: "Stopped",
				titlePrefix: "■",
			};
		}
		return {
			kind: "error",
			title: "Pi error",
			body: `Stopped: ${stopReason}`,
			titlePrefix: "⚠",
		};
	}

	const text = getAssistantText(lastAssistant);
	const question = findQuestionLine(text);
	if (question) {
		return {
			kind: "question",
			title: "Pi needs input",
			body: summarizeText(question),
			titlePrefix: "❓",
		};
	}

	return {
		kind: "ready",
		title: "Pi ready",
		body: "Ready for input",
		titlePrefix: "✓",
	};
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
		stopAnimation(ctx, pi);
	});

	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		stopTimer();
		if (!ctx.hasUI) return;
		if (ctx.hasPendingMessages()) {
			const queued: NotifyOutcome = {
				kind: "queued",
				title: "Pi queued",
				body: "More queued messages are waiting",
				titlePrefix: "↻",
			};
			stopAnimation(ctx, pi, queued.titlePrefix);
			return;
		}
		const outcome = classifyAgentEnd(event.messages);
		stopAnimation(ctx, pi, outcome.titlePrefix);
		if (outcome.kind === "ready" && outcome.body === "Stopped") return;
		sendTerminalNotification(outcome.title, outcome.body);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		if (!ctx.hasUI) return;
		stopAnimation(ctx, pi);
	});
}
