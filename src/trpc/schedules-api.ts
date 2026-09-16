import type {
	RuntimeSchedule,
	RuntimeScheduleCreateRequest,
	RuntimeScheduleListResponse,
	RuntimeScheduleMutationResponse,
	RuntimeScheduleRemoveResponse,
	RuntimeScheduleRunNowResponse,
	RuntimeScheduleSetEnabledRequest,
	RuntimeScheduleSummary,
	RuntimeScheduleUpdateRequest,
} from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { describeSchedule, getNextOccurrence, validateSchedule } from "../schedules/schedule-occurrences";
import type { ScheduleRunOutcome } from "../schedules/schedule-runner";
import { loadWorkspaceSchedules, mutateWorkspaceSchedules } from "../state/workspace-schedules";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

// Read/write surface for recurring schedules.
//
// `nextRunAt`, `description` and `cronError` are computed here on every read rather than
// persisted: they are pure functions of the expression, the zone and the clock, and
// storing them would drift the moment any of those changed. Computing them server-side is
// also what keeps cron-parser and its date dependency out of the browser bundle.

export interface CreateSchedulesApiDependencies {
	runScheduleNow: (workspaceId: string, scheduleId: string) => Promise<ScheduleRunOutcome>;
	now?: () => number;
	randomUuid?: () => string;
}

function toScheduleSummary(schedule: RuntimeSchedule, now: number): RuntimeScheduleSummary {
	const validation = validateSchedule(schedule.recurrence, schedule.timezone);
	return {
		...schedule,
		nextRunAt: schedule.enabled ? getNextOccurrence(schedule.recurrence, schedule.timezone, now) : null,
		description: describeSchedule(schedule.recurrence, schedule.timezone),
		cronError: validation.ok ? null : validation.error,
	};
}

function resolveServerTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// A fixed base ref must actually name a branch; "resolve at fire time" is expressed as null.
function validateRequest(input: {
	recurrence: RuntimeScheduleCreateRequest["recurrence"];
	timezone: string;
	task: RuntimeScheduleCreateRequest["task"];
}): string | null {
	const validation = validateSchedule(input.recurrence, input.timezone);
	if (!validation.ok) {
		return validation.error;
	}
	if (input.task.baseRef !== null && input.task.baseRef.trim().length === 0) {
		return "Base branch cannot be blank. Leave it unset to use the repository default.";
	}
	return null;
}

export function createSchedulesApi(deps: CreateSchedulesApiDependencies): RuntimeTrpcContext["schedulesApi"] {
	const now = deps.now ?? (() => Date.now());
	const randomUuid = deps.randomUuid ?? (() => globalThis.crypto.randomUUID());

	const failure = (error: string): RuntimeScheduleMutationResponse => ({ ok: false, schedule: null, error });

	return {
		list: async (scope: RuntimeTrpcWorkspaceScope): Promise<RuntimeScheduleListResponse> => {
			const schedules = await loadWorkspaceSchedules(scope.workspaceId);
			const timestamp = now();
			return {
				schedules: schedules.map((schedule) => toScheduleSummary(schedule, timestamp)),
				serverTimezone: resolveServerTimezone(),
			};
		},

		create: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeScheduleCreateRequest,
		): Promise<RuntimeScheduleMutationResponse> => {
			const error = validateRequest(input);
			if (error) {
				return failure(error);
			}
			const timestamp = now();
			const created = await mutateWorkspaceSchedules(scope.workspaceId, (schedules) => {
				const schedule: RuntimeSchedule = {
					id: createUniqueTaskId(new Set(schedules.map((entry) => entry.id)), randomUuid),
					name: input.name,
					enabled: input.enabled,
					recurrence: input.recurrence,
					timezone: input.timezone,
					overlapPolicy: input.overlapPolicy,
					task: input.task,
					lastRunAt: null,
					lastTaskId: null,
					lastStatus: null,
					lastError: null,
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				return { schedules: [...schedules, schedule], value: schedule };
			});
			return { ok: true, schedule: toScheduleSummary(created, timestamp) };
		},

		update: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeScheduleUpdateRequest,
		): Promise<RuntimeScheduleMutationResponse> => {
			type UpdateResult = { error: string } | { schedule: RuntimeSchedule };
			// Read, merge and write inside one lock: a partial update reads the record it is
			// merging onto, so doing it outside would let a concurrent edit be lost.
			const result = await mutateWorkspaceSchedules<UpdateResult>(scope.workspaceId, (schedules) => {
				const existing = schedules.find((entry) => entry.id === input.scheduleId);
				if (!existing) {
					return { schedules, value: { error: `Schedule "${input.scheduleId}" was not found.` }, save: false };
				}
				const merged: RuntimeSchedule = {
					...existing,
					name: input.name ?? existing.name,
					enabled: input.enabled ?? existing.enabled,
					recurrence: input.recurrence ?? existing.recurrence,
					timezone: input.timezone ?? existing.timezone,
					overlapPolicy: input.overlapPolicy ?? existing.overlapPolicy,
					task: input.task ?? existing.task,
					updatedAt: now(),
				};
				const invalid = validateRequest(merged);
				if (invalid) {
					return { schedules, value: { error: invalid }, save: false };
				}
				return {
					schedules: schedules.map((entry) => (entry.id === merged.id ? merged : entry)),
					value: { schedule: merged },
				};
			});
			if ("error" in result) {
				return failure(result.error);
			}
			return { ok: true, schedule: toScheduleSummary(result.schedule, now()) };
		},

		setEnabled: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeScheduleSetEnabledRequest,
		): Promise<RuntimeScheduleMutationResponse> => {
			const updated = await mutateWorkspaceSchedules(scope.workspaceId, (schedules) => {
				const existing = schedules.find((entry) => entry.id === input.scheduleId);
				if (!existing) {
					return { schedules, value: null, save: false };
				}
				const next: RuntimeSchedule = { ...existing, enabled: input.enabled, updatedAt: now() };
				return {
					schedules: schedules.map((entry) => (entry.id === next.id ? next : entry)),
					value: next,
				};
			});
			if (!updated) {
				return failure(`Schedule "${input.scheduleId}" was not found.`);
			}
			return { ok: true, schedule: toScheduleSummary(updated, now()) };
		},

		remove: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: { scheduleId: string },
		): Promise<RuntimeScheduleRemoveResponse> => {
			const removed = await mutateWorkspaceSchedules(scope.workspaceId, (schedules) => {
				const next = schedules.filter((entry) => entry.id !== input.scheduleId);
				if (next.length === schedules.length) {
					return { schedules, value: false, save: false };
				}
				return { schedules: next, value: true };
			});
			return { ok: true, removed };
		},

		runNow: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: { scheduleId: string },
		): Promise<RuntimeScheduleRunNowResponse> => {
			const outcome = await deps.runScheduleNow(scope.workspaceId, input.scheduleId);
			return {
				ok: outcome.status === "ok",
				status: outcome.status,
				taskId: outcome.taskId,
				...(outcome.error ? { error: outcome.error } : {}),
			};
		},
	};
}
