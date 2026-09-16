import { join } from "node:path";

import { type RuntimeSchedule, type RuntimeSchedulesFile, runtimeSchedulesFileSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { parsePersistedStateFile, readJsonFile } from "./persisted-state-file";
import { getWorkspaceDirectoryPath } from "./workspace-state";

// Per-project store for recurring task schedules, kept in `schedules.json` beside
// `board.json`.
//
// Deliberately a separate file from the board: the browser owns `board.json` through a
// debounced whole-snapshot save, so run bookkeeping written here by the server would be
// clobbered by the next tab that had the board open. It is also not runtime config, which
// holds user preferences rather than operational job state.
//
// LOCKING. This uses a *file* lock on `schedules.json`, deliberately not the workspace
// directory lock that `workspace-state.ts` takes. `AsyncKeyedMutex` is plain promise
// chaining with no reentrancy, so acquiring the same key twice in a nested call deadlocks
// that key for the life of the process - and the scheduler legitimately needs to record a
// run (this file) around materializing a task (the board, under the directory lock). The
// two keys differ: `<workspacesRoot>/<workspaceId>.lock` for the directory versus
// `<workspaceDir>/schedules.json.lock` here. Keep the nesting one-way: take this lock
// inside a board mutation, never the reverse.

const SCHEDULES_FILENAME = "schedules.json";
const SCHEDULES_FILE_VERSION = 1;

export function getWorkspaceSchedulesPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), SCHEDULES_FILENAME);
}

function createEmptySchedulesFile(): RuntimeSchedulesFile {
	return { version: SCHEDULES_FILE_VERSION, schedules: [] };
}

async function readSchedulesFile(workspaceId: string): Promise<RuntimeSchedulesFile> {
	const path = getWorkspaceSchedulesPath(workspaceId);
	const raw = await readJsonFile(path);
	return parsePersistedStateFile(
		path,
		SCHEDULES_FILENAME,
		raw,
		runtimeSchedulesFileSchema,
		createEmptySchedulesFile(),
	);
}

export async function loadWorkspaceSchedules(workspaceId: string): Promise<RuntimeSchedule[]> {
	return (await readSchedulesFile(workspaceId)).schedules;
}

export interface WorkspaceSchedulesMutationResult<T> {
	schedules: RuntimeSchedule[];
	value: T;
	/** false skips the write entirely, so a no-op mutation does not rewrite the file. */
	save?: boolean;
}

export async function mutateWorkspaceSchedules<T>(
	workspaceId: string,
	mutate: (schedules: RuntimeSchedule[]) => WorkspaceSchedulesMutationResult<T>,
): Promise<T> {
	const path = getWorkspaceSchedulesPath(workspaceId);
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const current = await readSchedulesFile(workspaceId);
		const mutation = mutate(current.schedules);
		if (mutation.save === false) {
			return mutation.value;
		}
		await lockedFileSystem.writeJsonFileAtomic(
			path,
			{ version: SCHEDULES_FILE_VERSION, schedules: mutation.schedules } satisfies RuntimeSchedulesFile,
			{ lock: null },
		);
		return mutation.value;
	});
}
