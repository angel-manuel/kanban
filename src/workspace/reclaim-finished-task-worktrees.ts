import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import { getTaskIdsEnteringFinishedColumn } from "../core/task-board-mutations";
import { isActiveTaskSessionState } from "../core/task-session-state";
import { deleteTaskWorktrees } from "./delete-task-worktrees";

// Reclaims the worktrees of tasks that just reached the Done column.
//
// A finished task keeps a full checkout on disk - build output included, which for
// build-heavy repos runs to tens of gigabytes - until something reclaims it. The client
// normally does that itself after stopping the agent, but the auto-move that files an
// interrupted task under "Done" skips that workflow entirely, and a dropped request or a
// closed tab loses it on the other routes. The board is persisted as a whole snapshot, so
// diffing it against the stored one is what lets the server catch every one of those cases
// in a single place.
//
// Both board-write paths need this: `saveWorkspaceState`'s `onBoardReplaced` hook, and the
// unattended task driver, which writes through `mutateWorkspaceState` and so never fires
// that hook.

export function selectReclaimableFinishedTaskIds(input: {
	previousBoard: RuntimeBoardData;
	nextBoard: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
}): string[] {
	return getTaskIdsEnteringFinishedColumn(input.previousBoard, input.nextBoard).filter(
		// The client saves the board optimistically and stops the agent afterwards, so a task
		// can arrive here while its process is still live in the worktree. Those are left to
		// the caller's own post-stop cleanup rather than pulled out from under a running
		// agent.
		(taskId) => !isActiveTaskSessionState(input.sessions[taskId] ?? null),
	);
}

// Fire-and-forget: removing a large worktree can take a while and must not hold the
// workspace lock or delay the caller's response. `deleteTaskWorktrees` never throws.
export function reclaimFinishedTaskWorktrees(input: {
	repoPath: string;
	previousBoard: RuntimeBoardData;
	nextBoard: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	warn?: (message: string) => void;
}): void {
	const finishedTaskIds = selectReclaimableFinishedTaskIds({
		previousBoard: input.previousBoard,
		nextBoard: input.nextBoard,
		sessions: input.sessions,
	});
	if (finishedTaskIds.length === 0) {
		return;
	}
	void deleteTaskWorktrees({
		repoPath: input.repoPath,
		taskIds: finishedTaskIds,
		warn: input.warn,
	});
}
