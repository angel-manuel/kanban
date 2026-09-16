import { describe, expect, it } from "vitest";

import type { RuntimeSchedule } from "../../../src/core/api-contract";
import { decideScheduleOverlap, decideScheduleTick } from "../../../src/schedules/schedule-firing";
import { findLatestOccurrenceInWindow } from "../../../src/schedules/schedule-occurrences";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_LOOKBACK_MS = 3 * 30_000;

function at(iso: string): number {
	return new Date(iso).getTime();
}

function schedule(overrides: Partial<RuntimeSchedule> = {}): RuntimeSchedule {
	return {
		id: "sched-1",
		name: "Nightly refactor",
		enabled: true,
		recurrence: { kind: "daily", hour: 2, minute: 0 },
		timezone: "UTC",
		overlapPolicy: "skip",
		task: {
			prompt: "Refactor big files",
			startInPlanMode: false,
			autoReviewMode: "pr",
			baseRef: null,
		},
		lastRunAt: null,
		lastTaskId: null,
		lastStatus: null,
		lastError: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function tick(overrides: Partial<Parameters<typeof decideScheduleTick>[0]> = {}) {
	return decideScheduleTick({
		schedules: [schedule()],
		previousTickAt: at("2026-06-02T01:59:30Z"),
		now: at("2026-06-02T02:00:30Z"),
		maxLookbackMs: MAX_LOOKBACK_MS,
		findLatestOccurrence: findLatestOccurrenceInWindow,
		...overrides,
	});
}

describe("decideScheduleTick", () => {
	it("selects a schedule whose occurrence falls in the window", () => {
		const decision = tick();
		expect(decision.due).toEqual([{ scheduleId: "sched-1", occurrenceAt: at("2026-06-02T02:00:00Z") }]);
	});

	it("selects nothing when no occurrence falls in the window", () => {
		expect(tick({ previousTickAt: at("2026-06-02T03:00:00Z"), now: at("2026-06-02T03:00:30Z") }).due).toEqual([]);
	});

	// The half-open window is what makes exactly-once work regardless of poll interval.
	it("fires an occurrence exactly once across consecutive ticks", () => {
		const first = tick();
		expect(first.due).toHaveLength(1);
		const second = tick({ previousTickAt: first.nextTickAt, now: first.nextTickAt + 30_000 });
		expect(second.due).toEqual([]);
	});

	it("selects the same occurrence whichever poll interval is used", () => {
		const fast = tick({ previousTickAt: at("2026-06-02T01:59:45Z"), now: at("2026-06-02T02:00:15Z") });
		const slow = decideScheduleTick({
			schedules: [schedule()],
			previousTickAt: at("2026-06-02T01:58:00Z"),
			now: at("2026-06-02T02:01:00Z"),
			maxLookbackMs: 10 * MINUTE,
			findLatestOccurrence: findLatestOccurrenceInWindow,
		});
		expect(fast.due).toEqual(slow.due);
	});

	it("ignores a disabled schedule entirely", () => {
		expect(tick({ schedules: [schedule({ enabled: false })] }).due).toEqual([]);
	});

	// Startup must not backfill: the caller seeds previousTickAt with the process start
	// time, so last night's 02:00 is not in any window.
	it("does not fire an occurrence from before the process started", () => {
		const bootedAt = at("2026-06-02T09:00:00Z");
		const decision = tick({ previousTickAt: bootedAt, now: bootedAt + 30_000 });
		expect(decision.due).toEqual([]);
	});

	// Waking from an eight-hour sleep must not replay the night. The clamp narrows the
	// window to the lookback, so at most the occurrence that just came due survives.
	it("clamps a long gap to a single run instead of catching up on everything missed", () => {
		const decision = decideScheduleTick({
			schedules: [schedule({ recurrence: { kind: "cron", expression: "0 * * * *" } })],
			previousTickAt: at("2026-06-02T00:00:00Z"),
			now: at("2026-06-02T08:00:30Z"),
			maxLookbackMs: MAX_LOOKBACK_MS,
			findLatestOccurrence: findLatestOccurrenceInWindow,
		});
		expect(decision.windowWasClamped).toBe(true);
		expect(decision.windowStart).toBe(at("2026-06-02T08:00:30Z") - MAX_LOOKBACK_MS);
		// Eight hourly occurrences elapsed; only the one inside the lookback runs.
		expect(decision.due).toEqual([{ scheduleId: "sched-1", occurrenceAt: at("2026-06-02T08:00:00Z") }]);
	});

	it("fires nothing when the whole gap predates the lookback window", () => {
		const decision = decideScheduleTick({
			schedules: [schedule({ recurrence: { kind: "cron", expression: "0 * * * *" } })],
			previousTickAt: at("2026-06-02T00:00:00Z"),
			now: at("2026-06-02T08:30:00Z"),
			maxLookbackMs: MAX_LOOKBACK_MS,
			findLatestOccurrence: findLatestOccurrenceInWindow,
		});
		expect(decision.windowWasClamped).toBe(true);
		expect(decision.due).toEqual([]);
	});

	it("still fires a recent occurrence after a short gap inside the lookback", () => {
		const decision = decideScheduleTick({
			schedules: [schedule()],
			previousTickAt: at("2026-06-02T01:59:00Z"),
			now: at("2026-06-02T02:00:30Z"),
			maxLookbackMs: 5 * MINUTE,
			findLatestOccurrence: findLatestOccurrenceInWindow,
		});
		expect(decision.due).toHaveLength(1);
	});

	it("collapses several occurrences in one window into a single run", () => {
		const decision = decideScheduleTick({
			schedules: [schedule({ recurrence: { kind: "cron", expression: "* * * * *" } })],
			previousTickAt: at("2026-06-02T02:00:00Z"),
			now: at("2026-06-02T02:05:00Z"),
			maxLookbackMs: HOUR,
			findLatestOccurrence: findLatestOccurrenceInWindow,
		});
		expect(decision.due).toEqual([{ scheduleId: "sched-1", occurrenceAt: at("2026-06-02T02:05:00Z") }]);
	});

	it("fires nothing and resets the cursor when the clock jumps backwards", () => {
		const decision = tick({ previousTickAt: at("2026-06-02T05:00:00Z"), now: at("2026-06-02T02:00:30Z") });
		expect(decision.due).toEqual([]);
		expect(decision.clockWentBackwards).toBe(true);
		expect(decision.nextTickAt).toBe(at("2026-06-02T02:00:30Z"));
	});

	it("reports an unusable expression without hiding the other schedules", () => {
		const decision = tick({
			schedules: [
				schedule({ id: "bad", recurrence: { kind: "cron", expression: "nope" } }),
				schedule({ id: "good" }),
			],
		});
		expect(decision.invalid.map((entry) => entry.scheduleId)).toEqual(["bad"]);
		expect(decision.due.map((entry) => entry.scheduleId)).toEqual(["good"]);
	});
});

describe("decideScheduleOverlap", () => {
	it.each([["in_progress"], ["review"]] as const)("skips while the previous task is in %s", (columnId) => {
		expect(decideScheduleOverlap({ policy: "skip", lastTaskColumnId: columnId, lastTaskSessionState: null })).toBe(
			"skip_overlap",
		);
	});

	it.each([["running"], ["awaiting_review"]] as const)("skips while the previous session is %s", (state) => {
		expect(decideScheduleOverlap({ policy: "skip", lastTaskColumnId: "backlog", lastTaskSessionState: state })).toBe(
			"skip_overlap",
		);
	});

	// A previous task stuck in backlog means its launch failed; that must not wedge the
	// schedule shut forever.
	it("runs when the previous task never left backlog", () => {
		expect(decideScheduleOverlap({ policy: "skip", lastTaskColumnId: "backlog", lastTaskSessionState: "idle" })).toBe(
			"run",
		);
	});

	it("runs when the previous task is done", () => {
		expect(decideScheduleOverlap({ policy: "skip", lastTaskColumnId: "trash", lastTaskSessionState: null })).toBe(
			"run",
		);
	});

	it("runs when there is no previous task at all", () => {
		expect(decideScheduleOverlap({ policy: "skip", lastTaskColumnId: null, lastTaskSessionState: null })).toBe("run");
	});

	it("runs regardless under the allow policy", () => {
		expect(
			decideScheduleOverlap({ policy: "allow", lastTaskColumnId: "in_progress", lastTaskSessionState: "running" }),
		).toBe("run");
	});
});
