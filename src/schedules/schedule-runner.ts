import type {
	RuntimeBoardCard,
	RuntimeSchedule,
	RuntimeScheduleRunStatus,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { addTaskToColumn, getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { ensureTaskWorktreeIfDoesntExist } from "../workspace/task-worktree";
import { decideScheduleOverlap } from "./schedule-firing";

// Turns a due schedule into a running task.
//
// This is the server-side twin of `kanban task start`, in the same order: create the card,
// ensure the worktree, start the session, then move the card to In Progress. The card is
// created in Backlog rather than straight into In Progress so that a failed worktree or a
// missing agent binary leaves something the user can inspect and start by hand, instead of
// a card sitting in In Progress with no session behind it.
//
// The scheduler runs inside the server process, so this calls the runtime API directly
// rather than making an HTTP request back to itself.

export interface ScheduleRunContext {
	workspaceId: string;
	workspacePath: string;
}

export interface ScheduleRunOutcome {
	status: RuntimeScheduleRunStatus;
	taskId: string | null;
	error: string | null;
}

export interface CreateScheduleRunnerDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<unknown>;
	startTaskSession: (
		scope: ScheduleRunContext,
		input: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	ensureTaskWorktree: typeof ensureTaskWorktreeIfDoesntExist;
	broadcastWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	now?: () => number;
	randomUuid?: () => string;
	log?: (message: string) => void;
}

type MaterializeResult = { skipped: true } | { skipped: false; task: RuntimeBoardCard; baseRef: string };

export interface ScheduleRunner {
	runSchedule: (
		context: ScheduleRunContext,
		schedule: RuntimeSchedule,
		options?: { ignoreOverlap?: boolean },
	) => Promise<ScheduleRunOutcome>;
}

/**
 * Resolves the branch a scheduled task should be cut from.
 *
 * Note this prefers the default branch, unlike the interactive `task create` path which
 * prefers the currently checked-out branch. A job firing at 02:00 must not silently build
 * on whatever the user happened to leave checked out the evening before.
 */
export function resolveScheduleBaseRef(schedule: RuntimeSchedule, state: RuntimeWorkspaceStateResponse): string {
	const fixed = schedule.task.baseRef?.trim();
	if (fixed) {
		return fixed;
	}
	return state.git.defaultBranch ?? state.git.currentBranch ?? state.git.branches[0] ?? "";
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createScheduleRunner(deps: CreateScheduleRunnerDependencies): ScheduleRunner {
	const now = deps.now ?? (() => Date.now());
	const randomUuid = deps.randomUuid ?? (() => globalThis.crypto.randomUUID());
	const log = deps.log ?? (() => {});

	const runSchedule = async (
		context: ScheduleRunContext,
		schedule: RuntimeSchedule,
		options?: { ignoreOverlap?: boolean },
	): Promise<ScheduleRunOutcome> => {
		try {
			// A schedule can target a project nobody opened this session, so the manager may
			// not exist yet. This also hydrates persisted sessions for the overlap check.
			await deps.ensureTerminalManagerForWorkspace(context.workspaceId, context.workspacePath);

			const created = await mutateWorkspaceState<MaterializeResult>(context.workspacePath, (state) => {
				if (!options?.ignoreOverlap && schedule.lastTaskId) {
					const overlap = decideScheduleOverlap({
						policy: schedule.overlapPolicy,
						lastTaskColumnId: getTaskColumnId(state.board, schedule.lastTaskId),
						lastTaskSessionState: state.sessions[schedule.lastTaskId]?.state ?? null,
					});
					if (overlap === "skip_overlap") {
						return { board: state.board, value: { skipped: true }, save: false };
					}
				}

				const baseRef = resolveScheduleBaseRef(schedule, state);
				if (!baseRef) {
					throw new Error("Could not determine a base branch for this workspace.");
				}

				const result = addTaskToColumn(
					state.board,
					"backlog",
					{
						title: schedule.task.title,
						prompt: schedule.task.prompt,
						startInPlanMode: schedule.task.startInPlanMode,
						// A scheduled run nobody is watching has to finish the job itself, so the
						// commit/PR follow-up is always on and the unattended driver owns the card.
						autoReviewEnabled: true,
						autoReviewMode: schedule.task.autoReviewMode,
						agentId: schedule.task.agentId,
						clineSettings: schedule.task.clineSettings,
						unattended: true,
						baseRef,
					},
					randomUuid,
					now(),
				);
				return { board: result.board, value: { skipped: false, task: result.task, baseRef } };
			});

			if (created.value.skipped) {
				log(`schedule ${schedule.id}: skipped, previous task ${schedule.lastTaskId} is still active`);
				return { status: "skipped_overlap", taskId: schedule.lastTaskId, error: null };
			}

			const { task, baseRef } = created.value;
			void deps.broadcastWorkspaceStateUpdated(context.workspaceId, context.workspacePath);

			const ensured = await deps.ensureTaskWorktree({
				cwd: context.workspacePath,
				taskId: task.id,
				baseRef,
			});
			if (!ensured.ok) {
				const error = ensured.error ?? "Task worktree setup failed.";
				log(`schedule ${schedule.id}: worktree setup failed for task ${task.id}: ${error}`);
				return { status: "failed", taskId: task.id, error };
			}

			const started = await deps.startTaskSession(context, {
				taskId: task.id,
				prompt: task.prompt,
				taskTitle: task.title,
				startInPlanMode: task.startInPlanMode,
				baseRef,
				agentId: schedule.task.agentId,
				clineSettings: schedule.task.clineSettings,
			});
			if (!started.ok) {
				const error = started.error ?? "Could not start the task session.";
				log(`schedule ${schedule.id}: could not start task ${task.id}: ${error}`);
				return { status: "failed", taskId: task.id, error };
			}

			await mutateWorkspaceState(context.workspacePath, (state) => {
				const moved = moveTaskToColumn(state.board, task.id, "in_progress");
				return moved.moved ? { board: moved.board, value: null } : { board: state.board, value: null, save: false };
			});
			void deps.broadcastWorkspaceStateUpdated(context.workspaceId, context.workspacePath);
			void deps.broadcastProjectsUpdated(context.workspaceId);

			log(`schedule ${schedule.id}: started task ${task.id} on ${baseRef}`);
			return { status: "ok", taskId: task.id, error: null };
		} catch (error) {
			const message = toErrorMessage(error);
			log(`schedule ${schedule.id}: run failed: ${message}`);
			return { status: "failed", taskId: null, error: message };
		}
	};

	return { runSchedule };
}
