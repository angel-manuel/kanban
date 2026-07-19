import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 0,
		updatedAt: 0,
		lastOutputAt: 0,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("reduceSessionTransition: agent.error-detected", () => {
	it("parks a running session for review with an error reason", () => {
		const result = reduceSessionTransition(createSummary(), { type: "agent.error-detected" });
		expect(result.changed).toBe(true);
		expect(result.patch).toEqual({ state: "awaiting_review", reviewReason: "error" });
		expect(result.clearAttentionBuffer).toBe(true);
	});

	it("is a no-op for a session that is not running", () => {
		const summary = createSummary({ state: "awaiting_review", reviewReason: "error" });
		expect(reduceSessionTransition(summary, { type: "agent.error-detected" })).toEqual({
			changed: false,
			patch: {},
			clearAttentionBuffer: false,
		});
	});

	it("lets the session return to running once the user or a hook resumes it", () => {
		const parked = createSummary({ state: "awaiting_review", reviewReason: "error" });
		const resumed = reduceSessionTransition(parked, { type: "hook.to_in_progress" });
		expect(resumed.changed).toBe(true);
		expect(resumed.patch).toEqual({ state: "running", reviewReason: null });
	});
});
