import { useId, useMemo } from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeScheduleRecurrence } from "@/runtime/types";

// Recurrence editor: Daily / Weekly / Custom cron.
//
// Recurrence is persisted as a structured union rather than a cron string, so the two
// common shapes need no parsing round-trip and the UI needs no cron library. Only the
// Custom tab holds a raw expression, and the server validates it.

const RECURRENCE_KINDS: Array<{ kind: RuntimeScheduleRecurrence["kind"]; label: string }> = [
	{ kind: "daily", label: "Daily" },
	{ kind: "weekly", label: "Weekly" },
	{ kind: "cron", label: "Custom" },
];

// Index is the cron weekday number, 0 = Sunday.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTimeValue(hour: number, minute: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimeValue(value: string): { hour: number; minute: number } | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (!match) {
		return null;
	}
	const hour = Number.parseInt(match[1] ?? "", 10);
	const minute = Number.parseInt(match[2] ?? "", 10);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		return null;
	}
	return { hour, minute };
}

function listTimezones(): string[] {
	// supportedValuesOf is not in every runtime's lib typings yet.
	const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
	return supported ? supported("timeZone") : [];
}

export interface ScheduleRecurrencePickerProps {
	recurrence: RuntimeScheduleRecurrence;
	timezone: string;
	serverTimezone: string;
	onRecurrenceChange: (recurrence: RuntimeScheduleRecurrence) => void;
	onTimezoneChange: (timezone: string) => void;
}

export function ScheduleRecurrencePicker({
	recurrence,
	timezone,
	serverTimezone,
	onRecurrenceChange,
	onTimezoneChange,
}: ScheduleRecurrencePickerProps): React.ReactElement {
	const timeInputId = useId();
	const timezoneId = useId();
	const cronId = useId();
	const timezones = useMemo(() => {
		const all = listTimezones();
		const preferred = [...new Set([serverTimezone, "UTC", timezone])].filter((zone) => zone.length > 0);
		return all.length > 0 ? [...new Set([...preferred, ...all])] : preferred;
	}, [serverTimezone, timezone]);

	const time = recurrence.kind === "cron" ? null : formatTimeValue(recurrence.hour, recurrence.minute);

	const changeKind = (kind: RuntimeScheduleRecurrence["kind"]): void => {
		if (kind === recurrence.kind) {
			return;
		}
		const carried =
			recurrence.kind === "cron" ? { hour: 2, minute: 0 } : { hour: recurrence.hour, minute: recurrence.minute };
		if (kind === "daily") {
			onRecurrenceChange({ kind: "daily", ...carried });
			return;
		}
		if (kind === "weekly") {
			onRecurrenceChange({ kind: "weekly", ...carried, weekdays: [1] });
			return;
		}
		onRecurrenceChange({ kind: "cron", expression: "0 2 * * *" });
	};

	const changeTime = (value: string): void => {
		const parsed = parseTimeValue(value);
		if (!parsed || recurrence.kind === "cron") {
			return;
		}
		onRecurrenceChange({ ...recurrence, ...parsed });
	};

	const toggleWeekday = (weekday: number): void => {
		if (recurrence.kind !== "weekly") {
			return;
		}
		const selected = new Set(recurrence.weekdays);
		if (selected.has(weekday)) {
			// Never leave a weekly schedule with no days, or it can never fire.
			if (selected.size === 1) {
				return;
			}
			selected.delete(weekday);
		} else {
			selected.add(weekday);
		}
		onRecurrenceChange({ ...recurrence, weekdays: [...selected].sort((a, b) => a - b) });
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex gap-1 rounded-md bg-surface-2 p-0.5 w-fit">
				{RECURRENCE_KINDS.map(({ kind, label }) => (
					<button
						key={kind}
						type="button"
						onClick={() => changeKind(kind)}
						className={cn(
							"px-3 h-7 rounded-sm text-[12px] transition-colors",
							recurrence.kind === kind
								? "bg-surface-4 text-text-primary"
								: "text-text-secondary hover:text-text-primary hover:bg-surface-3",
						)}
					>
						{label}
					</button>
				))}
			</div>

			{recurrence.kind === "weekly" ? (
				<div className="flex flex-wrap gap-1">
					{WEEKDAYS.map((label, weekday) => (
						<button
							key={label}
							type="button"
							onClick={() => toggleWeekday(weekday)}
							aria-pressed={recurrence.weekdays.includes(weekday)}
							className={cn(
								"px-2.5 h-7 rounded-md border text-[12px] transition-colors",
								recurrence.weekdays.includes(weekday)
									? "border-accent bg-accent/15 text-text-primary"
									: "border-border bg-surface-2 text-text-secondary hover:bg-surface-3",
							)}
						>
							{label}
						</button>
					))}
				</div>
			) : null}

			{recurrence.kind === "cron" ? (
				<div className="flex flex-col gap-1">
					<label htmlFor={cronId} className="text-[12px] text-text-secondary">
						Cron expression
					</label>
					<input
						id={cronId}
						value={recurrence.expression}
						onChange={(event) => onRecurrenceChange({ kind: "cron", expression: event.target.value })}
						spellCheck={false}
						placeholder="0 2 * * *"
						className="h-8 rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] font-mono text-text-primary focus:border-border-focus focus:outline-none"
					/>
					<p className="text-[11px] text-text-tertiary">Five fields: minute hour day month weekday.</p>
				</div>
			) : (
				<div className="flex flex-col gap-1 w-fit">
					<label htmlFor={timeInputId} className="text-[12px] text-text-secondary">
						Time
					</label>
					<input
						id={timeInputId}
						type="time"
						value={time ?? "02:00"}
						onChange={(event) => changeTime(event.target.value)}
						className="h-8 rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
					/>
				</div>
			)}

			<div className="flex flex-col gap-1">
				<label htmlFor={timezoneId} className="text-[12px] text-text-secondary">
					Timezone
				</label>
				<NativeSelect
					id={timezoneId}
					value={timezone}
					onChange={(event) => onTimezoneChange(event.target.value)}
					fill
				>
					{timezones.map((zone) => (
						<option key={zone} value={zone}>
							{zone}
						</option>
					))}
				</NativeSelect>
				<p className="text-[11px] text-text-tertiary">
					Wall-clock time in this zone. It stays at the same local time across daylight saving; pick UTC if you
					need a fixed offset.
				</p>
			</div>
		</div>
	);
}
