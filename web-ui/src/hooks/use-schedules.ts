import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	createSchedule,
	fetchSchedules,
	removeSchedule,
	runScheduleNow,
	setScheduleEnabled,
	updateSchedule,
} from "@/runtime/schedules-query";
import type {
	RuntimeScheduleCreateRequest,
	RuntimeScheduleListResponse,
	RuntimeScheduleSummary,
	RuntimeScheduleUpdateRequest,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { useInterval } from "@/utils/react-use";

// Owns schedule list state and every mutation the dialog can perform.
//
// Mutations funnel through one helper so failure reporting and refetching are identical
// everywhere, and so a per-row pending id is always cleared. The list is refetched after
// each mutation rather than pushed over the websocket: the dialog is modal and short
// lived, and the only other writer is the CLI or the scheduler itself.

// Keeps the relative "next run" and "last run" labels honest while the dialog sits open.
const RELATIVE_TIME_REFRESH_MS = 30_000;

export interface UseSchedulesResult {
	schedules: RuntimeScheduleSummary[];
	serverTimezone: string;
	isLoading: boolean;
	loadError: Error | null;
	pendingScheduleId: string | null;
	isSaving: boolean;
	nowTick: number;
	refetch: () => Promise<RuntimeScheduleListResponse | null>;
	create: (input: RuntimeScheduleCreateRequest) => Promise<boolean>;
	update: (input: RuntimeScheduleUpdateRequest) => Promise<boolean>;
	setEnabled: (scheduleId: string, enabled: boolean) => Promise<void>;
	remove: (scheduleId: string) => Promise<void>;
	runNow: (scheduleId: string) => Promise<void>;
}

export function useSchedules(workspaceId: string | null, isOpen: boolean): UseSchedulesResult {
	const [pendingScheduleId, setPendingScheduleId] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const [nowTick, setNowTick] = useState(() => Date.now());

	const queryFn = useCallback(async () => {
		if (!workspaceId) {
			throw new Error("No project selected.");
		}
		return await fetchSchedules(workspaceId);
	}, [workspaceId]);

	const query = useTrpcQuery<RuntimeScheduleListResponse>({
		enabled: isOpen && workspaceId !== null,
		queryFn,
	});

	useInterval(
		() => {
			setNowTick(Date.now());
		},
		isOpen ? RELATIVE_TIME_REFRESH_MS : null,
	);

	const runMutation = useCallback(
		async (scheduleId: string | null, action: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
			if (!workspaceId) {
				return false;
			}
			setPendingScheduleId(scheduleId);
			try {
				const result = await action();
				if (!result.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: result.error ?? "The schedule could not be saved.",
						timeout: 7000,
					});
					return false;
				}
				await query.refetch();
				return true;
			} catch (error) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: error instanceof Error ? error.message : String(error),
					timeout: 7000,
				});
				return false;
			} finally {
				setPendingScheduleId(null);
			}
		},
		[query.refetch, workspaceId],
	);

	const create = useCallback(
		async (input: RuntimeScheduleCreateRequest) => {
			setIsSaving(true);
			try {
				return await runMutation(null, async () => await createSchedule(workspaceId ?? "", input));
			} finally {
				setIsSaving(false);
			}
		},
		[runMutation, workspaceId],
	);

	const update = useCallback(
		async (input: RuntimeScheduleUpdateRequest) => {
			setIsSaving(true);
			try {
				return await runMutation(input.scheduleId, async () => await updateSchedule(workspaceId ?? "", input));
			} finally {
				setIsSaving(false);
			}
		},
		[runMutation, workspaceId],
	);

	const setEnabled = useCallback(
		async (scheduleId: string, enabled: boolean) => {
			await runMutation(scheduleId, async () => await setScheduleEnabled(workspaceId ?? "", scheduleId, enabled));
		},
		[runMutation, workspaceId],
	);

	const remove = useCallback(
		async (scheduleId: string) => {
			await runMutation(scheduleId, async () => await removeSchedule(workspaceId ?? "", scheduleId));
		},
		[runMutation, workspaceId],
	);

	const runNow = useCallback(
		async (scheduleId: string) => {
			const started = await runMutation(scheduleId, async () => {
				const result = await runScheduleNow(workspaceId ?? "", scheduleId);
				if (result.status === "skipped_overlap") {
					// Not a failure: the previous run is still going and the policy says skip.
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: "Skipped: the previous run for this schedule is still active.",
						timeout: 6000,
					});
					return { ok: true };
				}
				return result;
			});
			if (started) {
				showAppToast({ intent: "success", icon: "tick", message: "Schedule started.", timeout: 4000 });
			}
		},
		[runMutation, workspaceId],
	);

	return useMemo(
		() => ({
			schedules: query.data?.schedules ?? [],
			serverTimezone: query.data?.serverTimezone ?? "UTC",
			isLoading: query.isLoading,
			loadError: query.error,
			pendingScheduleId,
			isSaving,
			nowTick,
			refetch: query.refetch,
			create,
			update,
			setEnabled,
			remove,
			runNow,
		}),
		[
			create,
			isSaving,
			nowTick,
			pendingScheduleId,
			query.data,
			query.error,
			query.isLoading,
			query.refetch,
			remove,
			runNow,
			setEnabled,
			update,
		],
	);
}
