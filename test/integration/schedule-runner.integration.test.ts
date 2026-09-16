import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
	RuntimeSchedule,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
} from "../../src/core/api-contract";
import { getTaskColumnId } from "../../src/core/task-board-mutations";
import {
	type CreateScheduleRunnerDependencies,
	createScheduleRunner,
	resolveScheduleBaseRef,
} from "../../src/schedules/schedule-runner";
import { loadWorkspaceBoardById, loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function createRepository(path: string): void {
	const run = (args: string[]): void => {
		const result = spawnSync("git", args, { cwd: path, stdio: "ignore", env: createGitTestEnv() });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed`);
		}
	};
	run(["init", "--initial-branch=main"]);
	writeFileSync(`${path}/README.md`, "# fixture\n", "utf8");
	run(["add", "."]);
	run(["commit", "-m", "initial"]);
}

function schedule(overrides: Partial<RuntimeSchedule> = {}): RuntimeSchedule {
	return {
		id: "sched-1",
		name: "Nightly refactor",
		enabled: true,
		recurrence: { kind: "daily", hour: 2, minute: 0 },
		timezone: "UTC",
		overlapPolicy: "skip",
		task: { prompt: "Refactor big files", startInPlanMode: false, autoReviewMode: "pr", baseRef: null },
		lastRunAt: null,
		lastTaskId: null,
		lastStatus: null,
		lastError: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

interface RunnerHarness {
	deps: CreateScheduleRunnerDependencies;
	started: RuntimeTaskSessionStartRequest[];
}

function createRunnerDeps(overrides: Partial<CreateScheduleRunnerDependencies> = {}): RunnerHarness {
	const started: RuntimeTaskSessionStartRequest[] = [];
	return {
		started,
		deps: {
			ensureTerminalManagerForWorkspace: async () => ({}),
			startTaskSession: async (_scope, input): Promise<RuntimeTaskSessionStartResponse> => {
				started.push(input);
				return { ok: true, summary: null };
			},
			ensureTaskWorktree: async ({ baseRef }) => ({
				ok: true,
				path: "/tmp/worktree",
				baseRef,
				baseCommit: "abc123",
			}),
			broadcastWorkspaceStateUpdated: () => {},
			broadcastProjectsUpdated: () => {},
			...overrides,
		},
	};
}

async function withWorkspace<T>(run: (workspaceId: string, repoPath: string) => Promise<T>): Promise<T> {
	return await withTemporaryHome(async () => {
		const { path: repoPath, cleanup } = createTempDir("kanban-repo-");
		try {
			createRepository(repoPath);
			const context = await loadWorkspaceContext(repoPath);
			return await run(context.workspaceId, context.repoPath);
		} finally {
			cleanup();
		}
	});
}

describe.sequential("schedule runner integration", () => {
	it("materializes an unattended task and starts it in progress", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const harness = createRunnerDeps();
			const runner = createScheduleRunner(harness.deps);

			const outcome = await runner.runSchedule({ workspaceId, workspacePath: repoPath }, schedule());

			expect(outcome.status).toBe("ok");
			expect(outcome.taskId).not.toBeNull();

			const board = await loadWorkspaceBoardById(workspaceId);
			const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === outcome.taskId);
			expect(getTaskColumnId(board, outcome.taskId ?? "")).toBe("in_progress");
			// A run nobody is watching has to finish the job itself.
			expect(card).toMatchObject({
				unattended: true,
				autoReviewEnabled: true,
				autoReviewMode: "pr",
				baseRef: "main",
			});
			expect(harness.started).toHaveLength(1);
			expect(harness.started[0]).toMatchObject({ prompt: "Refactor big files", baseRef: "main" });
		});
	});

	it("leaves the card in backlog when the worktree cannot be created", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const harness = createRunnerDeps({
				ensureTaskWorktree: async ({ baseRef }) => ({
					ok: false,
					path: null,
					baseRef,
					baseCommit: null,
					error: "disk full",
				}),
			});
			const runner = createScheduleRunner(harness.deps);

			const outcome = await runner.runSchedule({ workspaceId, workspacePath: repoPath }, schedule());

			expect(outcome).toMatchObject({ status: "failed", error: "disk full" });
			// Recoverable by hand rather than stranded in In Progress with no session.
			expect(getTaskColumnId(await loadWorkspaceBoardById(workspaceId), outcome.taskId ?? "")).toBe("backlog");
			expect(harness.started).toEqual([]);
		});
	});

	it("leaves the card in backlog when no agent can be started", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const harness = createRunnerDeps({
				startTaskSession: async () => ({ ok: false, summary: null, error: "No runnable agent command." }),
			});
			const runner = createScheduleRunner(harness.deps);

			const outcome = await runner.runSchedule({ workspaceId, workspacePath: repoPath }, schedule());

			expect(outcome).toMatchObject({ status: "failed", error: "No runnable agent command." });
			expect(getTaskColumnId(await loadWorkspaceBoardById(workspaceId), outcome.taskId ?? "")).toBe("backlog");
		});
	});

	it("records a failure instead of throwing when the workspace is unusable", async () => {
		await withWorkspace(async (workspaceId) => {
			const harness = createRunnerDeps();
			const runner = createScheduleRunner(harness.deps);

			const outcome = await runner.runSchedule({ workspaceId, workspacePath: "/nonexistent/path" }, schedule());

			expect(outcome.status).toBe("failed");
			expect(outcome.error).toBeTruthy();
		});
	});

	it("skips a run while the previous task is still on the board", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const harness = createRunnerDeps();
			const runner = createScheduleRunner(harness.deps);

			const first = await runner.runSchedule({ workspaceId, workspacePath: repoPath }, schedule());
			expect(first.status).toBe("ok");

			const second = await runner.runSchedule(
				{ workspaceId, workspacePath: repoPath },
				schedule({ lastTaskId: first.taskId }),
			);

			expect(second).toMatchObject({ status: "skipped_overlap", taskId: first.taskId });
			const board = await loadWorkspaceBoardById(workspaceId);
			expect(board.columns.flatMap((column) => column.cards)).toHaveLength(1);
		});
	});

	it("runs anyway under the allow policy, and when the caller ignores overlap", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const harness = createRunnerDeps();
			const runner = createScheduleRunner(harness.deps);
			const first = await runner.runSchedule({ workspaceId, workspacePath: repoPath }, schedule());

			const allowed = await runner.runSchedule(
				{ workspaceId, workspacePath: repoPath },
				schedule({ lastTaskId: first.taskId, overlapPolicy: "allow" }),
			);
			expect(allowed.status).toBe("ok");

			const forced = await runner.runSchedule(
				{ workspaceId, workspacePath: repoPath },
				schedule({ lastTaskId: allowed.taskId }),
				{ ignoreOverlap: true },
			);
			expect(forced.status).toBe("ok");
		});
	});

	it("honours a fixed base ref", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const harness = createRunnerDeps();
			const runner = createScheduleRunner(harness.deps);
			await mutateWorkspaceState(repoPath, (state) => ({ board: state.board, value: null }));

			const outcome = await runner.runSchedule(
				{ workspaceId, workspacePath: repoPath },
				schedule({ task: { prompt: "p", startInPlanMode: false, autoReviewMode: "commit", baseRef: "main" } }),
			);

			expect(outcome.status).toBe("ok");
			expect(harness.started[0]).toMatchObject({ baseRef: "main" });
		});
	});
});

describe("resolveScheduleBaseRef", () => {
	const gitState = (overrides: Partial<{ currentBranch: string | null; defaultBranch: string | null }>) =>
		({
			repoPath: "/tmp/repo",
			statePath: "/tmp/state",
			git: { currentBranch: null, defaultBranch: null, branches: [], ...overrides },
			board: { columns: [], dependencies: [] },
			sessions: {},
			revision: 0,
		}) as Parameters<typeof resolveScheduleBaseRef>[1];

	// Unlike interactive task creation, a 02:00 job must not build on whatever branch the
	// user happened to leave checked out.
	it("prefers the default branch over the checked-out branch", () => {
		expect(resolveScheduleBaseRef(schedule(), gitState({ currentBranch: "wip", defaultBranch: "main" }))).toBe(
			"main",
		);
	});

	it("falls back to the checked-out branch when there is no default", () => {
		expect(resolveScheduleBaseRef(schedule(), gitState({ currentBranch: "wip" }))).toBe("wip");
	});

	it("uses an explicit base ref when the schedule fixes one", () => {
		const fixed = schedule({
			task: { prompt: "p", startInPlanMode: false, autoReviewMode: "pr", baseRef: "release/2.0" },
		});
		expect(resolveScheduleBaseRef(fixed, gitState({ defaultBranch: "main" }))).toBe("release/2.0");
	});
});
