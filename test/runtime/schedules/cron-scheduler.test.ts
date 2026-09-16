import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSchedule } from "../../../src/core/api-contract";
import type { ScheduleRunContext, ScheduleRunOutcome } from "../../../src/schedules/schedule-runner";
import {
	type CronSchedulerDependencies,
	createCronScheduler,
	SCHEDULE_MAX_LOOKBACK_MS,
} from "../../../src/server/cron-scheduler";
import type { RuntimeWorkspaceIndexEntry } from "../../../src/state/workspace-state";

const WORKSPACE: RuntimeWorkspaceIndexEntry = { workspaceId: "ws-1", repoPath: "/tmp/repo" };

function at(iso: string): number {
	return new Date(iso).getTime();
}

function schedule(overrides: Partial<RuntimeSchedule> = {}): RuntimeSchedule {
	return {
		id: "sched-1",
		name: "Nightly refactor",
		enabled: true,
		recurrence: { kind: "cron", expression: "* * * * *" },
		timezone: "UTC",
		overlapPolicy: "skip",
		task: { prompt: "Refactor big files", startInPlanMode: false, autoReviewMode: "pr", baseRef: null },
		lastRunAt: null,
		lastTaskId: null,
		lastStatus: null,
		lastError: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

interface Harness {
	deps: CronSchedulerDependencies;
	runs: Array<{ scheduleId: string; ignoreOverlap: boolean }>;
	recorded: Array<{ scheduleId: string; outcome: ScheduleRunOutcome }>;
	logs: string[];
	setClock: (value: number) => void;
	setSchedules: (schedules: RuntimeSchedule[]) => void;
	setWorkspaces: (entries: RuntimeWorkspaceIndexEntry[]) => void;
	setPathExists: (exists: boolean) => void;
}

function createHarness(): Harness {
	let clock = at("2026-06-02T02:00:00Z");
	let schedules: RuntimeSchedule[] = [schedule()];
	let workspaces: RuntimeWorkspaceIndexEntry[] = [WORKSPACE];
	let pathExists = true;
	const harness: Harness = {
		runs: [],
		recorded: [],
		logs: [],
		setClock: (value) => {
			clock = value;
		},
		setSchedules: (next) => {
			schedules = next;
		},
		setWorkspaces: (next) => {
			workspaces = next;
		},
		setPathExists: (exists) => {
			pathExists = exists;
		},
		deps: {
			listWorkspaces: async () => workspaces,
			loadSchedules: async () => schedules,
			recordScheduleRun: async (_workspaceId, scheduleId, outcome) => {
				harness.recorded.push({ scheduleId, outcome });
			},
			runSchedule: async (_context: ScheduleRunContext, target, options) => {
				harness.runs.push({ scheduleId: target.id, ignoreOverlap: options?.ignoreOverlap === true });
				return { status: "ok", taskId: `task-${target.id}`, error: null };
			},
			pathIsDirectory: async () => pathExists,
			now: () => clock,
			log: (message) => harness.logs.push(message),
		},
	};
	return harness;
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

describe("createCronScheduler", () => {
	it("fires a due schedule and records the outcome", async () => {
		const harness = createHarness();
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();

		harness.setClock(at("2026-06-02T02:01:10Z"));
		await scheduler.tickOnce();

		expect(harness.runs.map((run) => run.scheduleId)).toEqual(["sched-1"]);
		expect(harness.recorded[0]?.outcome).toMatchObject({ status: "ok", taskId: "task-sched-1" });
		scheduler.close();
	});

	// Startup must not replay whatever was missed while the process was down.
	it("does not backfill occurrences from before it started", async () => {
		const harness = createHarness();
		harness.setClock(at("2026-06-02T09:00:00Z"));
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();

		harness.setClock(at("2026-06-02T09:00:10Z"));
		await scheduler.tickOnce();

		// Ten seconds of window on a per-minute schedule: nothing due yet.
		expect(harness.runs).toEqual([]);
		scheduler.close();
	});

	it("fires an occurrence exactly once across consecutive ticks", async () => {
		const harness = createHarness();
		harness.setSchedules([schedule({ recurrence: { kind: "daily", hour: 2, minute: 0 } })]);
		harness.setClock(at("2026-06-02T01:59:30Z"));
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();

		harness.setClock(at("2026-06-02T02:00:10Z"));
		await scheduler.tickOnce();
		harness.setClock(at("2026-06-02T02:00:40Z"));
		await scheduler.tickOnce();

		expect(harness.runs).toHaveLength(1);
		scheduler.close();
	});

	it("skips a workspace whose repository path has gone", async () => {
		const harness = createHarness();
		harness.setPathExists(false);
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();
		harness.setClock(at("2026-06-02T02:01:10Z"));

		await scheduler.tickOnce();

		expect(harness.runs).toEqual([]);
		expect(harness.logs.some((line) => line.includes("repository path is missing"))).toBe(true);
		scheduler.close();
	});

	it("keeps going when one workspace fails to load", async () => {
		const harness = createHarness();
		harness.setWorkspaces([
			{ workspaceId: "broken", repoPath: "/tmp/broken" },
			{ workspaceId: "ws-1", repoPath: "/tmp/repo" },
		]);
		harness.deps.loadSchedules = async (workspaceId) => {
			if (workspaceId === "broken") {
				throw new Error("Invalid schedules.json");
			}
			return [schedule()];
		};
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();
		harness.setClock(at("2026-06-02T02:01:10Z"));

		await scheduler.tickOnce();

		expect(harness.logs.some((line) => line.includes("error scanning workspace broken"))).toBe(true);
		expect(harness.runs.map((run) => run.scheduleId)).toEqual(["sched-1"]);
		scheduler.close();
	});

	it("records a failure without letting it escape the tick", async () => {
		const harness = createHarness();
		harness.deps.runSchedule = async () => {
			throw new Error("agent binary missing");
		};
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();
		harness.setClock(at("2026-06-02T02:01:10Z"));

		await expect(scheduler.tickOnce()).resolves.toBeUndefined();
		expect(harness.recorded[0]?.outcome).toMatchObject({ status: "failed" });
		scheduler.close();
	});

	it("survives a recordScheduleRun failure", async () => {
		const harness = createHarness();
		harness.deps.recordScheduleRun = async () => {
			throw new Error("disk full");
		};
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();
		harness.setClock(at("2026-06-02T02:01:10Z"));

		await expect(scheduler.tickOnce()).resolves.toBeUndefined();
		expect(harness.logs.some((line) => line.includes("could not record run"))).toBe(true);
		scheduler.close();
	});

	it("records an unusable expression once, not on every tick", async () => {
		const harness = createHarness();
		const invalid = schedule({ recurrence: { kind: "cron", expression: "nope" } });
		harness.setSchedules([invalid]);
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();

		harness.setClock(at("2026-06-02T02:01:10Z"));
		await scheduler.tickOnce();
		expect(harness.recorded.map((entry) => entry.outcome.status)).toEqual(["invalid"]);

		harness.setSchedules([{ ...invalid, lastStatus: "invalid" }]);
		harness.setClock(at("2026-06-02T02:02:10Z"));
		await scheduler.tickOnce();
		expect(harness.recorded).toHaveLength(1);
		scheduler.close();
	});

	it("clamps a long gap rather than replaying it", async () => {
		const harness = createHarness();
		harness.setClock(at("2026-06-02T02:00:00Z"));
		const scheduler = createCronScheduler(harness.deps);
		scheduler.start();

		// Simulate the machine sleeping for hours between ticks.
		harness.setClock(at("2026-06-02T10:00:20Z"));
		await scheduler.tickOnce();

		// A per-minute schedule elapsed ~480 times; the clamp allows at most one run.
		expect(harness.runs.length).toBeLessThanOrEqual(1);
		expect(SCHEDULE_MAX_LOOKBACK_MS).toBeGreaterThan(0);
		scheduler.close();
	});

	it("runs a disabled schedule on demand, ignoring overlap", async () => {
		const harness = createHarness();
		harness.setSchedules([schedule({ enabled: false, lastTaskId: "previous" })]);
		const scheduler = createCronScheduler(harness.deps);

		const outcome = await scheduler.runScheduleNow("ws-1", "sched-1");

		expect(outcome).toMatchObject({ status: "ok" });
		expect(harness.runs).toEqual([{ scheduleId: "sched-1", ignoreOverlap: true }]);
	});

	it("reports an unknown schedule or workspace rather than throwing", async () => {
		const harness = createHarness();
		const scheduler = createCronScheduler(harness.deps);

		await expect(scheduler.runScheduleNow("ws-1", "missing")).resolves.toMatchObject({ status: "failed" });
		await expect(scheduler.runScheduleNow("nope", "sched-1")).resolves.toMatchObject({ status: "failed" });
	});

	it("does not start when the kill switch is off", async () => {
		vi.stubEnv("KANBAN_SCHEDULES", "off");
		const harness = createHarness();
		const scheduler = createCronScheduler(harness.deps);

		scheduler.start();

		expect(harness.logs).toEqual([]);
		scheduler.close();
	});
});
