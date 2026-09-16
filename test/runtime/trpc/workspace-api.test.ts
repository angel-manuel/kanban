import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	deleteTaskWorktree: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: workspaceTaskWorktreeMocks.deleteTaskWorktree,
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
}));

// Spy mode keeps the real module (WorkspaceStateConflictError included) and only lets the
// reclamation test drive saveWorkspaceState's onBoardReplaced callback.
vi.mock("../../../src/state/workspace-state.js", { spy: true });

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
}));

import { saveWorkspaceState } from "../../../src/state/workspace-state";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			warn: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			warn: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("uses native cline session checkpoints when terminal summaries are unavailable", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "3333333",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			warn: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(clineTaskSessionService.getSummary).toHaveBeenCalledWith("task-1");
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
			toRef: "3333333",
		});
	});

	it("prefers the newer live cline summary over a stale terminal summary", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "claude",
					updatedAt: 10,
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "terminal-2",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "terminal-1",
						createdAt: 1,
					},
				}),
			),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "cline",
					updatedAt: 20,
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "cline-3",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "cline-2",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			warn: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "cline-2",
			toRef: "cline-3",
		});
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedClineTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			warn: vi.fn(),
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});
});

function createBoardCard(taskId: string): RuntimeBoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: taskId,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(cardsByColumnId: Partial<Record<RuntimeBoardData["columns"][number]["id"], string[]>>) {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: (cardsByColumnId.backlog ?? []).map(createBoardCard) },
			{ id: "in_progress", title: "In Progress", cards: (cardsByColumnId.in_progress ?? []).map(createBoardCard) },
			{ id: "review", title: "Review", cards: (cardsByColumnId.review ?? []).map(createBoardCard) },
			{ id: "trash", title: "Done", cards: (cardsByColumnId.trash ?? []).map(createBoardCard) },
		],
		dependencies: [],
	} satisfies RuntimeBoardData;
}

describe("createWorkspaceApi saveState worktree reclamation", () => {
	const warn = vi.fn();

	function createApi() {
		return createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => ({ listSummaries: () => [] }) as never),
			getScopedClineTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
			warn,
		});
	}

	/**
	 * Stands in for the persisted board so the test can drive the exact transition
	 * saveWorkspaceState would observe under its lock.
	 */
	function persistBoard(previousBoard: RuntimeBoardData): void {
		vi.mocked(saveWorkspaceState).mockImplementation(async (_cwd, payload, options) => {
			options?.onBoardReplaced?.(previousBoard, payload.board);
			return null as never;
		});
	}

	function saveBoard(
		api: ReturnType<typeof createApi>,
		board: RuntimeBoardData,
		sessions: Record<string, RuntimeTaskSessionSummary> = {},
	) {
		return api.saveState({ workspaceId: "workspace-1", workspacePath: "/tmp/repo" }, {
			board,
			sessions,
		} satisfies RuntimeWorkspaceStateSaveRequest);
	}

	beforeEach(() => {
		warn.mockReset();
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockReset();
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockResolvedValue({ ok: true, removed: true });
	});

	it("reclaims the worktree of a task that just reached the done column", async () => {
		persistBoard(createBoard({ in_progress: ["task-1"], trash: ["task-0"] }));

		await saveBoard(createApi(), createBoard({ trash: ["task-1", "task-0"] }));

		await vi.waitFor(() => {
			expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledWith({
				repoPath: "/tmp/repo",
				taskId: "task-1",
			});
		});
		expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledTimes(1);
	});

	it("leaves worktrees alone when no task entered the done column", async () => {
		persistBoard(createBoard({ in_progress: ["task-1"], trash: ["task-0"] }));

		await saveBoard(createApi(), createBoard({ review: ["task-1"], trash: ["task-0"] }));

		expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	it.each(["running", "awaiting_review"] as const)(
		"leaves the worktree in place while the task agent is still %s",
		async (state) => {
			persistBoard(createBoard({ in_progress: ["task-1"] }));

			await saveBoard(createApi(), createBoard({ trash: ["task-1"] }), {
				"task-1": createSummary({ taskId: "task-1", state }),
			});

			expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).not.toHaveBeenCalled();
		},
	);

	it("reclaims the worktree of a task auto-moved to done after its session was interrupted", async () => {
		persistBoard(createBoard({ in_progress: ["task-1"] }));

		await saveBoard(createApi(), createBoard({ trash: ["task-1"] }), {
			"task-1": createSummary({ taskId: "task-1", state: "interrupted" }),
		});

		await vi.waitFor(() => {
			expect(workspaceTaskWorktreeMocks.deleteTaskWorktree).toHaveBeenCalledWith({
				repoPath: "/tmp/repo",
				taskId: "task-1",
			});
		});
	});

	it("keeps the state save successful when worktree reclamation fails", async () => {
		workspaceTaskWorktreeMocks.deleteTaskWorktree.mockResolvedValue({
			ok: false,
			removed: false,
			error: "worktree is locked",
		});
		persistBoard(createBoard({ review: ["task-1"] }));

		await expect(saveBoard(createApi(), createBoard({ trash: ["task-1"] }))).resolves.not.toThrow();

		await vi.waitFor(() => {
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("worktree is locked"));
		});
	});
});
