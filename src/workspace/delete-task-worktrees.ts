import { deleteTaskWorktree } from "./task-worktree";

export interface DeleteTaskWorktreesOptions {
	repoPath: string;
	taskIds: Iterable<string>;
	/** Phrase appended to the fallback failure message, e.g. "during shutdown". */
	context?: string;
	warn?: (message: string) => void;
}

/**
 * Removes the worktree checkouts of several tasks at once, reporting failures instead of
 * throwing so a caller's own work (shutdown, project removal, a board state transition) is
 * never blocked by cleanup.
 *
 * `deleteTaskWorktree` captures a patch of each worktree's uncommitted work before removing
 * anything, so a task whose worktree is reclaimed is rebuilt from that patch the next time it
 * is started. Removal is also symlink-safe: `git worktree remove` and `fs.rm` unlink a
 * worktree's mirrored ignored paths instead of following them, so a build target shared with
 * the main checkout survives.
 */
export async function deleteTaskWorktrees(options: DeleteTaskWorktreesOptions): Promise<void> {
	const contextSuffix = options.context ? ` ${options.context}` : "";
	const failures = await Promise.all(
		Array.from(options.taskIds, async (taskId) => {
			const fallbackMessage = `Could not delete task workspace for task "${taskId}"${contextSuffix}.`;
			try {
				const deleted = await deleteTaskWorktree({
					repoPath: options.repoPath,
					taskId,
				});
				return deleted.ok ? null : (deleted.error ?? fallbackMessage);
			} catch (error) {
				// deleteTaskWorktree reports failures rather than throwing, but callers fire this
				// helper without awaiting it, so an unexpected throw must not surface as an
				// unhandled rejection.
				const message = error instanceof Error ? error.message : String(error);
				return `${fallbackMessage} ${message}`;
			}
		}),
	);
	if (!options.warn) {
		return;
	}
	for (const failure of failures) {
		if (failure !== null) {
			options.warn(failure);
		}
	}
}
