import type {
	RuntimeBoardColumnId,
	RuntimeSchedule,
	RuntimeScheduleOverlapPolicy,
	RuntimeScheduleRecurrence,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";

// Pure decision logic for "which schedules are due right now?".
//
// Due-ness is defined over the half-open window `(windowStart, now]` rather than "is it
// approximately HH:MM?". That makes the poll interval an implementation detail instead of a
// correctness hazard: a 30-second tick and a 90-second tick select the same occurrences,
// and an occurrence can never fire twice because the next window starts where this one
// ended.
//
// Missed runs are skipped by design. The caller seeds `previousTickAt` with the process
// start time, so an occurrence from before the runtime was up is never in any window. The
// lookback clamp then covers the other direction: a laptop that slept through the night
// wakes to one enormous window, and firing everything in it would be exactly the catch-up
// behaviour we decided against.

export interface ScheduleTickInput {
	schedules: readonly RuntimeSchedule[];
	// Exclusive lower bound - the instant the previous tick examined up to.
	previousTickAt: number;
	// Inclusive upper bound.
	now: number;
	maxLookbackMs: number;
	findLatestOccurrence: (
		recurrence: RuntimeScheduleRecurrence,
		timezone: string,
		afterExclusive: number,
		untilInclusive: number,
	) => number | null;
}

export interface DueScheduleOccurrence {
	scheduleId: string;
	occurrenceAt: number;
}

export interface InvalidSchedule {
	scheduleId: string;
	error: string;
}

export interface ScheduleTickDecision {
	// What the caller should use as the next tick's `previousTickAt`.
	nextTickAt: number;
	// The lower bound actually used, after clamping.
	windowStart: number;
	due: DueScheduleOccurrence[];
	invalid: InvalidSchedule[];
	clockWentBackwards: boolean;
	windowWasClamped: boolean;
}

export function decideScheduleTick(input: ScheduleTickInput): ScheduleTickDecision {
	const { now, previousTickAt } = input;

	// A backwards clock jump (NTP correction, manual change) would otherwise make the
	// window inverted or absurdly wide. Snap the cursor forward and fire nothing.
	if (now <= previousTickAt) {
		return {
			nextTickAt: now,
			windowStart: now,
			due: [],
			invalid: [],
			clockWentBackwards: now < previousTickAt,
			windowWasClamped: false,
		};
	}

	const windowWasClamped = now - previousTickAt > input.maxLookbackMs;
	const windowStart = windowWasClamped ? now - input.maxLookbackMs : previousTickAt;

	const due: DueScheduleOccurrence[] = [];
	const invalid: InvalidSchedule[] = [];

	for (const schedule of input.schedules) {
		if (!schedule.enabled) {
			continue;
		}
		try {
			const occurrenceAt = input.findLatestOccurrence(schedule.recurrence, schedule.timezone, windowStart, now);
			if (occurrenceAt !== null) {
				due.push({ scheduleId: schedule.id, occurrenceAt });
			}
		} catch (error) {
			// One unusable expression must never hide the other schedules.
			invalid.push({
				scheduleId: schedule.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		nextTickAt: now,
		windowStart,
		due,
		invalid,
		clockWentBackwards: false,
		windowWasClamped,
	};
}

export type ScheduleOverlapDecision = "run" | "skip_overlap";

/**
 * Whether a due schedule should run while its previous task may still be going.
 *
 * "skip" is the default because the alternative is unbounded: a nightly job that takes
 * longer than a day would otherwise accumulate a worktree and an agent session per night.
 * A previous task sitting in backlog means its launch failed, so that does not block.
 */
export function decideScheduleOverlap(input: {
	policy: RuntimeScheduleOverlapPolicy;
	lastTaskColumnId: RuntimeBoardColumnId | null;
	lastTaskSessionState: RuntimeTaskSessionSummary["state"] | null;
}): ScheduleOverlapDecision {
	if (input.policy === "allow") {
		return "run";
	}
	if (input.lastTaskColumnId === "in_progress" || input.lastTaskColumnId === "review") {
		return "skip_overlap";
	}
	if (input.lastTaskSessionState === "running" || input.lastTaskSessionState === "awaiting_review") {
		return "skip_overlap";
	}
	return "run";
}
