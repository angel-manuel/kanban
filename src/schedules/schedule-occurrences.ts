import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

import type { RuntimeScheduleRecurrence } from "../core/api-contract";

// Cron parsing, occurrence maths and human-readable descriptions.
//
// This is the only module allowed to import `cron-parser` / `cronstrue`. Both are server
// side: cron-parser pulls in luxon, and the web UI has its own node_modules, so keeping
// them here is what stops a date library ending up in the browser bundle. The UI gets a
// precomputed `nextRunAt` epoch and a `description` string instead.
//
// Daily and weekly recurrences compile down to cron so there is exactly one occurrence
// engine, and therefore one set of daylight-saving edge cases to reason about.
//
// Daylight saving, verified against cron-parser 5 for America/New_York in 2026 and pinned
// by schedule-occurrences.test.ts:
//
//   Spring forward (2026-03-08, local 02:00 does not exist): a `0 2 * * *` schedule fires
//   at 03:00 local that day. The day is not skipped.
//
//   Fall back (2026-11-01, local 01:30 happens twice): a `30 1 * * *` schedule fires once,
//   on the first pass.
//
// So a wall-clock schedule fires exactly once a day through both transitions, which is
// what users expect. Storing the IANA zone rather than a fixed offset is what buys that.

// Guards against an expression whose occurrences are so sparse that walking a window
// becomes a spin. Nothing legitimate needs this many steps in one tick.
const MAX_WINDOW_ITERATIONS = 1000;

export function toCronExpression(recurrence: RuntimeScheduleRecurrence): string {
	switch (recurrence.kind) {
		case "daily":
			return `${recurrence.minute} ${recurrence.hour} * * *`;
		case "weekly": {
			const weekdays = [...new Set(recurrence.weekdays)].sort((a, b) => a - b).join(",");
			return `${recurrence.minute} ${recurrence.hour} * * ${weekdays}`;
		}
		case "cron":
			return recurrence.expression.trim();
	}
}

// cron-parser happily accepts 4-field, 6-field (seconds-precision) and even empty
// expressions. That is too permissive here: an empty or seconds-precision expression means
// "every minute", and this scheduler launches coding agents. Require standard 5-field cron
// so a typo fails loudly at save time instead of starting an agent every minute.
const CRON_FIELD_COUNT = 5;

function validateCronFieldCount(recurrence: RuntimeScheduleRecurrence): string | null {
	if (recurrence.kind !== "cron") {
		return null;
	}
	const fields = recurrence.expression
		.trim()
		.split(/\s+/)
		.filter((field) => field.length > 0);
	if (fields.length !== CRON_FIELD_COUNT) {
		return `Expected ${CRON_FIELD_COUNT} cron fields (minute hour day month weekday), got ${fields.length}.`;
	}
	return null;
}

export function validateSchedule(
	recurrence: RuntimeScheduleRecurrence,
	timezone: string,
): { ok: true } | { ok: false; error: string } {
	const fieldCountError = validateCronFieldCount(recurrence);
	if (fieldCountError) {
		return { ok: false, error: fieldCountError };
	}
	try {
		CronExpressionParser.parse(toCronExpression(recurrence), { tz: timezone, currentDate: new Date() });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// Next fire time strictly after `after`, or null when the expression or zone is unusable.
export function getNextOccurrence(
	recurrence: RuntimeScheduleRecurrence,
	timezone: string,
	after: number,
): number | null {
	try {
		const iterator = CronExpressionParser.parse(toCronExpression(recurrence), {
			tz: timezone,
			currentDate: new Date(after),
		});
		return iterator.next().toDate().getTime();
	} catch {
		return null;
	}
}

/**
 * The most recent occurrence in the half-open window `(afterExclusive, untilInclusive]`,
 * or null when the schedule was not due in it.
 *
 * Returning only the latest is deliberate. If the process was busy across several
 * occurrences of a frequent schedule, firing all of them at once to "catch up" is never
 * what anyone wants - and it would contradict the skip-missed-runs policy.
 *
 * Throws when the expression or timezone is invalid, so callers can record that on the
 * schedule instead of silently never firing.
 */
export function findLatestOccurrenceInWindow(
	recurrence: RuntimeScheduleRecurrence,
	timezone: string,
	afterExclusive: number,
	untilInclusive: number,
): number | null {
	if (untilInclusive <= afterExclusive) {
		return null;
	}
	const iterator = CronExpressionParser.parse(toCronExpression(recurrence), {
		tz: timezone,
		currentDate: new Date(afterExclusive),
	});
	let latest: number | null = null;
	for (let step = 0; step < MAX_WINDOW_ITERATIONS; step += 1) {
		const occurrence = iterator.next().toDate().getTime();
		if (occurrence > untilInclusive) {
			return latest;
		}
		latest = occurrence;
	}
	return latest;
}

export function describeSchedule(recurrence: RuntimeScheduleRecurrence, timezone: string): string {
	try {
		return `${cronstrue.toString(toCronExpression(recurrence), { verbose: false })} (${timezone})`;
	} catch {
		return `${toCronExpression(recurrence)} (${timezone})`;
	}
}
