import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { classifyClaudeErrorTail } from "../../src/server/agent-error-patterns";
import {
	createStallWatchdog,
	detectStall,
	extractRecentTail,
	IDLE_GRACE_MS,
	InjectionRateLimiter,
	MAX_PER_DAY,
	MIN_INTERVAL_MS,
	RATE_LIMIT_INTERVAL_MS,
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

describe("classifyClaudeErrorTail", () => {
	it("classifies the stall error", () => {
		expect(classifyClaudeErrorTail(STALL_LINE)).toEqual({ errorClass: "stall", pattern: "stalled-mid-stream" });
	});

	it.each([
		["⎿  API Error: overloaded_error", "overloaded"],
		['⎿  API Error: 529 {"type":"overloaded_error"}', "overloaded"],
		["⎿  API Error: 503 Service Unavailable", "http-5xx"],
		["⎿  API Error: Connection error.", "connection"],
		["⎿  API Error: fetch failed", "connection"],
		["⎿  API Error: Request timed out.", "timeout"],
	])("treats %s as transient", (line, pattern) => {
		expect(classifyClaudeErrorTail(line)).toEqual({ errorClass: "transient", pattern });
	});

	it.each([
		["⎿  API Error: 429 rate_limit_error", "rate-limit"],
		["Claude usage limit reached. Your limit will reset at 3pm.", "usage-limit"],
		["⎿  API Error: 429 Too Many Requests", "http-429"],
	])("treats %s as rate-limited", (line, pattern) => {
		expect(classifyClaudeErrorTail(line)).toEqual({ errorClass: "rate-limited", pattern });
	});

	it.each([
		["⎿  API Error: 401 authentication_error", "auth-error"],
		["⎿  API Error: 403 Forbidden", "http-auth"],
		["OAuth token has expired. Please run /login.", "oauth-expired"],
		["⎿  API Error: Your credit balance is too low to access the API.", "credits-exhausted"],
		["⎿  API Error: 400 invalid_request_error: prompt is too long", "prompt-too-long"],
	])("treats %s as fatal", (line, pattern) => {
		expect(classifyClaudeErrorTail(line)).toEqual({ errorClass: "fatal", pattern });
	});

	it("falls back to transient for an unrecognised API error", () => {
		expect(classifyClaudeErrorTail("⎿  API Error: something new")).toEqual({
			errorClass: "transient",
			pattern: "generic-api-error",
		});
	});

	it("prefers the most severe match when several are present", () => {
		const tail = "⎿  API Error: Connection error.\n⎿  API Error: 429 rate_limit_error\n> ";
		expect(classifyClaudeErrorTail(tail)?.errorClass).toBe("rate-limited");
	});

	it("does not match bare status codes outside an API Error line", () => {
		expect(classifyClaudeErrorTail("the test asserts a 429 response and a 503 fallback")).toBeNull();
	});

	it("does not fire on agent output that merely discusses these errors", () => {
		// The watchdog's tail is 30 lines of whatever the agent last printed — often
		// source, diffs, or grep hits. None of this is a real failure.
		const tail = [
			'  { id: "auth-error", errorClass: "fatal", test: /authentication_error/ },',
			"  // retry once on overloaded_error or a 529 from the API",
			"  if (isRateLimit(err)) return backoff(); // rate_limit_error",
			'  expect(message).toContain("Your credit balance is too low");',
			"> ",
		].join("\n");
		expect(classifyClaudeErrorTail(tail)).toBeNull();
	});

	it("does not fire on agent output that quotes a full error line", () => {
		// Harder case than the above: the text contains a literal `API Error:` prefix, but
		// embedded in a test fixture, a diff, and a grep hit rather than printed by claude.
		const tail = [
			'	["⎿  API Error: 401 authentication_error", "auth-error"],',
			"+	API Error: rate_limit_error // added case",
			"src/server/foo.ts:12:  API Error: overloaded_error",
			'#  API Error: "Your credit balance is too low"',
			"> ",
		].join("\n");
		expect(classifyClaudeErrorTail(tail)).toBeNull();
	});

	it("still fires when claude prints the error behind its own gutter", () => {
		expect(classifyClaudeErrorTail("⎿  API Error: 401 authentication_error\n> ")).toEqual({
			errorClass: "fatal",
			pattern: "auth-error",
		});
	});

	it("returns null for output with no error", () => {
		expect(classifyClaudeErrorTail("resumed working\n✳ Thinking…\n> ")).toBeNull();
	});
});

describe("detectStall", () => {
	it("nudges a running, idle claude session whose tail shows the stall error", () => {
		expect(detectStall(baseDetectionInput())).toEqual({
			action: "nudge",
			reason: "stalled-mid-stream",
			errorClass: "stall",
		});
	});

	it("nudges on a transient API error", () => {
		const input = baseDetectionInput({ tailText: "⎿  API Error: overloaded_error\n> " });
		expect(detectStall(input)).toEqual({ action: "nudge", reason: "overloaded", errorClass: "transient" });
	});

	it("flags an unrecoverable error for review instead of nudging", () => {
		const input = baseDetectionInput({ tailText: "⎿  API Error: 401 authentication_error\n> " });
		expect(detectStall(input)).toEqual({ action: "review", reason: "auth-error", errorClass: "fatal" });
	});

	it("ignores non-claude agents", () => {
		expect(detectStall(baseDetectionInput({ agentId: "codex" })).action).toBe("none");
	});

	it("ignores sessions that are not running", () => {
		expect(detectStall(baseDetectionInput({ state: "awaiting_review" })).action).toBe("none");
	});

	it("does not fire before the idle grace window elapses", () => {
		const now = 1_000 + IDLE_GRACE_MS - 1;
		expect(detectStall(baseDetectionInput({ now })).reason).toBe("not-idle");
	});

	it("does not fire when the tail no longer contains the error (recovered)", () => {
		const input = baseDetectionInput({ tailText: "resumed working\n✳ Thinking…\n> " });
		expect(detectStall(input)).toEqual({ action: "none", reason: "no-match", errorClass: null });
	});

	it("treats a missing lastOutputAt as fully idle", () => {
		expect(detectStall(baseDetectionInput({ lastOutputAt: null, now: IDLE_GRACE_MS + 1 })).action).toBe("nudge");
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

	it("applies the longer rate-limit cooldown when asked for it", () => {
		const limiter = new InjectionRateLimiter();
		const t0 = 10_000_000;
		limiter.record("task", t0);
		// Past the normal cooldown but still inside the rate-limit one.
		const between = t0 + MIN_INTERVAL_MS + 1;
		expect(limiter.canInject("task", between).allowed).toBe(true);
		expect(limiter.canInject("task", between, RATE_LIMIT_INTERVAL_MS)).toEqual({
			allowed: false,
			reason: "cooldown",
		});
		expect(limiter.canInject("task", t0 + RATE_LIMIT_INTERVAL_MS + 1, RATE_LIMIT_INTERVAL_MS).allowed).toBe(true);
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
	const reviews: string[] = [];
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
		transitionToReview: (taskId: string, reason: "error") => {
			reviews.push(taskId);
			// Mirror the manager: the summary the watchdog sees next scan is parked.
			const index = options.summaries.findIndex((item) => item.taskId === taskId);
			const parked = summary({ taskId, state: "awaiting_review", reviewReason: reason });
			if (index >= 0) {
				options.summaries[index] = parked;
			}
			return parked;
		},
	};
	return { manager, writes, reviews };
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
			listManagedWorkspaces: () => [{ workspaceId: "ws-1", terminalManager: manager }],
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
			listManagedWorkspaces: () => [{ workspaceId: "ws-1", terminalManager: manager }],
			now: () => now,
			log: () => {},
		});
		await watchdog.scanOnce();
		expect(writes).toHaveLength(0);
	});

	it("flags an unrecoverable error for review without injecting or spending budget", async () => {
		const { manager, writes, reviews } = createFakeManager({
			summaries: [summary()],
			snapshotByTaskId: { "task-1": "⎿  API Error: 401 authentication_error\n> " },
		});
		const notified: Array<[string, string]> = [];
		let clock = now;
		const watchdog = createStallWatchdog({
			listManagedWorkspaces: () => [{ workspaceId: "ws-1", terminalManager: manager }],
			notifyReviewReady: (workspaceId, taskId) => notified.push([workspaceId, taskId]),
			now: () => clock,
			log: () => {},
		});

		await watchdog.scanOnce();
		expect(writes).toHaveLength(0);
		expect(reviews).toEqual(["task-1"]);
		expect(notified).toEqual([["ws-1", "task-1"]]);

		// The session is no longer `running`, so a later scan does not re-flag it.
		clock += RATE_LIMIT_INTERVAL_MS + 1;
		await watchdog.scanOnce();
		expect(reviews).toHaveLength(1);
	});

	it("waits out the longer cooldown before retrying a rate-limited session", async () => {
		const { manager, writes } = createFakeManager({
			summaries: [summary()],
			snapshotByTaskId: { "task-1": "⎿  API Error: 429 rate_limit_error\n> " },
		});
		let clock = now;
		const watchdog = createStallWatchdog({
			listManagedWorkspaces: () => [{ workspaceId: "ws-1", terminalManager: manager }],
			now: () => clock,
			log: () => {},
		});

		await watchdog.scanOnce();
		expect(writes).toHaveLength(1);

		// Past the normal nudge cooldown, but a rate limit needs longer.
		clock += MIN_INTERVAL_MS + 1;
		await watchdog.scanOnce();
		expect(writes).toHaveLength(1);

		clock += RATE_LIMIT_INTERVAL_MS;
		await watchdog.scanOnce();
		expect(writes).toHaveLength(2);
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
			transitionToReview: () => null,
		};
		let clock = now;
		const watchdog = createStallWatchdog({
			listManagedWorkspaces: () => [{ workspaceId: "ws-1", terminalManager: manager }],
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
