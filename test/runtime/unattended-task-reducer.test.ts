import { describe, expect, it } from "vitest";

import {
	ACTION_TIMEOUT_MS,
	createInitialUnattendedTaskState,
	MAX_GIT_ACTIONS,
	MAX_RUN_MS,
	reduceUnattendedTask,
	type UnattendedTaskInput,
	type UnattendedTaskState,
} from "../../src/server/unattended-task-reducer";

const T0 = 1_000_000;

function state(overrides: Partial<UnattendedTaskState> = {}): UnattendedTaskState {
	return { ...createInitialUnattendedTaskState(T0), ...overrides };
}

function input(overrides: Partial<UnattendedTaskInput> = {}): UnattendedTaskInput {
	return {
		now: T0 + 1000,
		columnId: "in_progress",
		unattended: true,
		autoReviewEnabled: true,
		autoReviewMode: "commit",
		sessionState: "running",
		previousSessionState: null,
		sessionIsLive: true,
		sessionIsSettled: true,
		changedFiles: null,
		...overrides,
	};
}

describe("reduceUnattendedTask: handing control back", () => {
	it("releases when a human clears the flag", () => {
		const decision = reduceUnattendedTask(state({ phase: "awaiting_action" }), input({ unattended: false }));
		expect(decision.command).toMatchObject({ type: "release", reason: "not-unattended" });
		expect(decision.state.phase).toBe("idle");
	});

	it("releases when the card has left the board", () => {
		expect(reduceUnattendedTask(state(), input({ columnId: null })).command).toMatchObject({ type: "release" });
	});

	it("releases when the card is already in the finished column", () => {
		const decision = reduceUnattendedTask(state(), input({ columnId: "trash" }));
		expect(decision.command).toMatchObject({ type: "release", reason: "already-done" });
		expect(decision.state.phase).toBe("done");
	});

	it.each([["parked"], ["done"]] as const)("does nothing once %s", (phase) => {
		expect(reduceUnattendedTask(state({ phase }), input()).command).toMatchObject({ type: "none" });
	});
});

describe("reduceUnattendedTask: column moves", () => {
	it("moves to review when the agent stops", () => {
		const decision = reduceUnattendedTask(state({ phase: "running" }), input({ sessionState: "awaiting_review" }));
		expect(decision.command).toMatchObject({ type: "move_card", toColumnId: "review" });
		expect(decision.state.phase).toBe("awaiting_action");
	});

	it("moves back to in progress when the agent resumes", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action" }),
			input({ columnId: "review", sessionState: "running" }),
		);
		expect(decision.command).toMatchObject({ type: "move_card", toColumnId: "in_progress" });
		expect(decision.state.phase).toBe("running");
	});

	it("completes a newly interrupted task", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "running" }),
			input({ sessionState: "interrupted", previousSessionState: "running" }),
		);
		expect(decision.command).toMatchObject({ type: "complete_task", reason: "session-interrupted" });
	});

	it("does not re-complete a task that was already interrupted", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "running" }),
			input({ sessionState: "interrupted", previousSessionState: "interrupted" }),
		);
		expect(decision.command).not.toMatchObject({ type: "complete_task" });
	});
});

describe("reduceUnattendedTask: the arming rule", () => {
	const inReview = { columnId: "review", sessionState: "awaiting_review" } as const;

	it("asks for a worktree probe before deciding", () => {
		const decision = reduceUnattendedTask(state({ phase: "awaiting_action" }), input({ ...inReview }));
		expect(decision.command).toMatchObject({ type: "probe_worktree" });
	});

	// The case that would silently discard a run: a plan-mode task reaches review with a
	// clean tree while it is still planning.
	it("waits, rather than completing, when it has never seen working changes", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action", sawWorkingChanges: false }),
			input({ ...inReview, changedFiles: 0 }),
		);
		expect(decision.command).toMatchObject({ type: "none", reason: "not-armed-no-changes" });
		expect(decision.state.phase).toBe("awaiting_action");
	});

	it("sends the configured git action once working changes appear", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action" }),
			input({ ...inReview, changedFiles: 3, autoReviewMode: "pr" }),
		);
		expect(decision.command).toMatchObject({ type: "send_git_action", action: "pr" });
		expect(decision.state).toMatchObject({ phase: "git_action_sent", sawWorkingChanges: true, gitActionsSent: 1 });
	});

	it("completes once an armed task's tree goes clean", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "git_action_sent", sawWorkingChanges: true, gitActionsSent: 1 }),
			input({ ...inReview, changedFiles: 0 }),
		);
		expect(decision.command).toMatchObject({ type: "complete_task", reason: "git-action-complete" });
		expect(decision.state.phase).toBe("done");
	});

	it("leaves a task alone when auto-review is off", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action" }),
			input({ ...inReview, autoReviewEnabled: false, changedFiles: 5 }),
		);
		expect(decision.command).toMatchObject({ type: "none", reason: "auto-review-disabled" });
	});

	it("does not act while the session is still producing output", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action" }),
			input({ ...inReview, sessionIsSettled: false, changedFiles: 5 }),
		);
		expect(decision.command).toMatchObject({ type: "none", reason: "session-not-settled" });
	});

	it("waits for the tree to settle after sending, instead of resending", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "git_action_sent", sawWorkingChanges: true, gitActionsSent: 1, lastTransitionAt: T0 }),
			input({ ...inReview, changedFiles: 4, now: T0 + ACTION_TIMEOUT_MS }),
		);
		expect(decision.command).toMatchObject({ type: "none", reason: "awaiting-clean-tree" });
	});
});

