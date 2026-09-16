import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { getTaskColumnId } from "../../src/core/task-board-mutations";
import { createUnattendedTaskDriver, type DrivableWorkspace } from "../../src/server/unattended-task-driver";
import { loadWorkspaceBoardById, loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import { getGitSyncSummary } from "../../src/workspace/git-sync";
import { reclaimFinishedTaskWorktrees } from "../../src/workspace/reclaim-finished-task-worktrees";
import { ensureTaskWorktreeIfDoesntExist, getTaskWorkspaceInfo } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const TASK_ID = "ab12c";

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
	}
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

function createRepository(path: string): string {
	git(path, ["init", "--initial-branch=main"]);
	writeFileSync(join(path, "README.md"), "# fixture\n", "utf8");
	git(path, ["add", "."]);
	git(path, ["commit", "-m", "initial"]);
	return "main";
}

function unattendedCard(baseRef: string): RuntimeBoardCard {
	const now = Date.now();
	return {
		id: TASK_ID,
		title: "Refactor big files",
		prompt: "Refactor big files",
		startInPlanMode: false,
		autoReviewEnabled: true,
		autoReviewMode: "commit",
		unattended: true,
		baseRef,
		createdAt: now,
		updatedAt: now,
	};
}

function seedBoard(board: RuntimeBoardData, card: RuntimeBoardCard): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => (column.id === "in_progress" ? { ...column, cards: [card] } : column)),
	};
}

