import assert from "node:assert/strict";
import test from "node:test";
import fileFootnotesExtension, { rewriteFileLinksAsFootnotes } from "../extensions/file-footnotes.ts";

await test("file links become persisted footnotes and remain openable", async () => {
	const input = [
		"Changed files:",
		"- [README.md](/Users/jonas/repos/pi-tools/README.md)",
		'- [config.ts](</Users/jonas/My Folder/config.ts> "Config")',
		"- </Users/jonas/repos/pi-tools>",
		"- [Pi docs](https://pi.dev)",
		"- `[literal](/Users/jonas/literal.ts)`",
		"```md",
		"[fenced](/Users/jonas/fenced.ts)",
		"```",
	].join("\n");

	const rewritten = rewriteFileLinksAsFootnotes(input);
	assert.ok(rewritten.includes("README.md [[1]](</Users/jonas/repos/pi-tools/README.md>)"));
	assert.ok(rewritten.includes("config.ts [[2]](</Users/jonas/My Folder/config.ts>)"));
	assert.ok(rewritten.includes("pi-tools [[3]](</Users/jonas/repos/pi-tools>)"));
	assert.ok(rewritten.includes("[Pi docs](https://pi.dev)"));
	assert.ok(rewritten.includes("`[literal](/Users/jonas/literal.ts)`"));
	assert.ok(rewritten.includes("[fenced](/Users/jonas/fenced.ts)"));
	assert.ok(rewritten.includes("File references:\n- [[1]](</Users/jonas/repos/pi-tools/README.md>)"));
	assert.equal((rewritten.match(/\[\[1\]\]/g) ?? []).length, 2);
	assert.equal(rewriteFileLinksAsFootnotes("See [Pi](https://pi.dev)."), "See [Pi](https://pi.dev).");
	assert.equal(rewriteFileLinksAsFootnotes(rewritten), rewritten);

	type MessageEndHandler = (event: { message: Record<string, unknown> }) => unknown;
	let registeredMessageEndHandler: MessageEndHandler | undefined;
	let registeredCommand: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
	const execCalls: Array<{ command: string; args: string[] }> = [];

	const api = {
		on(event: string, handler: MessageEndHandler) {
			if (event === "message_end") registeredMessageEndHandler = handler;
		},
		registerCommand(name: string, config: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) {
			if (name === "file-footnotes") registeredCommand = config.handler;
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	fileFootnotesExtension(api as never);
	const messageEndHandler = registeredMessageEndHandler;
	const fileFootnotesCommand = registeredCommand;
	assert.ok(messageEndHandler, "expected message_end handler to register");
	assert.ok(fileFootnotesCommand, "expected /file-footnotes command to register");

	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "Read [README](/Users/jonas/README.md)." }],
		stopReason: "stop",
	};
	const replacement = await messageEndHandler({ message: assistant });
	assert.ok(typeof replacement === "object" && replacement !== null && "message" in replacement);
	const replacedMessage = (replacement as { message: typeof assistant }).message;
	assert.notEqual(replacedMessage, assistant);
	assert.ok(replacedMessage.content[0]?.text.includes("File references:"));
	assert.equal(await messageEndHandler({ message: { role: "user", content: "unchanged" } }), undefined);

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
	assert.ok(execCalls.some((call) => call.command === "code" && call.args[0] === "/Users/jonas/README.md"));
	assert.ok(notifications.some((message) => message.includes("Opened footnote [1] in VS Code")));
});
