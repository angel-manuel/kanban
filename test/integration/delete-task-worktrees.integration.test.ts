import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deleteTaskWorktrees } from "../../src/workspace/delete-task-worktrees";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed in ${cwd}`, result.stdout.trim(), result.stderr.trim()]
				.filter((part) => part.length > 0)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function createRepository(sandboxRoot: string): string {
	const repoPath = join(sandboxRoot, "repo");
	mkdirSync(repoPath, { recursive: true });
	runGit(repoPath, ["init"]);
	runGit(repoPath, ["config", "user.name", "Kanban Test"]);
	runGit(repoPath, ["config", "user.email", "kanban-test@example.com"]);
	writeFileSync(join(repoPath, ".gitignore"), "target/\n", "utf8");
	writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
	runGit(repoPath, ["add", ".gitignore", "README.md"]);
	runGit(repoPath, ["commit", "-m", "init"]);
	return repoPath;
}

describe("deleteTaskWorktrees", () => {
	it("removes the worktree of a finished task while leaving the shared build target intact", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-reclaim-worktree-");
			try {
				const repoPath = createRepository(sandboxRoot);

				// A pre-existing ignored build target is mirrored into the worktree as a symlink, so
				// reclamation has to unlink it rather than delete the shared artifacts behind it.
				const mainTargetPath = join(repoPath, "target");
				mkdirSync(mainTargetPath, { recursive: true });
				writeFileSync(join(mainTargetPath, "shared-artifact.bin"), "shared build output\n", "utf8");

				const taskId = `task-reclaim-${Date.now()}`;
				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(ensured.ok).toBe(true);
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}
				const worktreePath = ensured.path;
				if (process.platform !== "win32") {
					expect(lstatSync(join(worktreePath, "target")).isSymbolicLink()).toBe(true);
				}

				// Build output the task produced on its own, which is what reclamation frees up.
				const worktreeBuildPath = join(worktreePath, "build");
				mkdirSync(worktreeBuildPath, { recursive: true });
				writeFileSync(join(worktreeBuildPath, "task-artifact.bin"), "task build output\n", "utf8");

				await deleteTaskWorktrees({
					repoPath,
					taskIds: [taskId],
				});

				expect(existsSync(worktreePath)).toBe(false);
				expect(runGit(repoPath, ["worktree", "list"])).not.toContain(worktreePath);
				expect(existsSync(join(mainTargetPath, "shared-artifact.bin"))).toBe(true);
				expect(readFileSync(join(mainTargetPath, "shared-artifact.bin"), "utf8")).toBe("shared build output\n");
			} finally {
				cleanup();
			}
		});
	});

	it("keeps the finished task restorable from its captured patch", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-reclaim-restore-");
			try {
				const repoPath = createRepository(sandboxRoot);

				const taskId = `task-reclaim-restore-${Date.now()}`;
				const ensured = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				if (!ensured.ok || !ensured.path) {
					throw new Error("Task worktree was not created");
				}
				writeFileSync(join(ensured.path, "README.md"), "hello\nwork in progress\n", "utf8");

				await deleteTaskWorktrees({
					repoPath,
					taskIds: [taskId],
				});
				expect(existsSync(ensured.path)).toBe(false);

				const restored = await ensureTaskWorktreeIfDoesntExist({
					cwd: repoPath,
					taskId,
					baseRef: "HEAD",
				});
				expect(restored.ok).toBe(true);
				if (!restored.ok || !restored.path) {
					throw new Error("Task worktree was not restored");
				}
				expect(readFileSync(join(restored.path, "README.md"), "utf8")).toBe("hello\nwork in progress\n");
			} finally {
				cleanup();
			}
		});
	});

	it("is a silent no-op for a finished task that never had a worktree", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-reclaim-no-worktree-");
			try {
				const repoPath = createRepository(sandboxRoot);
				const warnings: string[] = [];

				await expect(
					deleteTaskWorktrees({
						repoPath,
						taskIds: ["task-never-started"],
						warn: (message) => warnings.push(message),
					}),
				).resolves.toBeUndefined();

				expect(warnings).toEqual([]);
			} finally {
				cleanup();
			}
		});
	});
});
