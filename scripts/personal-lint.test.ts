import assert from "node:assert/strict";
import test from "node:test";
import { formatPersonalLintDiagnostics, lintPersonalFile, shouldRunPersonalLint } from "../extensions/personal-lint.ts";

await test("personal lint targets only supported JavaScript and TypeScript files", () => {
	for (const file of ["a.js", "a.jsx", "a.ts", "a.tsx", "a.mjs", "a.cjs"]) {
		assert.equal(shouldRunPersonalLint(`/repo/src/${file}`), true, file);
	}
	for (const file of ["a.mts", "a.cts", "a.json", "a.css", "a.ts.bak"]) {
		assert.equal(shouldRunPersonalLint(`/repo/src/${file}`), false, file);
	}
});

await test("personal lint excludes node_modules path segments", () => {
	assert.equal(shouldRunPersonalLint("/repo/node_modules/pkg/index.ts"), false);
	assert.equal(shouldRunPersonalLint("C:\\repo\\node_modules\\pkg\\index.ts"), false);
	assert.equal(shouldRunPersonalLint("/repo/src/node_modules-helper.ts"), true);
});

await test("personal lint diagnostics are identified as personal, not project CI", () => {
	const message = formatPersonalLintDiagnostics("/repo/src/file.ts", "  file.ts:1:1 warning  \n");
	assert.match(message, /Jonas' persönliche Lint-Regeln/);
	assert.match(message, /nicht Teil der Repo-Config oder CI/);
	assert.match(message, /file\.ts:1:1 warning/);
	assert.match(message, /KEINE Repo-weiten Lint-Fixes/);
});

await test("personal lint runs once for exactly the edited file", async () => {
	const calls: string[] = [];
	const message = await lintPersonalFile("/repo/src/file.ts", async (file) => {
		calls.push(file);
		return "diagnostic";
	});
	assert.deepEqual(calls, ["/repo/src/file.ts"]);
	assert.match(message ?? "", /diagnostic/);
});

await test("personal lint silently ignores clean files, excluded files, and runner failures", async () => {
	let calls = 0;
	const clean = await lintPersonalFile("/repo/src/file.ts", async () => {
		calls++;
		return "  \n";
	});
	const excluded = await lintPersonalFile("/repo/node_modules/pkg/file.ts", async () => {
		calls++;
		return "must not run";
	});
	const failed = await lintPersonalFile("/repo/src/other.ts", async () => {
		calls++;
		throw new Error("runner missing");
	});
	assert.equal(clean, undefined);
	assert.equal(excluded, undefined);
	assert.equal(failed, undefined);
	assert.equal(calls, 2);
});
