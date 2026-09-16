import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, type RuntimeWorkspaceContext } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";

// Plumbing shared by the CLI subcommand groups.
//
// Extracted from `task.ts` when `schedule.ts` needed the same client, workspace resolution
// and JSON output. The split in how the CLI talks to the runtime is deliberate and worth
// knowing: state that lives in a file is read and written directly, so those commands work
// with no server running, while anything that touches a live process goes over tRPC to the
// local runtime.

export type JsonRecord = Record<string, unknown>;

export function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

export function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
}

export async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<RuntimeWorkspaceContext> {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

// Wraps a subcommand so every failure is reported as JSON on stdout with a non-zero exit
// code, rather than a stack trace.
export async function runCliCommand(label: string, handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `${label} failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}
