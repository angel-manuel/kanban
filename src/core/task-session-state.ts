import type { RuntimeTaskSessionSummary } from "./api-contract";

// Shared predicates over a task session summary.
//
// These answer two different questions that are easy to conflate:
//
//   isActiveTaskSessionState - "is this task still occupying its worktree?"  Used to decide
//     whether a finished card is safe to reclaim. `awaiting_review` counts as active because
//     the agent process is usually still alive and sitting at its prompt.
//
//   isTaskSessionLive - "can I write input to this session right now?"  A session parked at
//     `awaiting_review` after its process exited has no pty left to talk to, so it is active
//     by the first definition and not live by the second.

export function isActiveTaskSessionState(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary?.state === "running" || summary?.state === "awaiting_review";
}

// `process.exit` clears the pid, so a null pid is how an exited terminal session is told
// apart from one that is merely waiting on the user.
export function isTaskSessionLive(summary: RuntimeTaskSessionSummary | null): boolean {
	if (!summary) {
		return false;
	}
	if (summary.state === "interrupted" || summary.state === "failed") {
		return false;
	}
	return summary.agentId === "cline" || summary.pid !== null;
}
