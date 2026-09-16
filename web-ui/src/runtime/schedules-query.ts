import type {
	RuntimeScheduleCreateRequest,
	RuntimeScheduleListResponse,
	RuntimeScheduleMutationResponse,
	RuntimeScheduleRemoveResponse,
	RuntimeScheduleRunNowResponse,
	RuntimeScheduleUpdateRequest,
} from "@/runtime/types";
import { getRuntimeTrpcClient } from "./trpc-client";

// TRPC plumbing for recurring schedules. Keeping the request details here lets the hook
// and the dialog stay focused on state and rendering, matching the other *-query modules.

export async function fetchSchedules(workspaceId: string): Promise<RuntimeScheduleListResponse> {
	return await getRuntimeTrpcClient(workspaceId).schedules.list.query();
}

export async function createSchedule(
	workspaceId: string,
	input: RuntimeScheduleCreateRequest,
): Promise<RuntimeScheduleMutationResponse> {
	return await getRuntimeTrpcClient(workspaceId).schedules.create.mutate(input);
}

export async function updateSchedule(
	workspaceId: string,
	input: RuntimeScheduleUpdateRequest,
): Promise<RuntimeScheduleMutationResponse> {
	return await getRuntimeTrpcClient(workspaceId).schedules.update.mutate(input);
}

export async function setScheduleEnabled(
	workspaceId: string,
	scheduleId: string,
	enabled: boolean,
): Promise<RuntimeScheduleMutationResponse> {
	return await getRuntimeTrpcClient(workspaceId).schedules.setEnabled.mutate({ scheduleId, enabled });
}

export async function removeSchedule(workspaceId: string, scheduleId: string): Promise<RuntimeScheduleRemoveResponse> {
	return await getRuntimeTrpcClient(workspaceId).schedules.remove.mutate({ scheduleId });
}

export async function runScheduleNow(workspaceId: string, scheduleId: string): Promise<RuntimeScheduleRunNowResponse> {
	return await getRuntimeTrpcClient(workspaceId).schedules.runNow.mutate({ scheduleId });
}
