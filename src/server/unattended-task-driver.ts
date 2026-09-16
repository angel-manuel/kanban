import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	getTaskColumnId,
	moveTaskToColumn,
	setTaskUnattended,
	trashTaskAndGetReadyLinkedTaskIds,
} from "../core/task-board-mutations";
import {
	buildTaskGitActionPrompt,
	type TaskGitAction,
	type TaskGitPromptTemplates,
} from "../core/task-git-action-prompt";
import { isTaskSessionLive } from "../core/task-session-state";
import { envInt, isEnvSwitchEnabled } from "./env-tunables";
import {
	createInitialUnattendedTaskState,
	reduceUnattendedTask,
	type UnattendedTaskCommand,
	type UnattendedTaskState,
} from "./unattended-task-reducer";

// Drives the board lifecycle of tasks flagged `unattended`, so a task started with no
// browser open still reaches Done with its work committed.
//
// Normally the browser does this: `use-board-interactions` moves the card as the session
// state changes, and `use-review-auto-actions` injects the commit/PR prompt and files the
// card under Done once the worktree goes clean. With no tab open neither runs, so a
// scheduled overnight task would sit in "In Progress" forever, uncommitted, holding on to
// a full checkout. This service stands in for both.
//
// The decision logic lives in `unattended-task-reducer.ts` and is pure; everything here is
// I/O and bookkeeping. Structured after `stall-watchdog.ts`, which solves a similar
// problem and established the shape.
//
// Driver state is in-memory. After a restart the reducer re-derives its phase from the
// board column and the live session state, but the git-action counter resets - so a
// restart part-way through a follow-up can cost at most MAX_GIT_ACTIONS extra injections.
// Persisting the counter would mean another board field, and a restart already implies a
// human or the updater was involved.

export const POLL_MS = envInt("KANBAN_UNATTENDED_POLL_MS", 20_000);
export const SETTLE_MS = envInt("KANBAN_UNATTENDED_SETTLE_MS", 10_000);
export const MAX_ACTIVE_PER_WORKSPACE = envInt("KANBAN_UNATTENDED_MAX_ACTIVE", 8);

export function isUnattendedTaskDriverEnabled(): boolean {
	return isEnvSwitchEnabled("KANBAN_UNATTENDED_DRIVER");
}

export interface DrivableWorkspace {
	workspaceId: string;
	workspacePath: string;
}

export interface BoardChangeResult {
	previousBoard: RuntimeBoardData;
	nextBoard: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	changed: boolean;
}

export interface UnattendedTaskDriverDependencies {
	listWorkspaces: () => DrivableWorkspace[];
	loadBoard: (workspace: DrivableWorkspace) => Promise<RuntimeBoardData>;
	/**
	 * Applies a board change under the workspace lock. `change` returns null to abort
	 * without writing, so a card that moved since the scan cannot be clobbered.
	 */
	applyBoardChange: (
		workspace: DrivableWorkspace,
		change: (board: RuntimeBoardData) => RuntimeBoardData | null,
	) => Promise<BoardChangeResult>;
	resolveSessionSummary: (workspace: DrivableWorkspace, taskId: string) => RuntimeTaskSessionSummary | null;
	/** Working-tree file count for the task worktree, or null when it cannot be read. */
	probeChangedFiles: (workspace: DrivableWorkspace, task: RuntimeBoardCard) => Promise<number | null>;
	loadPromptTemplates: (workspace: DrivableWorkspace) => Promise<TaskGitPromptTemplates>;
	/** Returns false when there was no live session to write to, so no budget is spent. */
	sendPrompt: (workspace: DrivableWorkspace, taskId: string, prompt: string) => Promise<boolean>;
	stopSession: (workspace: DrivableWorkspace, taskId: string) => Promise<void>;
	reclaimWorktrees: (input: {
		repoPath: string;
		previousBoard: RuntimeBoardData;
		nextBoard: RuntimeBoardData;
		sessions: Record<string, RuntimeTaskSessionSummary>;
	}) => void;
	broadcastWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	notifyReviewReady?: (workspaceId: string, taskId: string) => void;
	now?: () => number;
	log?: (message: string) => void;
}

export interface UnattendedTaskDriver {
	start: () => void;
	scanOnce: () => Promise<void>;
	close: () => void;
}