describe.sequential("unattended task driver integration", () => {
	it("drives a real task from in progress to done, committing and reclaiming the worktree", async () => {
		await withTemporaryHome(async () => {
			const { path: repoPath, cleanup } = createTempDir("kanban-repo-");
			try {
				const baseRef = createRepository(repoPath);
				const context = await loadWorkspaceContext(repoPath);
				const workspace: DrivableWorkspace = {
					workspaceId: context.workspaceId,
					workspacePath: context.repoPath,
				};

				await mutateWorkspaceState(repoPath, (state) => ({
					board: seedBoard(state.board, unattendedCard(baseRef)),
					value: null,
				}));

				const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: TASK_ID, baseRef });
				expect(ensured.ok).toBe(true);
				const worktreePath = ensured.path;
				if (worktreePath === null) {
					throw new Error("Task worktree was not created.");
				}
				expect(existsSync(worktreePath)).toBe(true);

				// Stand in for the agent: a real summary object, but no real pty.
				let sessionState: RuntimeTaskSessionSummary["state"] = "awaiting_review";
				const sentPrompts: string[] = [];
				const sessionSummary = (): RuntimeTaskSessionSummary => ({
					taskId: TASK_ID,
					state: sessionState,
					mode: "act",
					agentId: "claude",
					workspacePath: worktreePath,
					pid: 1234,
					startedAt: Date.now() - 60_000,
					updatedAt: Date.now() - 60_000,
					lastOutputAt: Date.now() - 60_000,
					reviewReason: "hook",
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				});

				const driver = createUnattendedTaskDriver({
					listWorkspaces: () => [workspace],
					loadBoard: async () => await loadWorkspaceBoardById(workspace.workspaceId),
					applyBoardChange: async (target, change) => {
						const mutation = await mutateWorkspaceState(target.workspacePath, (state) => {
							const nextBoard = change(state.board);
							if (nextBoard === null) {
								return {
									board: state.board,
									value: { previousBoard: state.board, nextBoard: state.board, sessions: state.sessions },
									save: false,
								};
							}
							return {
								board: nextBoard,
								value: { previousBoard: state.board, nextBoard, sessions: state.sessions },
							};
						});
						return { ...mutation.value, changed: mutation.saved };
					},
					resolveSessionSummary: () => sessionSummary(),
					probeChangedFiles: async (target, task) => {
						const info = await getTaskWorkspaceInfo({
							cwd: target.workspacePath,
							taskId: task.id,
							baseRef: task.baseRef,
						});
						return info.exists ? (await getGitSyncSummary(info.path)).changedFiles : null;
					},
					loadPromptTemplates: async () => ({ commitPromptTemplate: "Commit onto {{base_ref}}." }),
					sendPrompt: async (_target, _taskId, prompt) => {
						sentPrompts.push(prompt);
						return true;
					},
					stopSession: async () => {
						sessionState = "idle";
					},
					reclaimWorktrees: reclaimFinishedTaskWorktrees,
					broadcastWorkspaceStateUpdated: () => {},
					broadcastProjectsUpdated: () => {},
				});

				// The agent stopped with the card still in progress.
				await driver.scanOnce();
				expect(getTaskColumnId(await loadWorkspaceBoardById(workspace.workspaceId), TASK_ID)).toBe("review");

				// It left real work behind, so the driver asks for a commit.
				writeFileSync(join(worktreePath, "refactored.ts"), "export const value = 1;\n", "utf8");
				await driver.scanOnce();
				expect(sentPrompts).toEqual(["Commit onto main."]);

				// The agent commits; the working tree goes clean.
				git(worktreePath, ["add", "."]);
				git(worktreePath, ["commit", "-m", "refactor"]);
				await driver.scanOnce();

				expect(getTaskColumnId(await loadWorkspaceBoardById(workspace.workspaceId), TASK_ID)).toBe("trash");

				// Reclamation is deliberately fire-and-forget, so give it a moment to land.
				await vi.waitFor(() => {
					expect(existsSync(worktreePath)).toBe(false);
				});
			} finally {
				cleanup();
			}
		});
	});

	it("leaves a plan-mode task with no working changes alone", async () => {
		await withTemporaryHome(async () => {
			const { path: repoPath, cleanup } = createTempDir("kanban-repo-");
			try {
				const baseRef = createRepository(repoPath);
				const context = await loadWorkspaceContext(repoPath);
				const workspace: DrivableWorkspace = {
					workspaceId: context.workspaceId,
					workspacePath: context.repoPath,
				};
				await mutateWorkspaceState(repoPath, (state) => ({
					board: seedBoard(state.board, { ...unattendedCard(baseRef), startInPlanMode: true }),
					value: null,
				}));
				const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: TASK_ID, baseRef });
				expect(ensured.ok).toBe(true);
				const worktreePath = ensured.path;
				if (worktreePath === null) {
					throw new Error("Task worktree was not created.");
				}

				const sentPrompts: string[] = [];
				const driver = createUnattendedTaskDriver({
					listWorkspaces: () => [workspace],
					loadBoard: async () => await loadWorkspaceBoardById(workspace.workspaceId),
					applyBoardChange: async (target, change) => {
						const mutation = await mutateWorkspaceState(target.workspacePath, (state) => {
							const nextBoard = change(state.board);
							if (nextBoard === null) {
								return {
									board: state.board,
									value: { previousBoard: state.board, nextBoard: state.board, sessions: state.sessions },
									save: false,
								};
							}
							return {
								board: nextBoard,
								value: { previousBoard: state.board, nextBoard, sessions: state.sessions },
							};
						});
						return { ...mutation.value, changed: mutation.saved };
					},
					resolveSessionSummary: () => ({
						taskId: TASK_ID,
						state: "awaiting_review",
						mode: "plan",
						agentId: "claude",
						workspacePath: worktreePath,
						pid: 1234,
						startedAt: Date.now() - 60_000,
						updatedAt: Date.now() - 60_000,
						lastOutputAt: Date.now() - 60_000,
						reviewReason: "hook",
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
					}),
					probeChangedFiles: async (target, task) => {
						const info = await getTaskWorkspaceInfo({
							cwd: target.workspacePath,
							taskId: task.id,
							baseRef: task.baseRef,
						});
						return info.exists ? (await getGitSyncSummary(info.path)).changedFiles : null;
					},
					loadPromptTemplates: async () => ({ commitPromptTemplate: "Commit onto {{base_ref}}." }),
					sendPrompt: async (_target, _taskId, prompt) => {
						sentPrompts.push(prompt);
						return true;
					},
					stopSession: async () => {},
					reclaimWorktrees: reclaimFinishedTaskWorktrees,
					broadcastWorkspaceStateUpdated: () => {},
					broadcastProjectsUpdated: () => {},
				});

				await driver.scanOnce();
				await driver.scanOnce();

				// Moved to review, but never committed or completed: there was nothing to commit.
				expect(getTaskColumnId(await loadWorkspaceBoardById(workspace.workspaceId), TASK_ID)).toBe("review");
				expect(sentPrompts).toEqual([]);
				expect(existsSync(worktreePath)).toBe(true);
			} finally {
				cleanup();
			}
		});
	});
});