describe("reduceUnattendedTask: bounds", () => {
	const inReview = { columnId: "review", sessionState: "awaiting_review" } as const;

	it("parks a run that exceeds the maximum duration", () => {
		const decision = reduceUnattendedTask(state({ phase: "running" }), input({ now: T0 + MAX_RUN_MS + 1 }));
		expect(decision.command).toMatchObject({ type: "park", reason: "max-run-exceeded" });
		expect(decision.state.phase).toBe("parked");
	});

	it("never injects into a session it cannot write to", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action" }),
			input({ ...inReview, changedFiles: 2, sessionIsLive: false }),
		);
		expect(decision.command).toMatchObject({ type: "park", reason: "session-not-live" });
	});

	it("parks instead of exceeding the git action cap", () => {
		const decision = reduceUnattendedTask(
			state({ phase: "awaiting_action", sawWorkingChanges: true, gitActionsSent: MAX_GIT_ACTIONS }),
			input({ ...inReview, changedFiles: 2 }),
		);
		expect(decision.command).toMatchObject({ type: "park", reason: "git-action-cap" });
	});

	it("retries once after a git action times out, then parks", () => {
		const timedOut = input({ ...inReview, changedFiles: 2, now: T0 + ACTION_TIMEOUT_MS + 1 });
		const retry = reduceUnattendedTask(
			state({ phase: "git_action_sent", sawWorkingChanges: true, gitActionsSent: 1, lastTransitionAt: T0 }),
			timedOut,
		);
		expect(retry.command).toMatchObject({ type: "send_git_action" });
		expect(retry.state.gitActionsSent).toBe(2);

		const parked = reduceUnattendedTask(
			{ ...retry.state, lastTransitionAt: T0 },
			input({ ...inReview, changedFiles: 2, now: T0 + ACTION_TIMEOUT_MS + 1 }),
		);
		expect(parked.command).toMatchObject({ type: "park", reason: "git-action-timeout" });
	});

	it("caps total injections across an entire run", () => {
		let current = state({ phase: "awaiting_action" });
		let sent = 0;
		for (let tick = 0; tick < MAX_GIT_ACTIONS + 3; tick += 1) {
			const decision = reduceUnattendedTask(
				{ ...current, lastTransitionAt: T0 },
				input({ ...inReview, changedFiles: 1, now: T0 + (tick + 1) * (ACTION_TIMEOUT_MS + 1) }),
			);
			if (decision.command.type === "send_git_action") {
				sent += 1;
			}
			current = decision.state;
		}
		expect(sent).toBe(MAX_GIT_ACTIONS);
		expect(current.phase).toBe("parked");
	});
});

describe("reduceUnattendedTask: the happy path end to end", () => {
	it("walks start -> review -> commit -> done", () => {
		let current = createInitialUnattendedTaskState(T0);
		const base = { unattended: true, autoReviewEnabled: true, autoReviewMode: "commit" } as const;

		let decision = reduceUnattendedTask(
			current,
			input({ ...base, columnId: "in_progress", sessionState: "running", now: T0 + 1 }),
		);
		expect(decision.command.type).toBe("none");
		current = decision.state;

		decision = reduceUnattendedTask(
			current,
			input({ ...base, columnId: "in_progress", sessionState: "awaiting_review", now: T0 + 2 }),
		);
		expect(decision.command).toMatchObject({ type: "move_card", toColumnId: "review" });
		current = decision.state;

		decision = reduceUnattendedTask(
			current,
			input({ ...base, columnId: "review", sessionState: "awaiting_review", changedFiles: 7, now: T0 + 3 }),
		);
		expect(decision.command).toMatchObject({ type: "send_git_action", action: "commit" });
		current = decision.state;

		decision = reduceUnattendedTask(
			current,
			input({ ...base, columnId: "review", sessionState: "awaiting_review", changedFiles: 0, now: T0 + 4 }),
		);
		expect(decision.command).toMatchObject({ type: "complete_task" });
		expect(decision.state.phase).toBe("done");
	});
});
