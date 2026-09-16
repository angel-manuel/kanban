import type { Command } from "commander";

import {
	type RuntimeAgentId,
	type RuntimeSchedule,
	type RuntimeScheduleOverlapPolicy,
	type RuntimeScheduleRecurrence,
	type RuntimeTaskAutoReviewMode,
	runtimeAgentIdSchema,
} from "../core/api-contract";
import { createUniqueTaskId } from "../core/task-id";
import { describeSchedule, getNextOccurrence, validateSchedule } from "../schedules/schedule-occurrences";
import { loadWorkspaceSchedules, mutateWorkspaceSchedules } from "../state/workspace-schedules";
import { createRuntimeTrpcClient, type JsonRecord, resolveRuntimeWorkspace, runCliCommand } from "./command-runtime";

// `kanban schedule` - manage recurring tasks from the terminal.
//
// Reads and edits go straight to `schedules.json`, so listing and editing work with no
// server running; the scheduler re-reads the file every tick, so an edit takes effect
// within one poll with no IPC. Only `run` goes over tRPC, because it has to start a
// process. This mirrors how `kanban task` is split.

const VALID_AGENT_IDS = runtimeAgentIdSchema.options;

interface ScheduleCommonOptions {
	projectPath?: string;
}

function parseAgentId(value: string | undefined): RuntimeAgentId | undefined {
	if (value === undefined || value === "default") {
		return undefined;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid agent ID "${value}". Expected one of: ${VALID_AGENT_IDS.join(", ")}, default.`);
}

function parseAutoReviewMode(value: string | undefined): RuntimeTaskAutoReviewMode | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "commit" || value === "pr") {
		return value;
	}
	throw new Error(`Invalid auto-review mode "${value}". Expected commit or pr.`);
}

function parseOverlapPolicy(value: string | undefined): RuntimeScheduleOverlapPolicy | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "skip" || value === "allow") {
		return value;
	}
	throw new Error(`Invalid overlap policy "${value}". Expected skip or allow.`);
}

function parseTimeOfDay(value: string, flag: string): { hour: number; minute: number } {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) {
		throw new Error(`Invalid ${flag} value "${value}". Expected HH:MM, for example 02:00.`);
	}
	const hour = Number.parseInt(match[1] ?? "", 10);
	const minute = Number.parseInt(match[2] ?? "", 10);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error(`Invalid ${flag} value "${value}". Hours must be 0-23 and minutes 0-59.`);
	}
	return { hour, minute };
}

const WEEKDAY_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

function parseWeekdays(value: string): number[] {
	const weekdays = value
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const named = WEEKDAY_NAMES[entry.slice(0, 3)];
			if (named !== undefined) {
				return named;
			}
			const numeric = Number.parseInt(entry, 10);
			if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) {
				return numeric;
			}
			throw new Error(`Invalid weekday "${entry}". Expected 0-6 or sun/mon/tue/wed/thu/fri/sat.`);
		});
	if (weekdays.length === 0) {
		throw new Error("--weekly requires at least one weekday.");
	}
	return [...new Set(weekdays)].sort((a, b) => a - b);
}

function buildRecurrence(options: {
	daily?: string;
	weekly?: string;
	at?: string;
	cron?: string;
}): RuntimeScheduleRecurrence | undefined {
	const provided = [options.daily, options.weekly, options.cron].filter((value) => value !== undefined);
	if (provided.length === 0) {
		return undefined;
	}
	if (provided.length > 1) {
		throw new Error("Use exactly one of --daily, --weekly or --cron.");
	}
	if (options.cron !== undefined) {
		return { kind: "cron", expression: options.cron };
	}
	if (options.daily !== undefined) {
		return { kind: "daily", ...parseTimeOfDay(options.daily, "--daily") };
	}
	const at = options.at;
	if (at === undefined) {
		throw new Error("--weekly requires --at HH:MM.");
	}
	return { kind: "weekly", ...parseTimeOfDay(at, "--at"), weekdays: parseWeekdays(options.weekly ?? "") };
}

function resolveDefaultTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatSchedule(schedule: RuntimeSchedule, now: number): JsonRecord {
	return {
		id: schedule.id,
		name: schedule.name,
		enabled: schedule.enabled,
		description: describeSchedule(schedule.recurrence, schedule.timezone),
		recurrence: schedule.recurrence,
		timezone: schedule.timezone,
		overlapPolicy: schedule.overlapPolicy,
		nextRunAt: schedule.enabled ? getNextOccurrence(schedule.recurrence, schedule.timezone, now) : null,
		lastRunAt: schedule.lastRunAt,
		lastTaskId: schedule.lastTaskId,
		lastStatus: schedule.lastStatus,
		lastError: schedule.lastError,
		task: schedule.task,
	};
}

async function resolveWorkspaceId(projectPath: string | undefined, autoCreate: boolean): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, process.cwd(), {
		autoCreateIfMissing: autoCreate,
	});
	return workspace.workspaceId;
}

async function listSchedules(options: ScheduleCommonOptions): Promise<JsonRecord> {
	const workspaceId = await resolveWorkspaceId(options.projectPath, false);
	const schedules = await loadWorkspaceSchedules(workspaceId);
	const now = Date.now();
	return {
		ok: true,
		serverTimezone: resolveDefaultTimezone(),
		count: schedules.length,
		schedules: schedules.map((schedule) => formatSchedule(schedule, now)),
	};
}

interface CreateScheduleOptions extends ScheduleCommonOptions {
	name: string;
	prompt: string;
	title?: string;
	daily?: string;
	weekly?: string;
	at?: string;
	cron?: string;
	timezone?: string;
	baseRef?: string;
	agentId?: string;
	autoReviewMode?: string;
	overlap?: string;
	planMode?: boolean;
	disabled?: boolean;
}

async function createSchedule(options: CreateScheduleOptions): Promise<JsonRecord> {
	const recurrence = buildRecurrence(options);
	if (!recurrence) {
		throw new Error("schedule create requires one of --daily, --weekly or --cron.");
	}
	const timezone = options.timezone?.trim() || resolveDefaultTimezone();
	const validation = validateSchedule(recurrence, timezone);
	if (!validation.ok) {
		throw new Error(validation.error);
	}

	const workspaceId = await resolveWorkspaceId(options.projectPath, true);
	const now = Date.now();
	const created = await mutateWorkspaceSchedules(workspaceId, (schedules) => {
		const schedule: RuntimeSchedule = {
			id: createUniqueTaskId(new Set(schedules.map((entry) => entry.id)), () => globalThis.crypto.randomUUID()),
			name: options.name,
			enabled: options.disabled !== true,
			recurrence,
			timezone,
			overlapPolicy: parseOverlapPolicy(options.overlap) ?? "skip",
			task: {
				prompt: options.prompt,
				...(options.title ? { title: options.title } : {}),
				startInPlanMode: options.planMode === true,
				autoReviewMode: parseAutoReviewMode(options.autoReviewMode) ?? "pr",
				...(parseAgentId(options.agentId) ? { agentId: parseAgentId(options.agentId) } : {}),
				baseRef: options.baseRef?.trim() || null,
			},
			lastRunAt: null,
			lastTaskId: null,
			lastStatus: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		};
		return { schedules: [...schedules, schedule], value: schedule };
	});

	return { ok: true, schedule: formatSchedule(created, now) };
}

interface UpdateScheduleOptions extends ScheduleCommonOptions {
	id: string;
	name?: string;
	prompt?: string;
	title?: string;
	daily?: string;
	weekly?: string;
	at?: string;
	cron?: string;
	timezone?: string;
	baseRef?: string;
	agentId?: string;
	autoReviewMode?: string;
	overlap?: string;
	planMode?: boolean;
}

async function updateSchedule(options: UpdateScheduleOptions): Promise<JsonRecord> {
	const workspaceId = await resolveWorkspaceId(options.projectPath, false);
	const recurrence = buildRecurrence(options);
	const now = Date.now();

	const updated = await mutateWorkspaceSchedules(workspaceId, (schedules) => {
		const existing = schedules.find((entry) => entry.id === options.id);
		if (!existing) {
			return { schedules, value: null, save: false };
		}
		const next: RuntimeSchedule = {
			...existing,
			name: options.name ?? existing.name,
			recurrence: recurrence ?? existing.recurrence,
			timezone: options.timezone?.trim() || existing.timezone,
			overlapPolicy: parseOverlapPolicy(options.overlap) ?? existing.overlapPolicy,
			task: {
				...existing.task,
				prompt: options.prompt ?? existing.task.prompt,
				...(options.title ? { title: options.title } : {}),
				startInPlanMode: options.planMode ?? existing.task.startInPlanMode,
				autoReviewMode: parseAutoReviewMode(options.autoReviewMode) ?? existing.task.autoReviewMode,
				...(options.agentId ? { agentId: parseAgentId(options.agentId) } : {}),
				baseRef: options.baseRef === undefined ? existing.task.baseRef : options.baseRef.trim() || null,
			},
			updatedAt: now,
		};
		return {
			schedules: schedules.map((entry) => (entry.id === next.id ? next : entry)),
			value: next,
		};
	});

	if (!updated) {
		throw new Error(`Schedule "${options.id}" was not found.`);
	}
	const validation = validateSchedule(updated.recurrence, updated.timezone);
	if (!validation.ok) {
		throw new Error(validation.error);
	}
	return { ok: true, schedule: formatSchedule(updated, now) };
}

async function setScheduleEnabled(
	options: ScheduleCommonOptions & { id: string },
	enabled: boolean,
): Promise<JsonRecord> {
	const workspaceId = await resolveWorkspaceId(options.projectPath, false);
	const now = Date.now();
	const updated = await mutateWorkspaceSchedules(workspaceId, (schedules) => {
		const existing = schedules.find((entry) => entry.id === options.id);
		if (!existing) {
			return { schedules, value: null, save: false };
		}
		const next: RuntimeSchedule = { ...existing, enabled, updatedAt: now };
		return { schedules: schedules.map((entry) => (entry.id === next.id ? next : entry)), value: next };
	});
	if (!updated) {
		throw new Error(`Schedule "${options.id}" was not found.`);
	}
	return { ok: true, schedule: formatSchedule(updated, now) };
}

async function deleteSchedule(options: ScheduleCommonOptions & { id: string }): Promise<JsonRecord> {
	const workspaceId = await resolveWorkspaceId(options.projectPath, false);
	const removed = await mutateWorkspaceSchedules(workspaceId, (schedules) => {
		const next = schedules.filter((entry) => entry.id !== options.id);
		if (next.length === schedules.length) {
			return { schedules, value: false, save: false };
		}
		return { schedules: next, value: true };
	});
	if (!removed) {
		throw new Error(`Schedule "${options.id}" was not found.`);
	}
	return { ok: true, removed: true, id: options.id };
}

async function runScheduleNow(options: ScheduleCommonOptions & { id: string }): Promise<JsonRecord> {
	const workspaceId = await resolveWorkspaceId(options.projectPath, false);
	const client = createRuntimeTrpcClient(workspaceId);
	const result = await client.schedules.runNow.mutate({ scheduleId: options.id });
	return {
		ok: result.ok,
		status: result.status,
		taskId: result.taskId,
		...(result.error ? { error: result.error } : {}),
	};
}

export function registerScheduleCommand(program: Command): void {
	const schedule = program
		.command("schedule")
		.alias("schedules")
		.description("Manage recurring Kanban tasks from the CLI.");

	const withCommonOptions = (command: Command): Command =>
		command.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.");

	const withRecurrenceOptions = (command: Command): Command =>
		command
			.option("--daily <HH:MM>", "Run every day at this local time.")
			.option("--weekly <days>", "Run on these weekdays (0-6 or mon,wed,fri). Requires --at.")
			.option("--at <HH:MM>", "Time of day for --weekly.")
			.option("--cron <expression>", "Standard 5-field cron expression.")
			.option("--timezone <zone>", "IANA timezone. Defaults to this machine's zone.");

	const withTaskOptions = (command: Command): Command =>
		command
			.option("--title <text>", "Task title. Defaults to a title derived from the prompt.")
			.option("--base-ref <branch>", "Base branch. Defaults to the repository default branch at run time.")
			.option("--agent-id <id>", `Agent override: ${VALID_AGENT_IDS.join(" | ")} | default.`)
			.option("--auto-review-mode <mode>", "What to do when the task finishes: commit | pr. Defaults to pr.")
			.option("--overlap <policy>", "When the previous run is still active: skip | allow. Defaults to skip.")
			.option("--plan-mode", "Start the task in plan mode.");

	withCommonOptions(schedule.command("list").description("List recurring schedules for a workspace.")).action(
		async (options: ScheduleCommonOptions) => {
			await runCliCommand("Schedule command", async () => await listSchedules(options));
		},
	);

	withTaskOptions(
		withRecurrenceOptions(
			withCommonOptions(schedule.command("create").description("Create a recurring schedule."))
				.requiredOption("--name <text>", "Schedule name.")
				.requiredOption("--prompt <text>", "Task prompt to run on each occurrence."),
		),
	)
		.option("--disabled", "Create the schedule without enabling it.")
		.action(async (options: CreateScheduleOptions) => {
			await runCliCommand("Schedule command", async () => await createSchedule(options));
		});

	withTaskOptions(
		withRecurrenceOptions(
			withCommonOptions(schedule.command("update").description("Update an existing schedule."))
				.requiredOption("--id <id>", "Schedule ID.")
				.option("--name <text>", "Replacement schedule name.")
				.option("--prompt <text>", "Replacement task prompt."),
		),
	).action(async (options: UpdateScheduleOptions) => {
		await runCliCommand("Schedule command", async () => await updateSchedule(options));
	});

	withCommonOptions(schedule.command("enable").description("Enable a schedule."))
		.requiredOption("--id <id>", "Schedule ID.")
		.action(async (options: ScheduleCommonOptions & { id: string }) => {
			await runCliCommand("Schedule command", async () => await setScheduleEnabled(options, true));
		});

	withCommonOptions(schedule.command("disable").description("Disable a schedule without deleting it."))
		.requiredOption("--id <id>", "Schedule ID.")
		.action(async (options: ScheduleCommonOptions & { id: string }) => {
			await runCliCommand("Schedule command", async () => await setScheduleEnabled(options, false));
		});

	withCommonOptions(schedule.command("delete").alias("remove").description("Delete a schedule."))
		.requiredOption("--id <id>", "Schedule ID.")
		.action(async (options: ScheduleCommonOptions & { id: string }) => {
			await runCliCommand("Schedule command", async () => await deleteSchedule(options));
		});

	withCommonOptions(
		schedule.command("run").description("Run a schedule immediately, ignoring its enabled flag and overlap policy."),
	)
		.requiredOption("--id <id>", "Schedule ID.")
		.action(async (options: ScheduleCommonOptions & { id: string }) => {
			await runCliCommand("Schedule command", async () => await runScheduleNow(options));
		});
}
