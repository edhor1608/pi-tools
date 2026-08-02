import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { isEditToolResult, isWriteToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const NODE_MODULES_SEGMENT = /(?:^|[\\/])node_modules(?:[\\/]|$)/;
const PERSONAL_LINT_TIMEOUT_MS = 30_000;

export type PersonalLintRunner = (filePath: string) => Promise<string | undefined>;

export function shouldRunPersonalLint(filePath: string) {
	return !NODE_MODULES_SEGMENT.test(filePath) && SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function formatPersonalLintDiagnostics(filePath: string, diagnostics: string) {
	return `Jonas' persönliche Lint-Regeln (nicht Teil der Repo-Config oder CI; betreffen nur seine Edits) melden für ${filePath}:\n\n${diagnostics.trim()}\n\nFixe die Verstöße in der gerade editierten Datei, sofern sinnvoll. Führe KEINE Repo-weiten Lint-Fixes deswegen aus.`;
}

export async function lintPersonalFile(filePath: string, runLint: PersonalLintRunner) {
	if (!shouldRunPersonalLint(filePath)) return undefined;
	try {
		const diagnostics = (await runLint(filePath))?.trim();
		return diagnostics !== undefined && diagnostics !== "" ? formatPersonalLintDiagnostics(filePath, diagnostics) : undefined;
	} catch {
		return undefined;
	}
}

export default function personalLintExtension(pi: ExtensionAPI) {
	const lintDirectory = join(homedir(), ".agents", "personal-lint");
	const lintScript = join(lintDirectory, "lint-files.sh");
	const oxlintBinary = join(lintDirectory, "node_modules", ".bin", "oxlint");

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (!isEditToolResult(event) && !isWriteToolResult(event))) return;
		const inputPath = event.input.path;
		if (typeof inputPath !== "string") return;

		try {
			const filePath = resolve(ctx.cwd, inputPath);
			if (!shouldRunPersonalLint(filePath) || !existsSync(lintDirectory) || !existsSync(lintScript) || !existsSync(oxlintBinary)) return;
			if (!statSync(filePath).isFile()) return;

			const message = await lintPersonalFile(filePath, async (target) => {
				const result = await pi.exec(lintScript, [target], {
					...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
					timeout: PERSONAL_LINT_TIMEOUT_MS,
				});
				if (result.code !== 0 || result.killed || result.stderr.trim()) return undefined;
				return result.stdout;
			});
			if (message === undefined) return;
			return { content: [...event.content, { type: "text", text: message }] };
		} catch {
			return;
		}
	});
}
