import { CalendarClock, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ScheduleForm } from "@/components/schedules/schedule-form";
import { ScheduleRow } from "@/components/schedules/schedule-row";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Dialog,
	DialogBody,
	DialogHeader,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useSchedules } from "@/hooks/use-schedules";
import type { RuntimeScheduleCreateRequest, RuntimeScheduleSummary } from "@/runtime/types";

// Recurring schedules for the current project.
//
// Two modes in one dialog: a list, and a create/edit form. Deliberately separate from the
// settings dialog, which is already large and holds user preferences rather than
// per-project automation.

type DialogMode = { kind: "list" } | { kind: "form"; schedule: RuntimeScheduleSummary | null };

export interface SchedulesDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string | null;
}

export function SchedulesDialog({ open, onOpenChange, workspaceId }: SchedulesDialogProps): React.ReactElement {
	const [mode, setMode] = useState<DialogMode>({ kind: "list" });
	const [pendingDelete, setPendingDelete] = useState<RuntimeScheduleSummary | null>(null);
	const schedules = useSchedules(workspaceId, open);

	// Always reopen on the list, never on a stale form.
	useEffect(() => {
		if (!open) {
			setMode({ kind: "list" });
			setPendingDelete(null);
		}
	}, [open]);

	const submitForm = useCallback(
		async (input: RuntimeScheduleCreateRequest) => {
			const editing = mode.kind === "form" ? mode.schedule : null;
			const saved = editing
				? await schedules.update({ scheduleId: editing.id, ...input })
				: await schedules.create(input);
			if (saved) {
				setMode({ kind: "list" });
			}
		},
		[mode, schedules],
	);

	const confirmDelete = useCallback(async () => {
		if (!pendingDelete) {
			return;
		}
		await schedules.remove(pendingDelete.id);
		setPendingDelete(null);
	}, [pendingDelete, schedules]);

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={onOpenChange}
				contentClassName="max-w-2xl"
				contentAriaDescribedBy={undefined}
			>
				<DialogHeader title="Schedules" icon={<CalendarClock size={16} />} />
				<DialogBody className="flex flex-col gap-3">
					{mode.kind === "form" ? (
						<ScheduleForm
							schedule={mode.schedule}
							serverTimezone={schedules.serverTimezone}
							isSaving={schedules.isSaving}
							onCancel={() => setMode({ kind: "list" })}
							onSubmit={(input) => {
								void submitForm(input);
							}}
						/>
					) : (
						<>
							<p className="text-[12px] text-text-tertiary">
								Scheduled tasks run on their own and open a commit or pull request when they finish. They only
								fire while Kanban is running; an occurrence missed while it was closed is skipped.
							</p>

							{schedules.isLoading ? (
								<div className="flex justify-center py-6">
									<Spinner size={18} />
								</div>
							) : null}

							{schedules.loadError ? (
								<div className="rounded-md border border-status-red/40 bg-status-red/10 px-3 py-2 text-[12px] text-status-red">
									{schedules.loadError.message}
								</div>
							) : null}

							{!schedules.isLoading && !schedules.loadError && schedules.schedules.length === 0 ? (
								<div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-text-tertiary">
									No schedules yet. Create one to run a task on a recurring basis.
								</div>
							) : null}

							{schedules.schedules.map((schedule) => (
								<ScheduleRow
									key={schedule.id}
									schedule={schedule}
									now={schedules.nowTick}
									isPending={schedules.pendingScheduleId === schedule.id}
									onToggleEnabled={(enabled) => {
										void schedules.setEnabled(schedule.id, enabled);
									}}
									onRunNow={() => {
										void schedules.runNow(schedule.id);
									}}
									onEdit={() => setMode({ kind: "form", schedule })}
									onDelete={() => setPendingDelete(schedule)}
								/>
							))}

							<div>
								<Button
									variant="primary"
									icon={<Plus size={14} />}
									onClick={() => setMode({ kind: "form", schedule: null })}
									disabled={workspaceId === null}
								>
									New schedule
								</Button>
							</div>
						</>
					)}
				</DialogBody>
			</Dialog>

			<AlertDialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete schedule</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						{`"${pendingDelete?.name ?? ""}" will stop running. Tasks it already created are not affected.`}
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="ghost">Cancel</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								void confirmDelete();
							}}
						>
							Delete
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
