import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { selectReclaimableFinishedTaskIds } from "../../../src/workspace/reclaim-finished-task-worktrees";

function card(id: string): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function board(placement: Partial<Record<"backlog" | "in_progress" | "review" | "trash", string[]>>): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: (placement.backlog ?? []).map(card) },
			{ id: "in_progress", title: "In Progress", cards: (placement.in_progress ?? []).map(card) },
			{ id: "review", title: "Review", cards: (placement.review ?? []).map(card) },
			{ id: "trash", title: "Done", cards: (placement.trash ?? []).map(card) },
		],
		dependencies: [],
	};
}

function session(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		mode: "act",
		agentId: "claude",
		workspacePath: "/tmp/repo",
		pid: state === "running" ? 123 : null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("selectReclaimableFinishedTaskIds", () => {
	it("returns tasks that just entered the finished column", () => {
		expect(
			selectReclaimableFinishedTaskIds({
				previousBoard: board({ review: ["a"] }),
				nextBoard: board({ trash: ["a"] }),
				sessions: {},
			}),
		).toEqual(["a"]);
	});

	it("ignores tasks that were already finished", () => {
		expect(
			selectReclaimableFinishedTaskIds({
				previousBoard: board({ trash: ["a"] }),
				nextBoard: board({ trash: ["a"] }),
				sessions: {},
			}),
		).toEqual([]);
	});

	it("ignores tasks that moved between unfinished columns", () => {
		expect(
			selectReclaimableFinishedTaskIds({
				previousBoard: board({ in_progress: ["a"] }),
				nextBoard: board({ review: ["a"] }),
				sessions: {},
			}),
		).toEqual([]);
	});

	// The agent may still be live in the worktree when the board save lands; pulling the
	// checkout out from under it would break the running session.
	it.each([["running"], ["awaiting_review"]] as const)("skips a finished task whose session is %s", (state) => {
		expect(
			selectReclaimableFinishedTaskIds({
				previousBoard: board({ review: ["a"] }),
				nextBoard: board({ trash: ["a"] }),
				sessions: { a: session("a", state) },
			}),
		).toEqual([]);
	});

	it.each([["idle"], ["failed"], ["interrupted"]] as const)(
		"reclaims a finished task whose session is %s",
		(state) => {
			expect(
				selectReclaimableFinishedTaskIds({
					previousBoard: board({ review: ["a"] }),
					nextBoard: board({ trash: ["a"] }),
					sessions: { a: session("a", state) },
				}),
			).toEqual(["a"]);
		},
	);

	it("reclaims only the newly finished tasks when several move at once", () => {
		expect(
			selectReclaimableFinishedTaskIds({
				previousBoard: board({ review: ["a", "b"], trash: ["c"] }),
				nextBoard: board({ trash: ["a", "b", "c"] }),
				sessions: { a: session("a", "running") },
			}),
		).toEqual(["b"]);
	});
});
