import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { ScheduleRecurrencePicker } from "@/components/schedules/schedule-recurrence-picker";
import type { RuntimeScheduleRecurrence } from "@/runtime/types";

describe("ScheduleRecurrencePicker", () => {
	let container: HTMLDivElement;
	let root: Root;
	let onRecurrenceChange: Mock<(recurrence: RuntimeScheduleRecurrence) => void>;
	let onTimezoneChange: Mock<(timezone: string) => void>;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onRecurrenceChange = vi.fn();
		onTimezoneChange = vi.fn();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	function render(recurrence: RuntimeScheduleRecurrence): void {
		act(() => {
			root.render(
				<ScheduleRecurrencePicker
					recurrence={recurrence}
					timezone="UTC"
					serverTimezone="UTC"
					onRecurrenceChange={onRecurrenceChange}
					onTimezoneChange={onTimezoneChange}
				/>,
			);
		});
	}

	function clickButton(text: string): void {
		const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);
		act(() => {
			button?.click();
		});
	}

	it("shows a time input for a daily recurrence", () => {
		render({ kind: "daily", hour: 2, minute: 0 });
		expect(container.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe("02:00");
	});

	it("carries the time over when switching daily to weekly", () => {
		render({ kind: "daily", hour: 9, minute: 30 });
		clickButton("Weekly");
		expect(onRecurrenceChange).toHaveBeenCalledWith({ kind: "weekly", hour: 9, minute: 30, weekdays: [1] });
	});

	it("adds a weekday when one is clicked", () => {
		render({ kind: "weekly", hour: 9, minute: 0, weekdays: [1] });
		clickButton("Wed");
		expect(onRecurrenceChange).toHaveBeenCalledWith({ kind: "weekly", hour: 9, minute: 0, weekdays: [1, 3] });
	});

	// A weekly schedule with no days could never fire, so the last one cannot be removed.
	it("refuses to clear the final weekday", () => {
		render({ kind: "weekly", hour: 9, minute: 0, weekdays: [1] });
		clickButton("Mon");
		expect(onRecurrenceChange).not.toHaveBeenCalled();
	});

	it("removes a weekday when more than one is selected", () => {
		render({ kind: "weekly", hour: 9, minute: 0, weekdays: [1, 3] });
		clickButton("Mon");
		expect(onRecurrenceChange).toHaveBeenCalledWith({ kind: "weekly", hour: 9, minute: 0, weekdays: [3] });
	});

	it("offers a raw expression field on the custom tab", () => {
		render({ kind: "cron", expression: "*/15 * * * *" });
		const input = [...container.querySelectorAll("input")].find((entry) => entry.value === "*/15 * * * *");
		expect(input).toBeDefined();
		expect(container.textContent).toContain("Five fields");
	});

	it("keeps the timezone helper text visible in every mode", () => {
		render({ kind: "cron", expression: "0 2 * * *" });
		expect(container.textContent).toContain("daylight saving");
	});
});
