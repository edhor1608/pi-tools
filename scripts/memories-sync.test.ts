import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { commitMemoryChanges, createMemorySyncFailurePublisher, isMemoryPath } from "../extensions/memories-sync.ts";

const execFileAsync = promisify(execFile);

const git = async (repo: string, ...args: string[]): Promise<string> => {
	const result = await execFileAsync("git", args, { cwd: repo });
	return result.stdout.trim();
};

void test("path matching accepts canonical and symlinked descendants only", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-path-"));
	context.after(async () => rm(root, { recursive: true, force: true }));
	const repo = join(root, "memories");
	const memory = join(repo, "memory");
	const note = join(memory, "project", "note.md");
	const alias = join(root, "memories-alias");
	await mkdir(join(memory, "project"), { recursive: true });
	await writeFile(note, "note\n");
	await symlink(repo, alias);

	assert.equal(isMemoryPath("memory/project/note.md", repo, memory), true);
	assert.equal(isMemoryPath("@memory/project/note.md", repo, memory), true);
	assert.equal(isMemoryPath(note, root, memory), true);
	assert.equal(isMemoryPath(join(alias, "memory", "project", "note.md"), root, memory), true);
	assert.equal(isMemoryPath("memory", repo, memory), false);
	assert.equal(isMemoryPath("memory/../tool-failures.jsonl", repo, memory), false);
	assert.equal(isMemoryPath("memory-other/note.md", repo, memory), false);
});

void test("memory commits are path-scoped and skip unchanged repositories", async (context) => {
	const repo = await mkdtemp(join(tmpdir(), "pi-memories-sync-"));
	context.after(async () => rm(repo, { recursive: true, force: true }));

	await git(repo, "init", "-q");
	await git(repo, "config", "user.name", "Pi Test");
	await git(repo, "config", "user.email", "pi@example.test");
	await mkdir(join(repo, "memory", "project"), { recursive: true });
	await writeFile(join(repo, "memory", "project", "note.md"), "initial\n");
	await writeFile(join(repo, "outside.txt"), "initial\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "initial");

	await writeFile(join(repo, "memory", "project", "note.md"), "updated\n");
	await writeFile(join(repo, "outside.txt"), "staged but unrelated\n");
	await git(repo, "add", "outside.txt");

	assert.equal(await commitMemoryChanges({ repoRoot: repo, basename: "note.md" }), "committed");
	assert.equal(await git(repo, "log", "-1", "--pretty=%s"), "memory: note.md");
	assert.equal(await git(repo, "show", "--pretty=", "--name-only", "HEAD"), "memory/project/note.md");
	assert.equal(await git(repo, "diff", "--cached", "--name-only"), "outside.txt");
	assert.equal(await commitMemoryChanges({ repoRoot: repo, basename: "note.md" }), "noop");
});

void test("persistent index lock contention is reported after three attempts", async (context) => {
	const repo = await mkdtemp(join(tmpdir(), "pi-memories-locked-"));
	context.after(async () => rm(repo, { recursive: true, force: true }));
	await mkdir(join(repo, ".git"));
	let addAttempts = 0;

	const result = await commitMemoryChanges({
		repoRoot: repo,
		basename: "note.md",
		run: async (_command, args) => {
			if (args[0] === "rev-parse") return { code: 0, stdout: ".git\n", stderr: "" };
			addAttempts += 1;
			return { code: 128, stdout: "", stderr: "fatal: Unable to create .git/index.lock" };
		},
	});

	assert.equal(result, "failed");
	assert.equal(addAttempts, 3);
});

void test("no-change results stay silent while commit failures warn once", () => {
	const statuses: Array<{ id: string; text: string; tone?: string }> = [];
	const publishFailure = createMemorySyncFailurePublisher((id, text, options) => {
		statuses.push({ id, text, ...(options?.tone !== undefined ? { tone: options.tone } : {}) });
	});

	publishFailure("noop");
	assert.deepEqual(statuses, []);
	publishFailure("failed");
	publishFailure("failed");
	assert.deepEqual(statuses, [{ id: "memories-sync", text: "memory commit failed", tone: "warn" }]);
});

void test("non-git memory roots return a distinct result and publish one warning", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-memories-not-git-"));
	context.after(async () => rm(directory, { recursive: true, force: true }));
	const statuses: Array<{ id: string; text: string; tone?: string }> = [];
	const publishFailure = createMemorySyncFailurePublisher((id, text, options) => {
		statuses.push({ id, text, ...(options?.tone !== undefined ? { tone: options.tone } : {}) });
	});

	const result = await commitMemoryChanges({ repoRoot: directory, basename: "note.md" });
	assert.equal(result, "not-git-repo");
	publishFailure(result);
	publishFailure(result);
	assert.deepEqual(statuses, [
		{
			id: "memories-sync",
			text: "~/memories is not a git repository — memory writes are not being committed",
			tone: "warn",
		},
	]);
});
