import fileFootnotesExtension, { rewriteFileLinksAsFootnotes } from "../extensions/file-footnotes.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const input = [
	"Changed files:",
	"- [README.md](/Users/jonas/repos/pi-tools/README.md)",
	"- [config.ts](</Users/jonas/My Folder/config.ts> \"Config\")",
	"- </Users/jonas/repos/pi-tools>",
	"- [Pi docs](https://pi.dev)",
	"- `[literal](/Users/jonas/literal.ts)`",
	"```md",
	"[fenced](/Users/jonas/fenced.ts)",
	"```",
].join("\n");

const rewritten = rewriteFileLinksAsFootnotes(input);
assert(rewritten.includes("README.md [[1]](</Users/jonas/repos/pi-tools/README.md>)"), "expected an inline README footnote");
assert(rewritten.includes("config.ts [[2]](</Users/jonas/My Folder/config.ts>)"), "expected a titled path with spaces to become a footnote");
assert(rewritten.includes("pi-tools [[3]](</Users/jonas/repos/pi-tools>)"), "expected an absolute autolink to become a footnote");
assert(rewritten.includes("[Pi docs](https://pi.dev)"), "expected web links to remain unchanged");
assert(rewritten.includes("`[literal](/Users/jonas/literal.ts)`"), "expected inline code to remain unchanged");
assert(rewritten.includes("[fenced](/Users/jonas/fenced.ts)"), "expected fenced code to remain unchanged");
assert(rewritten.includes("File references:\n- [[1]](</Users/jonas/repos/pi-tools/README.md>)"), "expected a persisted references section");
assert((rewritten.match(/\[\[1\]\]/g) ?? []).length === 2, "expected one inline and one footer marker for the first path");

const unchanged = rewriteFileLinksAsFootnotes("See [Pi](https://pi.dev).");
assert(unchanged === "See [Pi](https://pi.dev).", "expected text without file links to stay byte-for-byte unchanged");
assert(rewriteFileLinksAsFootnotes(rewritten) === rewritten, "expected rewriting to be idempotent");

type MessageEndHandler = (event: { message: Record<string, unknown> }) => unknown;
let messageEndHandler: MessageEndHandler | undefined;
let fileFootnotesCommand: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
const execCalls: Array<{ command: string; args: string[] }> = [];

const api = {
	on(event: string, handler: MessageEndHandler) {
		if (event === "message_end") messageEndHandler = handler;
	},
	registerCommand(name: string, config: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) {
		if (name === "file-footnotes") fileFootnotesCommand = config.handler;
	},
	async exec(command: string, args: string[]) {
		execCalls.push({ command, args });
		return { code: 0, stdout: "", stderr: "" };
	},
};

fileFootnotesExtension(api as never);
assert(messageEndHandler, "expected message_end handler to register");
assert(fileFootnotesCommand, "expected /file-footnotes command to register");

const assistant = {
	role: "assistant",
	content: [{ type: "text", text: "Read [README](/Users/jonas/README.md)." }],
	stopReason: "stop",
};
const replacement = await messageEndHandler({ message: assistant });
assert(typeof replacement === "object" && replacement !== null && "message" in replacement, "expected an assistant replacement message");
const replacedMessage = (replacement as { message: typeof assistant }).message;
assert(replacedMessage !== assistant, "expected the finalized message to be copied rather than mutated");
assert(replacedMessage.content[0]?.text.includes("File references:"), "expected footnotes in the finalized assistant message");

const userResult = await messageEndHandler({ message: { role: "user", content: "unchanged" } });
assert(userResult === undefined, "expected non-assistant messages to remain unchanged");

const notifications: string[] = [];
await fileFootnotesCommand("vscode 1", {
	sessionManager: {
		getBranch: () => [{ type: "message", message: replacedMessage }],
	},
	ui: {
		notify: (message: string) => notifications.push(message),
		select: async () => undefined,
	},
} as never);
assert(execCalls.some((call) => call.command === "code" && call.args[0] === "/Users/jonas/README.md"), "expected the command to open the persisted reference");
assert(notifications.some((message) => message.includes("Opened footnote [1] in VS Code")), "expected a successful open notification");

console.log(JSON.stringify({ rewritten, replacement: replacedMessage, command: { execCalls, notifications } }, null, 2));
