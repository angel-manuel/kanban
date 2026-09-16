import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { getTaskColumnId } from "../../src/core/task-board-mutations";
import {
	createUnattendedTaskDriver,
	type DrivableWorkspace,
	SETTLE_MS,
	type UnattendedTaskDriverDependencies,
} from "../../src/server/unattended-task-driver";

const WORKSPACE: DrivableWorkspace = { workspaceId: "ws-1", workspacePath: "/tmp/repo" };
const T0 = 5_000_000;

function card(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Refactor big files",
		prompt: "Refactor big files",
		startInPlanMode: false,
		autoReviewEnabled: true,
		autoReviewMode: "commit",
		unattended: true,
		baseRef: "main",
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

function boardWith(
	columnId: "backlog" | "in_progress" | "review" | "trash",
	cards: RuntimeBoardCard[],
): RuntimeBoardData {
	return {
		columns: (["backlog", "in_progress", "review", "trash"] as const).map((id) => ({
			id,
			title: id,
			cards: id === columnId ? cards : [],
		})),
		dependencies: [],
	};
}

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		mode: "act",
		agentId: "claude",
		workspacePath: WORKSPACE.workspacePath,
		pid: 4242,
		startedAt: T0,
		updatedAt: T0,
		lastOutputAt: T0,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

interface Harness {
	deps: UnattendedTaskDriverDependencies;
	board: () => RuntimeBoardData;
	setBoard: (board: RuntimeBoardData) => void;
	setSummary: (summary: RuntimeTaskSessionSummary | null) => void;
	setChangedFiles: (count: number | null) => void;
	advance: (ms: number) => void;
	sentPrompts: string[];
	logs: string[];
	reclaimed: number;
	stopped: string[];
}

function createHarness(initialBoard: RuntimeBoardData): Harness {
	let board = initialBoard;
	let currentSummary: RuntimeTaskSessionSummary | null = summary();
	let changedFiles: number | null = 0;
	let clock = T0 + SETTLE_MS + 1;
	const harness: Harness = {
		board: () => board,
		setBoard: (next) => {
			board = next;
		},
		setSummary: (next) => {
			currentSummary = next;
		},
		setChangedFiles: (count) => {
			changedFiles = count;
		},
		advance: (ms) => {
			clock += ms;
		},
		sentPrompts: [],
		logs: [],
		reclaimed: 0,
		stopped: [],
		deps: {
			listWorkspaces: () => [WORKSPACE],
			loadBoard: async () => board,
			applyBoardChange: async (_workspace, change) => {
				const previousBoard = board;
				const next = change(board);
				if (next === null) {
					return { previousBoard, nextBoard: board, sessions: {}, changed: false };
				}
				board = next;
				return {
					previousBoard,
					nextBoard: next,
					sessions: currentSummary ? { [currentSummary.taskId]: currentSummary } : {},
					changed: true,
				};
			},
			resolveSessionSummary: () => currentSummary,
			probeChangedFiles: async () => changedFiles,
			loadPromptTemplates: async () => ({ commitPromptTemplate: "Commit onto {{base_ref}}." }),
			sendPrompt: async (_workspace, _taskId, prompt) => {
				harness.sentPrompts.push(prompt);
				return true;
			},
			stopSession: async (_workspace, taskId) => {
				harness.stopped.push(taskId);
			},
			reclaimWorktrees: () => {
				harness.reclaimed += 1;
			},
			broadcastWorkspaceStateUpdated: () => {},
			broadcastProjectsUpdated: () => {},
			now: () => clock,
			log: (message) => harness.logs.push(message),
		},
	};
	return harness;
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

describe("createUnattendedTaskDriver", () => {
	it("ignores tasks that are not flagged unattended", async () => {
		const harness = createHarness(boardWith("in_progress", [card({ unattended: undefined })]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();

		expect(getTaskColumnId(harness.board(), "task-1")).toBe("in_progress");
		expect(harness.sentPrompts).toEqual([]);
	});

	it("moves a finished task into review", async () => {
		const harness = createHarness(boardWith("in_progress", [card()]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();

		expect(getTaskColumnId(harness.board(), "task-1")).toBe("review");
	});

	it("drives a dirty task through commit to done, reclaiming the worktree", async () => {
		const harness = createHarness(boardWith("in_progress", [card()]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();
		expect(getTaskColumnId(harness.board(), "task-1")).toBe("review");

		harness.setChangedFiles(4);
		await driver.scanOnce();
		expect(harness.sentPrompts).toEqual(["Commit onto main."]);

		// The agent commits; the tree goes clean.
		harness.setChangedFiles(0);
		harness.advance(1000);
		await driver.scanOnce();

		expect(getTaskColumnId(harness.board(), "task-1")).toBe("trash");
		expect(harness.stopped).toEqual(["task-1"]);
		expect(harness.reclaimed).toBe(1);
	});

	// A plan-mode task reaches review clean while still planning. Completing it there
	// would discard the run before any code was written.
	it("does not complete a task that never had working changes", async () => {
		const harness = createHarness(boardWith("review", [card({ startInPlanMode: true })]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		harness.setChangedFiles(0);
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();
		await driver.scanOnce();

		expect(getTaskColumnId(harness.board(), "task-1")).toBe("review");
		expect(harness.sentPrompts).toEqual([]);
	});

	it("waits for the session to settle before injecting a prompt", async () => {
		const harness = createHarness(boardWith("review", [card()]));
		harness.setSummary(summary({ state: "awaiting_review", lastOutputAt: T0 + SETTLE_MS }));
		harness.setChangedFiles(3);
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();
		expect(harness.sentPrompts).toEqual([]);

		harness.advance(SETTLE_MS);
		await driver.scanOnce();
		expect(harness.sentPrompts).toHaveLength(1);
	});

	it("parks a task whose session cannot be written to", async () => {
		const harness = createHarness(boardWith("review", [card()]));
		harness.setSummary(summary({ state: "awaiting_review", pid: null }));
		harness.setChangedFiles(3);
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();

		expect(harness.sentPrompts).toEqual([]);
		expect(getTaskColumnId(harness.board(), "task-1")).toBe("review");
		// Parking clears the flag so nothing picks the task up again.
		const parked = harness
			.board()
			.columns.flatMap((column) => column.cards)
			.find((entry) => entry.id === "task-1");
		expect(parked?.unattended).toBeUndefined();
		expect(harness.logs.some((line) => line.includes("parked for review"))).toBe(true);
	});

	it("does not spend a git action budget slot when delivery fails", async () => {
		const harness = createHarness(boardWith("review", [card()]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		harness.setChangedFiles(3);
		harness.deps.sendPrompt = async () => false;
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();
		await driver.scanOnce();

		// Still in review, still flagged, and never parked for exhausting the cap.
		expect(getTaskColumnId(harness.board(), "task-1")).toBe("review");
		expect(harness.logs.some((line) => line.includes("no live session"))).toBe(true);
		expect(harness.logs.some((line) => line.includes("git-action-cap"))).toBe(false);
	});

	it("completes an interrupted task", async () => {
		const harness = createHarness(boardWith("in_progress", [card()]));
		harness.setSummary(summary({ state: "running" }));
		const driver = createUnattendedTaskDriver(harness.deps);
		await driver.scanOnce();

		harness.setSummary(summary({ state: "interrupted", pid: null }));
		await driver.scanOnce();

		expect(getTaskColumnId(harness.board(), "task-1")).toBe("trash");
	});

	it("keeps scanning after one task throws", async () => {
		const first = card({ id: "task-1" });
		const second = card({ id: "task-2" });
		const harness = createHarness(boardWith("in_progress", [first, second]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		harness.deps.resolveSessionSummary = (_workspace, taskId) => {
			if (taskId === "task-1") {
				throw new Error("boom");
			}
			return summary({ taskId: "task-2", state: "awaiting_review" });
		};
		const driver = createUnattendedTaskDriver(harness.deps);

		await driver.scanOnce();

		expect(harness.logs.some((line) => line.includes("error evaluating task task-1"))).toBe(true);
		expect(getTaskColumnId(harness.board(), "task-2")).toBe("review");
	});

	it("does nothing at all when the kill switch is off", async () => {
		vi.stubEnv("KANBAN_UNATTENDED_DRIVER", "off");
		const harness = createHarness(boardWith("in_progress", [card()]));
		harness.setSummary(summary({ state: "awaiting_review" }));
		const driver = createUnattendedTaskDriver(harness.deps);

		driver.start();

		expect(harness.logs).toEqual([]);
		driver.close();
	});
});