function findUnattendedCards(board: RuntimeBoardData): RuntimeBoardCard[] {
	const cards: RuntimeBoardCard[] = [];
	for (const column of board.columns) {
		if (column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			if (card.unattended === true) {
				cards.push(card);
			}
		}
	}
	return cards;
}

function resolveAutoReviewMode(card: RuntimeBoardCard): TaskGitAction {
	return card.autoReviewMode === "pr" ? "pr" : "commit";
}

function isSessionSettled(summary: RuntimeTaskSessionSummary | null, now: number): boolean {
	if (!summary) {
		return true;
	}
	const lastActivityAt = summary.lastOutputAt ?? summary.updatedAt;
	return now - lastActivityAt >= SETTLE_MS;
}

export function createUnattendedTaskDriver(deps: UnattendedTaskDriverDependencies): UnattendedTaskDriver {
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	const stateByTaskKey = new Map<string, UnattendedTaskState>();
	const previousSessionStateByTaskKey = new Map<string, RuntimeTaskSessionSummary["state"] | null>();
	let timer: NodeJS.Timeout | null = null;
	let scanning = false;

	const taskKey = (workspaceId: string, taskId: string): string => `${workspaceId}::${taskId}`;

	const forget = (key: string): void => {
		stateByTaskKey.delete(key);
		previousSessionStateByTaskKey.delete(key);
	};

	const broadcast = (workspace: DrivableWorkspace): void => {
		void deps.broadcastWorkspaceStateUpdated(workspace.workspaceId, workspace.workspacePath);
		void deps.broadcastProjectsUpdated(workspace.workspaceId);
	};

	const runCommand = async (
		workspace: DrivableWorkspace,
		card: RuntimeBoardCard,
		command: UnattendedTaskCommand,
	): Promise<void> => {
		switch (command.type) {
			case "none":
			case "probe_worktree":
				return;

			case "release":
				forget(taskKey(workspace.workspaceId, card.id));
				return;

			case "move_card": {
				const target = command.toColumnId;
				const result = await deps.applyBoardChange(workspace, (board) => {
					if (getTaskColumnId(board, card.id) === target) {
						return null;
					}
					const moved = moveTaskToColumn(board, card.id, target);
					return moved.moved ? moved.board : null;
				});
				if (result.changed) {
					broadcast(workspace);
					log(`task ${card.id}: moved to ${target} (${command.reason})`);
					if (target === "review") {
						deps.notifyReviewReady?.(workspace.workspaceId, card.id);
					}
				}
				return;
			}

			case "send_git_action": {
				const templates = await deps.loadPromptTemplates(workspace);
				const prompt = buildTaskGitActionPrompt({
					action: command.action,
					baseRef: card.baseRef,
					templates,
				});
				const delivered = await deps.sendPrompt(workspace, card.id, prompt);
				if (!delivered) {
					// No live session: roll the budget back so a transient miss does not burn a
					// slot, and let the next scan park the task if it is really gone.
					const key = taskKey(workspace.workspaceId, card.id);
					const current = stateByTaskKey.get(key);
					if (current) {
						stateByTaskKey.set(key, {
							...current,
							phase: "awaiting_action",
							gitActionsSent: Math.max(0, current.gitActionsSent - 1),
						});
					}
					log(`task ${card.id}: could not deliver ${command.action} prompt, no live session`);
					return;
				}
				log(`task ${card.id}: sent ${command.action} prompt (${command.reason})`);
				return;
			}

			case "complete_task": {
				await deps.stopSession(workspace, card.id).catch((error: unknown) => {
					log(`task ${card.id}: could not stop session: ${String(error)}`);
				});
				const result = await deps.applyBoardChange(workspace, (board) => {
					const columnId = getTaskColumnId(board, card.id);
					if (columnId === null || columnId === "trash") {
						return null;
					}
					const trashed = trashTaskAndGetReadyLinkedTaskIds(board, card.id);
					if (!trashed.moved) {
						return null;
					}
					if (trashed.readyTaskIds.length > 0) {
						// The browser and the CLI auto-start these; this driver cannot yet, so make
						// the gap visible rather than leaving the tasks silently blocked.
						log(
							`task ${card.id}: unblocked backlog tasks ${trashed.readyTaskIds.join(", ")} - start them manually`,
						);
					}
					return trashed.board;
				});
				forget(taskKey(workspace.workspaceId, card.id));
				if (result.changed) {
					broadcast(workspace);
					deps.reclaimWorktrees({
						repoPath: workspace.workspacePath,
						previousBoard: result.previousBoard,
						nextBoard: result.nextBoard,
						sessions: result.sessions,
					});
					log(`task ${card.id}: completed (${command.reason})`);
				}
				return;
			}

			case "park": {
				// Leave the card in review for a human, and clear the flag so nothing picks it
				// up again. The agent is deliberately left running and the worktree kept.
				const result = await deps.applyBoardChange(workspace, (board) => {
					const columnId = getTaskColumnId(board, card.id);
					if (columnId === null) {
						return null;
					}
					let next = board;
					if (columnId === "in_progress") {
						const moved = moveTaskToColumn(next, card.id, "review");
						if (moved.moved) {
							next = moved.board;
						}
					}
					const released = setTaskUnattended(next, card.id, false);
					return released.updated || next !== board ? released.board : null;
				});
				forget(taskKey(workspace.workspaceId, card.id));
				if (result.changed) {
					broadcast(workspace);
					deps.notifyReviewReady?.(workspace.workspaceId, card.id);
				}
				log(`task ${card.id}: parked for review (${command.reason})`);
				return;
			}
		}
	};

	const evaluateTask = async (
		workspace: DrivableWorkspace,
		board: RuntimeBoardData,
		card: RuntimeBoardCard,
	): Promise<void> => {
		const key = taskKey(workspace.workspaceId, card.id);
		const currentState = stateByTaskKey.get(key) ?? createInitialUnattendedTaskState(now());
		const summary = deps.resolveSessionSummary(workspace, card.id);
		const previousSessionState = previousSessionStateByTaskKey.get(key) ?? null;

		const baseInput = {
			now: now(),
			columnId: getTaskColumnId(board, card.id),
			unattended: card.unattended === true,
			autoReviewEnabled: card.autoReviewEnabled === true,
			autoReviewMode: resolveAutoReviewMode(card),
			sessionState: summary?.state ?? null,
			previousSessionState,
			sessionIsLive: isTaskSessionLive(summary),
			sessionIsSettled: isSessionSettled(summary, now()),
			changedFiles: null,
		};

		let decision = reduceUnattendedTask(currentState, baseInput);
		if (decision.command.type === "probe_worktree") {
			const changedFiles = await deps.probeChangedFiles(workspace, card);
			if (changedFiles === null) {
				log(`task ${card.id}: could not read worktree changes`);
				return;
			}
			decision = reduceUnattendedTask(currentState, { ...baseInput, changedFiles });
		}

		stateByTaskKey.set(key, decision.state);
		previousSessionStateByTaskKey.set(key, summary?.state ?? null);
		await runCommand(workspace, card, decision.command);
	};

	const scanOnce = async (): Promise<void> => {
		if (scanning) {
			return;
		}
		scanning = true;
		try {
			for (const workspace of deps.listWorkspaces()) {
				try {
					const board = await deps.loadBoard(workspace);
					const cards = findUnattendedCards(board);
					if (cards.length > MAX_ACTIVE_PER_WORKSPACE) {
						log(
							`workspace ${workspace.workspaceId}: ${cards.length} unattended tasks, driving the first ${MAX_ACTIVE_PER_WORKSPACE}`,
						);
					}
					for (const card of cards.slice(0, MAX_ACTIVE_PER_WORKSPACE)) {
						try {
							await evaluateTask(workspace, board, card);
						} catch (error) {
							log(`error evaluating task ${card.id}: ${String(error)}`);
						}
					}
				} catch (error) {
					log(`error scanning workspace ${workspace.workspaceId}: ${String(error)}`);
				}
			}
		} finally {
			scanning = false;
		}
	};

	return {
		start: () => {
			if (timer || !isUnattendedTaskDriverEnabled()) {
				return;
			}
			timer = setInterval(() => {
				void scanOnce();
			}, POLL_MS);
			timer.unref();
			log(`started (poll=${POLL_MS}ms, settle=${SETTLE_MS}ms, maxActive=${MAX_ACTIVE_PER_WORKSPACE})`);
		},
		scanOnce,
		close: () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			stateByTaskKey.clear();
			previousSessionStateByTaskKey.clear();
		},
	};
}
