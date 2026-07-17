import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import {
	createStallWatchdog,
	detectStall,
	extractRecentTail,
	IDLE_GRACE_MS,
	InjectionRateLimiter,
	MAX_PER_DAY,
	MIN_INTERVAL_MS,
	type StallDetectionInput,
} from "../../src/server/stall-watchdog";

const STALL_LINE = "⎿  API Error: Response stalled mid-stream. The response above may be incomplete.";

function baseDetectionInput(overrides: Partial<StallDetectionInput> = {}): StallDetectionInput {
	return {
		state: "running",
		agentId: "claude",
		lastOutputAt: 1_000,
		now: 1_000 + IDLE_GRACE_MS + 5_000,
		tailText: `some prior output\n${STALL_LINE}\n> `,
		...overrides,
	};
}

describe("detectStall", () => {
	it("flags a running, idle claude session whose tail shows the stall error", () => {
		expect(detectStall(baseDetectionInput())).toEqual({ stalled: true, reason: "primary" });
	});

	it("treats a bare API Error line as a secondary match", () => {
		const input = baseDetectionInput({ tailText: "⎿  API Error: overloaded_error\n> " });
		expect(detectStall(input)).toEqual({ stalled: true, reason: "secondary" });
	});

	it("ignores non-claude agents", () => {
		expect(detectStall(baseDetectionInput({ agentId: "codex" })).stalled).toBe(false);
	});

	it("ignores sessions that are not running", () => {
		expect(detectStall(baseDetectionInput({ state: "awaiting_review" })).stalled).toBe(false);
	});

	it("does not fire before the idle grace window elapses", () => {
		const now = 1_000 + IDLE_GRACE_MS - 1;
		expect(detectStall(baseDetectionInput({ now })).reason).toBe("not-idle");
	});

	it("does not fire when the tail no longer contains the error (recovered)", () => {
		const input = baseDetectionInput({ tailText: "resumed working\n✳ Thinking…\n> " });
		expect(detectStall(input)).toEqual({ stalled: false, reason: "no-match" });
	});

	it("treats a missing lastOutputAt as fully idle", () => {
		expect(detectStall(baseDetectionInput({ lastOutputAt: null, now: IDLE_GRACE_MS + 1 })).stalled).toBe(true);
	});
});

describe("extractRecentTail", () => {
	it("keeps only the last N non-empty lines and drops an older stall line", () => {
		const oldStall = STALL_LINE;
		const fresh = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const tail = extractRecentTail(`${oldStall}\n\n${fresh}`, 30);
		expect(tail.includes("Response stalled mid-stream")).toBe(false);
		expect(tail.split("\n").length).toBe(30);
		expect(tail.includes("line 39")).toBe(true);
	});

	it("strips ANSI escapes before matching", () => {
		const ansi = `[31m${STALL_LINE}[0m`;
		expect(extractRecentTail(ansi, 30).includes("Response stalled mid-stream")).toBe(true);
	});
});

describe("InjectionRateLimiter", () => {
	it("enforces the 15-minute cooldown", () => {
		const limiter = new InjectionRateLimiter();
		const t0 = 10_000_000;
		expect(limiter.canInject("task", t0).allowed).toBe(true);
		limiter.record("task", t0);
		expect(limiter.canInject("task", t0 + MIN_INTERVAL_MS - 1)).toEqual({ allowed: false, reason: "cooldown" });
		expect(limiter.canInject("task", t0 + MIN_INTERVAL_MS + 1).allowed).toBe(true);
	});

	it("enforces the max-per-24h cap", () => {
		const limiter = new InjectionRateLimiter();
		let t = 10_000_000;
		for (let i = 0; i < MAX_PER_DAY; i += 1) {
			expect(limiter.canInject("task", t).allowed).toBe(true);
			limiter.record("task", t);
			t += MIN_INTERVAL_MS + 1; // clear the cooldown between records
		}
		expect(limiter.canInject("task", t)).toEqual({ allowed: false, reason: "daily-cap" });
	});

	it("frees budget once injections roll out of the 24h window", () => {
		const limiter = new InjectionRateLimiter();
		let t = 10_000_000;
		for (let i = 0; i < MAX_PER_DAY; i += 1) {
			limiter.record("task", t);
			t += MIN_INTERVAL_MS + 1;
		}
		const dayLater = 10_000_000 + 24 * 60 * 60 * 1000 + 1;
		expect(limiter.canInject("task", dayLater).allowed).toBe(true);
	});
});

