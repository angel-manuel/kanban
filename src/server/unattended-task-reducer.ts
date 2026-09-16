import type { RuntimeBoardColumnId, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TaskGitAction } from "../core/task-git-action-prompt";
import { envInt } from "./env-tunables";

// Pure decision logic for driving an unattended task's board lifecycle.
//
// This mirrors the two browser hooks that normally do this job - `use-board-interactions`
// for column moves and `use-review-auto-actions` for the commit/PR follow-up - so that a
// task started with no tab open still reaches Done. Keeping it pure is what makes the
// transition table testable without a pty, a git repo, or an SDK host.
//
// The load-bearing rule, inherited from the browser, is that a task is only *armed* for
// auto-done once we have actually seen working changes while it sits in review. A task
// started in plan mode cycles through review with a clean tree while it is still planning;
// completing it there would throw the run away before any code was written.

export const MAX_GIT_ACTIONS = envInt("KANBAN_UNATTENDED_MAX_GIT_ACTIONS", 2);
export const MAX_RUN_MS = envInt("KANBAN_UNATTENDED_MAX_RUN_MS", 4 * 60 * 60 * 1000);
export const ACTION_TIMEOUT_MS = envInt("KANBAN_UNATTENDED_ACTION_TIMEOUT_MS", 10 * 60 * 1000);

export type UnattendedTaskPhase =
	// Not yet observed doing anything; the task may still be starting up.
	| "idle"
	// The agent is working.
	| "running"
	// The agent stopped and the card is in review; decide what to do about it.
	| "awaiting_action"
	// A commit/PR prompt has been injected; waiting for the tree to go clean.
	| "git_action_sent"
	// Handed back to a human. The driver stops touching the task.
	| "parked"
	// Reached the finished column.
	| "done";

export interface UnattendedTaskState {
	phase: UnattendedTaskPhase;
	action: TaskGitAction | null;
	// Mirrors the browser's arming rule. Once true it stays true for the run.
	sawWorkingChanges: boolean;
	gitActionsSent: number;
	startedAt: number;
	lastTransitionAt: number;
}

export interface UnattendedTaskInput {
	now: number;
	columnId: RuntimeBoardColumnId | null;
	unattended: boolean;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskGitAction;
	sessionState: RuntimeTaskSessionSummary["state"] | null;
	previousSessionState: RuntimeTaskSessionSummary["state"] | null;
	// Whether input can actually be written to this session right now.
	sessionIsLive: boolean;
	// False while the session is still producing output, so a mid-turn lull never triggers
	// a commit prompt.
	sessionIsSettled: boolean;
	// null means "not probed on this tick" - the driver only pays for a git status when the
	// reducer asks for one.
	changedFiles: number | null;
}

export type UnattendedTaskCommand =
	| { type: "none"; reason: string }
	| { type: "move_card"; toColumnId: RuntimeBoardColumnId; reason: string }
	| { type: "probe_worktree"; reason: string }
	| { type: "send_git_action"; action: TaskGitAction; reason: string }
	| { type: "complete_task"; reason: string }
	| { type: "park"; reason: string }
	// Stop tracking: the card is gone, or a human took it back.
	| { type: "release"; reason: string };

export interface UnattendedTaskDecision {
	state: UnattendedTaskState;
	command: UnattendedTaskCommand;
}

export function createInitialUnattendedTaskState(now: number): UnattendedTaskState {
	return {
		phase: "idle",
		action: null,
		sawWorkingChanges: false,
		gitActionsSent: 0,
		startedAt: now,
		lastTransitionAt: now,
	};
}

function transition(
	state: UnattendedTaskState,
	now: number,
	patch: Partial<UnattendedTaskState>,
	command: UnattendedTaskCommand,
): UnattendedTaskDecision {
	return {
		state: { ...state, ...patch, lastTransitionAt: now },
		command,
	};
}

function stay(state: UnattendedTaskState, command: UnattendedTaskCommand): UnattendedTaskDecision {
	return { state, command };
}

