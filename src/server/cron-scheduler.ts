import type { RuntimeSchedule } from "../core/api-contract";
import { decideScheduleTick } from "../schedules/schedule-firing";
import { findLatestOccurrenceInWindow } from "../schedules/schedule-occurrences";
import type { ScheduleRunContext, ScheduleRunOutcome } from "../schedules/schedule-runner";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import { envInt, isEnvSwitchEnabled } from "./env-tunables";

// Fires recurring task schedules.
//
// Sibling of `stall-watchdog.ts` and `unattended-task-driver.ts`: a pure decision function
// plus a thin interval driver with injected dependencies.
//
// Missed runs are skipped rather than caught up. Two things implement that: `lastTickAt`
// is seeded at start() with the current time, so nothing from before the process was up
// can be in a window; and a gap longer than the lookback is clamped, so waking a laptop
// after eight hours does not replay eight occurrences.
//
// Iterates every indexed workspace, not just the ones with a live terminal manager - a
// schedule has to fire for a project nobody has opened this session.

export const SCHEDULE_POLL_MS = envInt("KANBAN_SCHEDULE_POLL_MS", 30_000);
export const SCHEDULE_MAX_LOOKBACK_MS = envInt("KANBAN_SCHEDULE_MAX_LOOKBACK_MS", 3 * SCHEDULE_POLL_MS);

export function isCronSchedulerEnabled(): boolean {
	return isEnvSwitchEnabled("KANBAN_SCHEDULES");
}

export interface CronSchedulerDependencies {
	listWorkspaces: () => Promise<RuntimeWorkspaceIndexEntry[]>;
	loadSchedules: (workspaceId: string) => Promise<RuntimeSchedule[]>;
	recordScheduleRun: (
		workspaceId: string,
		scheduleId: string,
		outcome: ScheduleRunOutcome,
		ranAt: number,
	) => Promise<void>;
	runSchedule: (
		context: ScheduleRunContext,
		schedule: RuntimeSchedule,
		options?: { ignoreOverlap?: boolean },
	) => Promise<ScheduleRunOutcome>;
	/** Guards against a project whose directory was moved or deleted since it was indexed. */
	pathIsDirectory: (path: string) => Promise<boolean>;
	now?: () => number;
	log?: (message: string) => void;
}

export interface CronScheduler {
	start: () => void;
	tickOnce: () => Promise<void>;
	runScheduleNow: (workspaceId: string, scheduleId: string) => Promise<ScheduleRunOutcome>;
	close: () => void;
}

export function createCronScheduler(deps: CronSchedulerDependencies): CronScheduler {
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	let timer: NodeJS.Timeout | null = null;
	let ticking = false;
	let lastTickAt = now();

	const findWorkspace = async (workspaceId: string): Promise<RuntimeWorkspaceIndexEntry | null> => {
		return (await deps.listWorkspaces()).find((entry) => entry.workspaceId === workspaceId) ?? null;
	};

	const scanWorkspace = async (
		entry: RuntimeWorkspaceIndexEntry,
		previousTickAt: number,
		tickAt: number,
	): Promise<void> => {
		if (!(await deps.pathIsDirectory(entry.repoPath))) {
			// Deliberately not pruning the index here: an unmounted drive must not cost the
			// user their board. Workspace removal is owned by the workspace registry.
			log(`skip ${entry.workspaceId}: repository path is missing`);
			return;
		}

		const schedules = await deps.loadSchedules(entry.workspaceId);
		if (schedules.length === 0) {
			return;
		}
		const scheduleById = new Map(schedules.map((schedule) => [schedule.id, schedule]));
		const decision = decideScheduleTick({
			schedules,
			previousTickAt,
			now: tickAt,
			maxLookbackMs: SCHEDULE_MAX_LOOKBACK_MS,
			findLatestOccurrence: findLatestOccurrenceInWindow,
		});

		for (const invalid of decision.invalid) {
			const schedule = scheduleById.get(invalid.scheduleId);
			// Only record once, or a broken expression rewrites the file on every tick.
			if (schedule && schedule.lastStatus !== "invalid") {
				await deps
					.recordScheduleRun(
						entry.workspaceId,
						invalid.scheduleId,
						{ status: "invalid", taskId: null, error: invalid.error },
						tickAt,
					)
					.catch((error: unknown) => {
						log(`could not record invalid schedule ${invalid.scheduleId}: ${String(error)}`);
					});
			}
			log(`schedule ${invalid.scheduleId} has an unusable expression: ${invalid.error}`);
		}

		for (const due of decision.due) {
			const schedule = scheduleById.get(due.scheduleId);
			if (!schedule) {
				continue;
			}
			let outcome: ScheduleRunOutcome;
			try {
				outcome = await deps.runSchedule(
					{ workspaceId: entry.workspaceId, workspacePath: entry.repoPath },
					schedule,
				);
			} catch (error) {
				outcome = { status: "failed", taskId: null, error: String(error) };
			}
			await deps
				.recordScheduleRun(entry.workspaceId, schedule.id, outcome, due.occurrenceAt)
				.catch((error: unknown) => {
					log(`could not record run for schedule ${schedule.id}: ${String(error)}`);
				});
		}
	};

	const tickOnce = async (): Promise<void> => {
		if (ticking) {
			return;
		}
		ticking = true;
		const tickAt = now();
		const previousTickAt = lastTickAt;
		// Advance before awaiting anything: a launch that takes minutes must not let its own
		// occurrence fall back inside the next window.
		lastTickAt = tickAt;
		try {
			for (const entry of await deps.listWorkspaces()) {
				try {
					await scanWorkspace(entry, previousTickAt, tickAt);
				} catch (error) {
					log(`error scanning workspace ${entry.workspaceId}: ${String(error)}`);
				}
			}
		} catch (error) {
			log(`error listing workspaces: ${String(error)}`);
		} finally {
			ticking = false;
		}
	};

	const runScheduleNow = async (workspaceId: string, scheduleId: string): Promise<ScheduleRunOutcome> => {
		const entry = await findWorkspace(workspaceId);
		if (!entry) {
			return { status: "failed", taskId: null, error: `Unknown workspace "${workspaceId}".` };
		}
		const schedule = (await deps.loadSchedules(workspaceId)).find((candidate) => candidate.id === scheduleId);
		if (!schedule) {
			return { status: "failed", taskId: null, error: `Unknown schedule "${scheduleId}".` };
		}
		// An explicit "run now" ignores both the enabled flag and the overlap policy: the
		// user asked for this run specifically.
		const outcome = await deps.runSchedule(
			{ workspaceId: entry.workspaceId, workspacePath: entry.repoPath },
			schedule,
			{ ignoreOverlap: true },
		);
		await deps.recordScheduleRun(workspaceId, scheduleId, outcome, now()).catch((error: unknown) => {
			log(`could not record manual run for schedule ${scheduleId}: ${String(error)}`);
		});
		return outcome;
	};

	return {
		start: () => {
			if (timer || !isCronSchedulerEnabled()) {
				return;
			}
			// Seeding here is what makes missed runs skip: the first window starts now, so
			// occurrences from before startup are never selected.
			lastTickAt = now();
			timer = setInterval(() => {
				void tickOnce();
			}, SCHEDULE_POLL_MS);
			timer.unref();
			log(`started (poll=${SCHEDULE_POLL_MS}ms, maxLookback=${SCHEDULE_MAX_LOOKBACK_MS}ms)`);
		},
		tickOnce,
		runScheduleNow,
		close: () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