interface FakeManagerOptions {
	summaries: RuntimeTaskSessionSummary[];
	snapshotByTaskId: Record<string, string>;
	writeReturnsNull?: boolean;
}

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		mode: null,
		workspacePath: null,
		pid: 123,
		startedAt: 0,
		updatedAt: 0,
		lastOutputAt: 1_000,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function createFakeManager(options: FakeManagerOptions) {
	const writes: Array<{ taskId: string; data: string }> = [];
	const manager = {
		listSummaries: () => options.summaries,
		getRestoreSnapshot: async (taskId: string) => {
			const snapshot = options.snapshotByTaskId[taskId];
			return snapshot === undefined ? null : { snapshot };
		},
		writeInput: (taskId: string, data: Buffer) => {
			writes.push({ taskId, data: data.toString("utf8") });
			return options.writeReturnsNull ? null : summary({ taskId });
		},
	};
	return { manager, writes };
}

describe("createStallWatchdog.scanOnce", () => {
	const now = 1_000 + IDLE_GRACE_MS + 10_000;

	it("injects continue exactly once and then respects the cooldown", async () => {
		const { manager, writes } = createFakeManager({
			summaries: [summary()],
			snapshotByTaskId: { "task-1": `blah\n${STALL_LINE}\n> ` },
		});
		let clock = now;
		const watchdog = createStallWatchdog({
			listManagedWorkspaces: () => [{ terminalManager: manager }],
			now: () => clock,
			log: () => {},
		});

		await watchdog.scanOnce();
		expect(writes).toEqual([{ taskId: "task-1", data: "continue\r" }]);

		// A second scan shortly after must be suppressed by the cooldown.
		clock += 60_000;
		await watchdog.scanOnce();
		expect(writes).toHaveLength(1);
	});

	it("does not inject when the terminal tail has no error", async () => {
		const { manager, writes } = createFakeManager({
			summaries: [summary()],
			snapshotByTaskId: { "task-1": "all good\n> " },
		});
		const watchdog = createStallWatchdog({
			listManagedWorkspaces: () => [{ terminalManager: manager }],
			now: () => now,
			log: () => {},
		});
		await watchdog.scanOnce();
		expect(writes).toHaveLength(0);
	});

	it("does not consume budget when there is no live pty, so the next scan can retry", async () => {
		const writes: Array<{ taskId: string; data: string }> = [];
		let ptyAlive = false; // first scan: no live pty → writeInput returns null
		const manager = {
			listSummaries: () => [summary()],
			getRestoreSnapshot: async () => ({ snapshot: `x\n${STALL_LINE}\n> ` }),
			writeInput: (taskId: string, data: Buffer) => {
				writes.push({ taskId, data: data.toString("utf8") });
				return ptyAlive ? summary({ taskId }) : null;
			},
		};
		let clock = now;
		const watchdog = createStallWatchdog({
			listManagedWorkspaces: () => [{ terminalManager: manager }],
			now: () => clock,
			log: () => {},
		});

		await watchdog.scanOnce();
		expect(writes).toHaveLength(1); // attempted, but returned null

		// Next scan (pty now alive) still within the cooldown window: because the null
		// write did NOT record budget, the retry is allowed and injects.
		ptyAlive = true;
		clock += 30_000;
		await watchdog.scanOnce();
		expect(writes).toHaveLength(2);

		// This one DID record budget, so a further scan inside the cooldown is suppressed.
		clock += 30_000;
		await watchdog.scanOnce();
		expect(writes).toHaveLength(2);
	});
});
