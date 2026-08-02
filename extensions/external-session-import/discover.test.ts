import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { filterExternalSessions, listExternalSessions, readSessionMetadata } from "./discover.ts";
import { METADATA_READ_BYTES, type ExternalSessionRef } from "./types.ts";

const withFixtureHome = async (run: (home: string) => Promise<void>): Promise<void> => {
	const home = await mkdtemp(join(tmpdir(), "external-import-discovery-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
};

void describe("external session discovery", () => {
	void test("tags sources and sorts stat-only results by modification time", async () => {
		await withFixtureHome(async (home) => {
			const claudeDirectory = join(home, ".claude", "projects", "encoded-project");
			const codexDirectory = join(home, ".codex", "sessions", "2025", "01", "02");
			const codexRoot = join(home, ".codex", "sessions");
			await mkdir(claudeDirectory, { recursive: true });
			await mkdir(codexDirectory, { recursive: true });
			const claudePath = join(claudeDirectory, "claude.jsonl");
			const codexPath = join(codexDirectory, "rollout.jsonl");
			const legacyPath = join(codexRoot, "legacy.json");
			await Promise.all([writeFile(claudePath, "{}\n"), writeFile(codexPath, "{}\n"), writeFile(legacyPath, "{}")]);
			await utimes(claudePath, new Date(1000), new Date(1000));
			await utimes(codexPath, new Date(3000), new Date(3000));
			await utimes(legacyPath, new Date(2000), new Date(2000));

			const sessions = await listExternalSessions({ homedir: home });
			assert.deepEqual(
				sessions.map((session) => [session.source, session.path]),
				[
					["codex", codexPath],
					["codex-legacy", legacyPath],
					["claude", claudePath],
				],
			);
			assert.equal(
				sessions.every((session) => session.cwd === undefined && session.preview === undefined),
				true,
			);
			assert.equal((await listExternalSessions({ homedir: home, source: "claude" })).length, 1);
			assert.equal((await listExternalSessions({ homedir: home, source: "codex" })).length, 2);
		});
	});

	void test("extracts visible-page metadata without reading beyond 64KB", async () => {
		await withFixtureHome(async (home) => {
			const normalPath = join(home, "normal.jsonl");
			await writeFile(normalPath, `${JSON.stringify({ type: "user", cwd: "/synthetic/project", message: { content: "first prompt" } })}\n`);
			const details = await stat(normalPath);
			const normal = await readSessionMetadata({
				source: "claude",
				path: normalPath,
				modified: details.mtimeMs,
				sizeBytes: details.size,
			});
			assert.equal(normal.cwd, "/synthetic/project");
			assert.equal(normal.preview, "first prompt");

			const boundedPath = join(home, "bounded.jsonl");
			const beyondBound = `${"x".repeat(METADATA_READ_BYTES + 1)}\n${JSON.stringify({
				type: "user",
				cwd: "/must-not-be-read",
				message: { content: "hidden prompt" },
			})}\n`;
			await writeFile(boundedPath, beyondBound);
			const boundedDetails = await stat(boundedPath);
			const bounded = await readSessionMetadata({
				source: "claude",
				path: boundedPath,
				modified: boundedDetails.mtimeMs,
				sizeBytes: boundedDetails.size,
			});
			assert.equal(bounded.cwd, undefined);
			assert.equal(bounded.preview, undefined);
		});
	});

	void test("filters case-insensitively by path or enriched cwd", () => {
		const sessions: ExternalSessionRef[] = [
			{ source: "claude", path: "/sessions/Alpha.jsonl", modified: 2, sizeBytes: 1 },
			{ source: "codex", path: "/sessions/beta.jsonl", modified: 1, sizeBytes: 1, cwd: "/Work/Gamma" },
		];
		assert.deepEqual(filterExternalSessions(sessions, "alpha"), [sessions[0]]);
		assert.deepEqual(filterExternalSessions(sessions, "GAMMA"), [sessions[1]]);
		assert.equal(filterExternalSessions(sessions, "missing").length, 0);
	});
});
