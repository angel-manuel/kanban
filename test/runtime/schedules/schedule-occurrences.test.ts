import { describe, expect, it } from "vitest";

import type { RuntimeScheduleRecurrence } from "../../../src/core/api-contract";
import {
	describeSchedule,
	findLatestOccurrenceInWindow,
	getNextOccurrence,
	toCronExpression,
	validateSchedule,
} from "../../../src/schedules/schedule-occurrences";

const DAILY_2AM: RuntimeScheduleRecurrence = { kind: "daily", hour: 2, minute: 0 };

function at(iso: string): number {
	return new Date(iso).getTime();
}

function iso(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

describe("toCronExpression", () => {
	it("compiles a daily recurrence", () => {
		expect(toCronExpression(DAILY_2AM)).toBe("0 2 * * *");
	});

	it("compiles a weekly recurrence, sorted and deduplicated", () => {
		expect(toCronExpression({ kind: "weekly", hour: 9, minute: 30, weekdays: [5, 1, 1, 3] })).toBe("30 9 * * 1,3,5");
	});

	it("passes a raw cron expression through", () => {
		expect(toCronExpression({ kind: "cron", expression: "  */15 * * * *  " })).toBe("*/15 * * * *");
	});
});

describe("validateSchedule", () => {
	it("accepts a valid expression and zone", () => {
		expect(validateSchedule(DAILY_2AM, "Europe/Madrid")).toEqual({ ok: true });
	});

	it.each([["not a cron"], ["99 * * * *"]])("rejects the malformed expression %s without throwing", (expression) => {
		expect(validateSchedule({ kind: "cron", expression }, "UTC").ok).toBe(false);
	});

	// cron-parser itself accepts all of these, reading them as "every minute". For a
	// scheduler that launches coding agents that is a footgun, so we require 5 fields.
	it.each([["* * * *"], ["0 2 * * * *"], [""], ["   "]])("rejects the non-5-field expression %s", (expression) => {
		const result = validateSchedule({ kind: "cron", expression }, "UTC");
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("5 cron fields");
	});

	it("accepts a valid 5-field expression", () => {
		expect(validateSchedule({ kind: "cron", expression: "*/15 * * * *" }, "UTC")).toEqual({ ok: true });
	});

	it("rejects an unknown timezone without throwing", () => {
		expect(validateSchedule(DAILY_2AM, "Mars/Olympus_Mons").ok).toBe(false);
	});
});

describe("getNextOccurrence", () => {
	it("returns the next wall-clock occurrence in the given zone", () => {
		expect(iso(getNextOccurrence(DAILY_2AM, "UTC", at("2026-06-01T12:00:00Z")))).toBe("2026-06-02T02:00:00.000Z");
		// Madrid is UTC+2 in June, so 02:00 local is 00:00Z.
		expect(iso(getNextOccurrence(DAILY_2AM, "Europe/Madrid", at("2026-06-01T12:00:00Z")))).toBe(
			"2026-06-02T00:00:00.000Z",
		);
	});

	it("returns null rather than throwing on an invalid expression", () => {
		expect(getNextOccurrence({ kind: "cron", expression: "nope" }, "UTC", at("2026-06-01T12:00:00Z"))).toBeNull();
	});
});

// These assertions document the behaviour rather than merely checking it: a wall-clock
// schedule must fire exactly once a day through both daylight-saving transitions. If a
// cron-parser upgrade changes either of these, that is a behaviour change users will feel.
describe("daylight saving in America/New_York (2026)", () => {
	it("still fires on the spring-forward day, shifted to 03:00 local", () => {
		// 2026-03-08: local 02:00 does not exist.
		const occurrences: Array<string | null> = [];
		let cursor = at("2026-03-06T12:00:00Z");
		for (let day = 0; day < 4; day += 1) {
			const next = getNextOccurrence(DAILY_2AM, "America/New_York", cursor);
			occurrences.push(iso(next));
			cursor = next ?? cursor;
		}
		expect(occurrences).toEqual([
			"2026-03-07T07:00:00.000Z", // 02:00 EST
			"2026-03-08T07:00:00.000Z", // 03:00 EDT - the day is not skipped
			"2026-03-09T06:00:00.000Z", // 02:00 EDT
			"2026-03-10T06:00:00.000Z",
		]);
	});

	it("fires once, not twice, on the fall-back day", () => {
		// 2026-11-01: local 01:30 happens twice.
		const halfPastOne: RuntimeScheduleRecurrence = { kind: "daily", hour: 1, minute: 30 };
		const occurrences: Array<string | null> = [];
		let cursor = at("2026-10-30T12:00:00Z");
		for (let day = 0; day < 4; day += 1) {
			const next = getNextOccurrence(halfPastOne, "America/New_York", cursor);
			occurrences.push(iso(next));
			cursor = next ?? cursor;
		}
		expect(occurrences).toEqual([
			"2026-10-31T05:30:00.000Z", // 01:30 EDT
			"2026-11-01T05:30:00.000Z", // 01:30 EDT, the first pass only
			"2026-11-02T06:30:00.000Z", // 01:30 EST
			"2026-11-03T06:30:00.000Z",
		]);
	});

	it("fires exactly once per day across the whole spring-forward week", () => {
		let cursor = at("2026-03-05T12:00:00Z");
		const days = new Set<string>();
		for (let step = 0; step < 7; step += 1) {
			const next = getNextOccurrence(DAILY_2AM, "America/New_York", cursor);
			expect(next).not.toBeNull();
			cursor = next ?? cursor;
			days.add(new Date(cursor).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
		}
		expect(days.size).toBe(7);
	});
});

describe("findLatestOccurrenceInWindow", () => {
	it("returns null when the schedule was not due in the window", () => {
		expect(
			findLatestOccurrenceInWindow(DAILY_2AM, "UTC", at("2026-06-02T03:00:00Z"), at("2026-06-02T04:00:00Z")),
		).toBeNull();
	});

	it("returns the occurrence inside the window", () => {
		expect(
			iso(findLatestOccurrenceInWindow(DAILY_2AM, "UTC", at("2026-06-02T01:59:00Z"), at("2026-06-02T02:01:00Z"))),
		).toBe("2026-06-02T02:00:00.000Z");
	});

	// The window is half-open: an occurrence exactly on the lower bound already fired on
	// the previous tick and must not fire again.
	it("excludes the lower bound and includes the upper bound", () => {
		expect(
			findLatestOccurrenceInWindow(DAILY_2AM, "UTC", at("2026-06-02T02:00:00Z"), at("2026-06-02T02:00:00Z")),
		).toBeNull();
		expect(
			iso(findLatestOccurrenceInWindow(DAILY_2AM, "UTC", at("2026-06-02T01:00:00Z"), at("2026-06-02T02:00:00Z"))),
		).toBe("2026-06-02T02:00:00.000Z");
	});

	it("collapses several occurrences in one window to the most recent", () => {
		expect(
			iso(
				findLatestOccurrenceInWindow(
					{ kind: "cron", expression: "* * * * *" },
					"UTC",
					at("2026-06-02T02:00:00Z"),
					at("2026-06-02T02:05:00Z"),
				),
			),
		).toBe("2026-06-02T02:05:00.000Z");
	});

	it("returns null for an empty or inverted window", () => {
		expect(
			findLatestOccurrenceInWindow(DAILY_2AM, "UTC", at("2026-06-02T05:00:00Z"), at("2026-06-02T04:00:00Z")),
		).toBeNull();
	});

	it("throws on an invalid expression so the caller can record it", () => {
		expect(() => findLatestOccurrenceInWindow({ kind: "cron", expression: "nope" }, "UTC", 0, 1)).toThrow();
	});
});

describe("describeSchedule", () => {
	it("renders a human-readable description with the zone", () => {
		expect(describeSchedule(DAILY_2AM, "Europe/Madrid")).toBe("At 02:00 AM (Europe/Madrid)");
	});

	it("falls back to the raw expression when it cannot be described", () => {
		expect(describeSchedule({ kind: "cron", expression: "nope" }, "UTC")).toBe("nope (UTC)");
	});
});
