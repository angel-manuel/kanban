import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorktreeDeleteResponse } from "../../../src/core/api-contract";

const taskWorktreeMocks = vi.hoisted(() => ({
	deleteTaskWorktree: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: taskWorktreeMocks.deleteTaskWorktree,
}));

import { deleteTaskWorktrees } from "../../../src/workspace/delete-task-worktrees";

function deleteFailure(error?: string): RuntimeWorktreeDeleteResponse {
	return {
		ok: false,
		removed: false,
		...(error ? { error } : {}),
	};
}

describe("deleteTaskWorktrees", () => {
	const warn = vi.fn();

	beforeEach(() => {
		warn.mockReset();
		taskWorktreeMocks.deleteTaskWorktree.mockReset();
		taskWorktreeMocks.deleteTaskWorktree.mockResolvedValue({ ok: true, removed: true });
	});

	it("deletes the worktree of every task it is given", async () => {
		await deleteTaskWorktrees({
			repoPath: "/tmp/repo",
			taskIds: ["task-1", "task-2"],
			warn,
		});

		expect(taskWorktreeMocks.deleteTaskWorktree.mock.calls.map(([options]) => options)).toEqual([
			{ repoPath: "/tmp/repo", taskId: "task-1" },
			{ repoPath: "/tmp/repo", taskId: "task-2" },
		]);
		expect(warn).not.toHaveBeenCalled();
	});

	it("accepts any iterable of task ids", async () => {
		await deleteTaskWorktrees({
			repoPath: "/tmp/repo",
			taskIds: new Set(["task-1"]),
		});

		expect(taskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledWith({
			repoPath: "/tmp/repo",
			taskId: "task-1",
		});
	});

	it("reports the reason a worktree could not be deleted", async () => {
		taskWorktreeMocks.deleteTaskWorktree.mockResolvedValueOnce(deleteFailure("worktree is locked"));

		await deleteTaskWorktrees({
			repoPath: "/tmp/repo",
			taskIds: ["task-1"],
			warn,
		});

		expect(warn).toHaveBeenCalledExactlyOnceWith("worktree is locked");
	});

	it("falls back to a per-task message when the failure carries no reason", async () => {
		taskWorktreeMocks.deleteTaskWorktree.mockResolvedValueOnce(deleteFailure());

		await deleteTaskWorktrees({
			repoPath: "/tmp/repo",
			taskIds: ["task-1"],
			context: "during shutdown",
			warn,
		});

		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'Could not delete task workspace for task "task-1" during shutdown.',
		);
	});

	it("reports an unexpected throw instead of rejecting, since callers do not await it", async () => {
		taskWorktreeMocks.deleteTaskWorktree.mockRejectedValueOnce(new Error("git exploded"));

		await expect(
			deleteTaskWorktrees({
				repoPath: "/tmp/repo",
				taskIds: ["task-1"],
				warn,
			}),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledExactlyOnceWith('Could not delete task workspace for task "task-1". git exploded');
	});

	it("still deletes the remaining worktrees after one of them fails", async () => {
		taskWorktreeMocks.deleteTaskWorktree.mockImplementation(async ({ taskId }: { taskId: string }) =>
			taskId === "task-1" ? deleteFailure("worktree is locked") : { ok: true, removed: true },
		);

		await deleteTaskWorktrees({
			repoPath: "/tmp/repo",
			taskIds: ["task-1", "task-2"],
			warn,
		});

		expect(taskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledExactlyOnceWith("worktree is locked");
	});
});