export function reduceUnattendedTask(state: UnattendedTaskState, input: UnattendedTaskInput): UnattendedTaskDecision {
	const { now } = input;

	// A human cleared the flag, or the card left the board entirely.
	if (!input.unattended) {
		return transition(state, now, { phase: "idle" }, { type: "release", reason: "not-unattended" });
	}
	if (input.columnId === null) {
		return transition(state, now, { phase: "done" }, { type: "release", reason: "card-missing" });
	}
	if (input.columnId === "trash") {
		return transition(state, now, { phase: "done" }, { type: "release", reason: "already-done" });
	}
	if (state.phase === "parked" || state.phase === "done") {
		return stay(state, { type: "none", reason: `terminal-phase-${state.phase}` });
	}

	// Hard ceiling on a single unattended run. Everything below can legitimately wait, so
	// this is the only thing that guarantees a stuck task is eventually handed back.
	if (now - state.startedAt > MAX_RUN_MS) {
		return transition(state, now, { phase: "parked" }, { type: "park", reason: "max-run-exceeded" });
	}

	// A crashed or killed session is finished work; the browser files these under Done too.
	if (input.sessionState === "interrupted" && input.previousSessionState !== "interrupted") {
		return transition(state, now, { phase: "done" }, { type: "complete_task", reason: "session-interrupted" });
	}

	// The agent picked the task back up (or a retry restarted it).
	if (input.sessionState === "running") {
		if (input.columnId === "review") {
			return transition(
				state,
				now,
				{ phase: "running" },
				{ type: "move_card", toColumnId: "in_progress", reason: "session-resumed" },
			);
		}
		if (state.phase === "git_action_sent") {
			return stay(state, { type: "none", reason: "git-action-in-progress" });
		}
		return transition(state, now, { phase: "running" }, { type: "none", reason: "session-running" });
	}

	// The agent stopped. Get the card into review before deciding anything else.
	if (input.sessionState === "awaiting_review" && input.columnId === "in_progress") {
		return transition(
			state,
			now,
			{ phase: "awaiting_action" },
			{ type: "move_card", toColumnId: "review", reason: "session-awaiting-review" },
		);
	}

	if (input.columnId !== "review") {
		return stay(state, { type: "none", reason: `nothing-to-do-in-${input.columnId}` });
	}

	if (input.sessionState !== "awaiting_review") {
		return stay(state, { type: "none", reason: `session-${input.sessionState ?? "missing"}` });
	}
	if (!input.sessionIsSettled) {
		return stay(state, { type: "none", reason: "session-not-settled" });
	}

	// Without auto-review the user explicitly asked to inspect this themselves.
	if (!input.autoReviewEnabled) {
		return stay(state, { type: "none", reason: "auto-review-disabled" });
	}

	if (input.changedFiles === null) {
		return stay(state, { type: "probe_worktree", reason: "need-changed-files" });
	}

	if (input.changedFiles === 0) {
		// Armed earlier, tree is clean now: the commit or PR landed.
		if (state.sawWorkingChanges) {
			return transition(state, now, { phase: "done" }, { type: "complete_task", reason: "git-action-complete" });
		}
		// Never armed. Most often a plan-mode task that has finished planning but not yet
		// written anything - leave it be and let MAX_RUN_MS decide if it never progresses.
		return stay(state, { type: "none", reason: "not-armed-no-changes" });
	}

	// From here the tree is dirty.
	if (state.phase === "git_action_sent") {
		if (now - state.lastTransitionAt <= ACTION_TIMEOUT_MS) {
			return stay(state, { type: "none", reason: "awaiting-clean-tree" });
		}
		if (state.gitActionsSent >= MAX_GIT_ACTIONS) {
			return transition(state, now, { phase: "parked" }, { type: "park", reason: "git-action-timeout" });
		}
		// Fall through to a retry below.
	}

	if (!input.sessionIsLive) {
		return transition(state, now, { phase: "parked" }, { type: "park", reason: "session-not-live" });
	}
	if (state.gitActionsSent >= MAX_GIT_ACTIONS) {
		return transition(state, now, { phase: "parked" }, { type: "park", reason: "git-action-cap" });
	}

	return transition(
		state,
		now,
		{
			phase: "git_action_sent",
			action: input.autoReviewMode,
			sawWorkingChanges: true,
			gitActionsSent: state.gitActionsSent + 1,
		},
		{ type: "send_git_action", action: input.autoReviewMode, reason: "working-changes-present" },
	);
}
