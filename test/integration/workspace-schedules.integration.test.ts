import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeSchedule } from "../../src/core/api-contract";
import {
	getWorkspaceSchedulesPath,
	loadWorkspaceSchedules,
	mutateWorkspaceSchedules,
} from "../../src/state/workspace-schedules";
import { getWorkspacesRootPath, loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
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

describe.sequential("workspace schedules integration", () => {
	it("returns an empty list when nothing has been written", async () => {
		await withWorkspace(async (workspaceId) => {
			expect(await loadWorkspaceSchedules(workspaceId)).toEqual([]);
		});
	});

	it("round-trips a schedule through the file", async () => {
		await withWorkspace(async (workspaceId) => {
			await mutateWorkspaceSchedules(workspaceId, (schedules) => ({
				schedules: [...schedules, schedule()],
				value: null,
			}));
			const loaded = await loadWorkspaceSchedules(workspaceId);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toMatchObject({ id: "sched-1", name: "Nightly refactor", timezone: "UTC" });
		});
	});

	it("skips the write when the mutation opts out", async () => {
		await withWorkspace(async (workspaceId) => {
			await mutateWorkspaceSchedules(workspaceId, (schedules) => ({
				schedules: [...schedules, schedule()],
				value: null,
				save: false,
			}));
			expect(await loadWorkspaceSchedules(workspaceId)).toEqual([]);
		});
	});

	it("fills defaults for fields an older file omits", async () => {
		await withWorkspace(async (workspaceId) => {
			const path = getWorkspaceSchedulesPath(workspaceId);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(
				path,
				JSON.stringify({
					version: 1,
					schedules: [
						{
							id: "minimal",
							name: "Minimal",
							enabled: true,
							recurrence: { kind: "daily", hour: 3, minute: 15 },
							timezone: "UTC",
							task: { prompt: "do the thing" },
							createdAt: 1,
							updatedAt: 1,
						},
					],
				}),
				"utf8",
			);

			const [loaded] = await loadWorkspaceSchedules(workspaceId);
			expect(loaded).toMatchObject({
				overlapPolicy: "skip",
				lastRunAt: null,
				lastStatus: null,
				task: { startInPlanMode: false, autoReviewMode: "pr", baseRef: null },
			});
		});
	});

	it("reports a malformed file by naming the path", async () => {
		await withWorkspace(async (workspaceId) => {
			const path = getWorkspaceSchedulesPath(workspaceId);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify({ version: 1, schedules: [{ id: "" }] }), "utf8");

			await expect(loadWorkspaceSchedules(workspaceId)).rejects.toThrow(
				/Invalid schedules\.json file at .*schedules\.json/,
			);
		});
	});

	it("serializes concurrent mutations instead of losing one", async () => {
		await withWorkspace(async (workspaceId) => {
			await Promise.all(
				["a", "b", "c", "d"].map(async (id) =>
					mutateWorkspaceSchedules(workspaceId, (schedules) => ({
						schedules: [...schedules, schedule({ id })],
						value: null,
					})),
				),
			);
			const loaded = await loadWorkspaceSchedules(workspaceId);
			expect(loaded.map((entry) => entry.id).sort()).toEqual(["a", "b", "c", "d"]);
		});
	});

	// AsyncKeyedMutex has no reentrancy, so two stores sharing a lock key can only ever
	// serialize - and would deadlock outright if one were taken while the other was held.
	// The scheduler writes the board and then records the run on the schedule, so these
	// must be distinct keys. Assert that directly rather than inferring it from timing.
	it("locks on a different key than the workspace directory", async () => {
		await withWorkspace(async (workspaceId) => {
			const schedulesLockKey = `${getWorkspaceSchedulesPath(workspaceId)}.lock`;
			const workspaceDirectoryLockKey = join(getWorkspacesRootPath(), `${workspaceId}.lock`);
			expect(schedulesLockKey).not.toBe(workspaceDirectoryLockKey);
		});
	});

	it("interleaves board writes and schedule writes without stalling", async () => {
		await withWorkspace(async (workspaceId, repoPath) => {
			const [boardResult, scheduleResult] = await Promise.all([
				mutateWorkspaceState(repoPath, (state) => ({ board: state.board, value: "board" })),
				mutateWorkspaceSchedules(workspaceId, (schedules) => ({
					schedules: [...schedules, schedule({ id: "concurrent" })],
					value: "schedule",
				})),
			]);
			expect(boardResult.value).toBe("board");
			expect(scheduleResult).toBe("schedule");
			expect((await loadWorkspaceSchedules(workspaceId)).map((entry) => entry.id)).toEqual(["concurrent"]);
		});
	});
});
