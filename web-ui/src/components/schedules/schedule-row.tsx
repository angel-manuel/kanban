import * as Switch from "@radix-ui/react-switch";
import { Pencil, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeScheduleRunStatus, RuntimeScheduleSummary } from "@/runtime/types";

const STATUS_LABELS: Record<RuntimeScheduleRunStatus, string> = {
	ok: "Ran",
	failed: "Failed",
	skipped_overlap: "Skipped",
	invalid: "Invalid",
};

const STATUS_CLASSNAMES: Record<RuntimeScheduleRunStatus, string> = {
	ok: "text-status-green",
	failed: "text-status-red",
	skipped_overlap: "text-status-orange",
	invalid: "text-status-gold",
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Relative labels keep the list readable without a date library. `now` is passed in so the
// whole list re-renders from one ticking value rather than each row owning a timer.
function formatRelative(timestamp: number, now: number): string {
	const deltaMs = timestamp - now;
	const magnitude = Math.abs(deltaMs);
	const suffix = (text: string): string => (deltaMs >= 0 ? `in ${text}` : `${text} ago`);
	if (magnitude < MINUTE_MS) {
		return deltaMs >= 0 ? "in under a minute" : "just now";
	}
	if (magnitude < HOUR_MS) {
		const minutes = Math.round(magnitude / MINUTE_MS);
		return suffix(`${minutes} min`);
	}
	if (magnitude < DAY_MS) {
		const hours = Math.round(magnitude / HOUR_MS);
		return suffix(`${hours} h`);
	}
	const days = Math.round(magnitude / DAY_MS);
	return suffix(`${days} d`);
}

function formatAbsolute(timestamp: number, timezone: string): string {
	try {
		return new Date(timestamp).toLocaleString(undefined, { timeZone: timezone });
	} catch {
		return new Date(timestamp).toLocaleString();
	}
}

export interface ScheduleRowProps {
	schedule: RuntimeScheduleSummary;
	now: number;
	isPending: boolean;
	onToggleEnabled: (enabled: boolean) => void;
	onRunNow: () => void;
	onEdit: () => void;
	onDelete: () => void;
}

export function ScheduleRow({
	schedule,
	now,
	isPending,
	onToggleEnabled,
	onRunNow,
	onEdit,
	onDelete,
}: ScheduleRowProps): React.ReactElement {
	const lastStatus = schedule.lastStatus;

	return (
		<div className="flex items-start gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5">
			<Switch.Root
				checked={schedule.enabled}
				onCheckedChange={onToggleEnabled}
				disabled={isPending}
				aria-label={schedule.enabled ? `Disable ${schedule.name}` : `Enable ${schedule.name}`}
				className="mt-0.5 h-5 w-9 shrink-0 rounded-full bg-surface-4 data-[state=checked]:bg-accent transition-colors disabled:opacity-40"
			>
				<Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-text-primary transition-transform data-[state=checked]:translate-x-[18px]" />
			</Switch.Root>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13px] text-text-primary">{schedule.name}</span>
					{isPending ? <Spinner size={12} /> : null}
				</div>
				<div className="truncate text-[11px] text-text-tertiary">{schedule.description}</div>

				{schedule.cronError ? (
					<div className="mt-1 text-[11px] text-status-red">{schedule.cronError}</div>
				) : (
					<div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-secondary">
						{schedule.enabled && schedule.nextRunAt !== null ? (
							<Tooltip content={formatAbsolute(schedule.nextRunAt, schedule.timezone)}>
								<span>Next {formatRelative(schedule.nextRunAt, now)}</span>
							</Tooltip>
						) : (
							<span className="text-text-tertiary">Paused</span>
						)}
						{schedule.lastRunAt !== null && lastStatus ? (
							<Tooltip content={schedule.lastError ?? formatAbsolute(schedule.lastRunAt, schedule.timezone)}>
								<span className={cn(STATUS_CLASSNAMES[lastStatus])}>
									{STATUS_LABELS[lastStatus]} {formatRelative(schedule.lastRunAt, now)}
								</span>
							</Tooltip>
						) : (
							<span className="text-text-tertiary">Never run</span>
						)}
					</div>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-0.5">
				<Tooltip content="Run now">
					<Button
						variant="ghost"
						size="sm"
						icon={<Play size={14} />}
						onClick={onRunNow}
						disabled={isPending}
						aria-label={`Run ${schedule.name} now`}
					/>
				</Tooltip>
				<Tooltip content="Edit">
					<Button
						variant="ghost"
						size="sm"
						icon={<Pencil size={14} />}
						onClick={onEdit}
						disabled={isPending}
						aria-label={`Edit ${schedule.name}`}
					/>
				</Tooltip>
				<Tooltip content="Delete">
					<Button
						variant="ghost"
						size="sm"
						icon={<Trash2 size={14} />}
						onClick={onDelete}
						disabled={isPending}
						aria-label={`Delete ${schedule.name}`}
					/>
				</Tooltip>
			</div>
		</div>
	);
}
