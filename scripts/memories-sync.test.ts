import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { commitMemoryChanges, isMemoryPath } from "../extensions/memories-sync.ts";

const execFileAsync = promisify(execFile);

const git = async (repo: string, ...args: string[]): Promise<string> => {
	const result = await execFileAsync("git", args, { cwd: repo });
	return result.stdout.trim();
};

void test("path matching accepts only descendants of the memory directory", () => {
	const repo = "/tmp/memories";
	const memory = join(repo, "memory");
	assert.equal(isMemoryPath("memory/project/note.md", repo, memory), true);
	assert.equal(isMemoryPath("@memory/project/note.md", repo, memory), true);
	assert.equal(isMemoryPath(join(memory, "project", "note.md"), "/tmp", memory), true);
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

	assert.equal(await commitMemoryChanges({ repoRoot: repo, basename: "note.md" }), true);
	assert.equal(await git(repo, "log", "-1", "--pretty=%s"), "memory: note.md");
	assert.equal(await git(repo, "show", "--pretty=", "--name-only", "HEAD"), "memory/project/note.md");
	assert.equal(await git(repo, "diff", "--cached", "--name-only"), "outside.txt");
	assert.equal(await commitMemoryChanges({ repoRoot: repo, basename: "note.md" }), false);
});

void test("non-git memory roots are ignored", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-memories-not-git-"));
	context.after(async () => rm(directory, { recursive: true, force: true }));
	assert.equal(await commitMemoryChanges({ repoRoot: directory, basename: "note.md" }), false);
});
