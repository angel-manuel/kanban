// Watchdog that detects claude sessions stuck on the "Response stalled mid-stream"
// API error and injects "continue" to resume the turn.
//
// The stall leaves the task in the `running` state with `lastOutputAt` frozen and the
// error line as the last thing on screen (it does not fire claude's Stop hook). We
// detect that specific condition — recent error string in the terminal tail + output
// idle — and nudge the session, rate-limited to at most once per 15 min per task and
// no more than 4 times per task per rolling 24h.
//
// Everything is in-process: it reads the terminal scrollback mirror and calls
// `writeInput` directly, with no HTTP/WS/passcode round-trip.

import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { stripAnsi } from "../terminal/output-utils";

const DAY_MS = 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Tunables (env-overridable). Defaults chosen per plan.
export const POLL_MS = envInt("KANBAN_STALL_POLL_MS", 30_000);
export const IDLE_GRACE_MS = envInt("KANBAN_STALL_IDLE_GRACE_MS", 45_000);
export const MIN_INTERVAL_MS = envInt("KANBAN_STALL_MIN_INTERVAL_MS", 15 * 60_000);
export const MAX_PER_DAY = envInt("KANBAN_STALL_MAX_PER_DAY", 4);
export const TAIL_LINES = envInt("KANBAN_STALL_TAIL_LINES", 30);

// Primary signal: the exact stall error. Secondary: a generic API error line, only
// trusted because the session is also idle and the line sits in the terminal tail.
const PRIMARY_MATCH = "Response stalled mid-stream";
const SECONDARY_MATCH = "API Error";
const INJECT_TEXT = "continue\r";

// Disabled only when explicitly turned off; on by default.
export function isStallWatchdogEnabled(): boolean {
	const value = (process.env.KANBAN_STALL_WATCHDOG ?? "").trim().toLowerCase();
	return value !== "off" && value !== "0" && value !== "false" && value !== "no";
}

export interface StallDetectionInput {
	state: RuntimeTaskSessionSummary["state"];
	agentId: RuntimeTaskSessionSummary["agentId"];
	lastOutputAt: number | null;
	now: number;
	// Terminal scrollback tail, already ANSI-stripped and trimmed to the recent lines.
	tailText: string;
}

export interface StallDetectionResult {
	stalled: boolean;
	reason: string;
}

// Pure decision: is this session stuck on a stall right now? Only claude sessions that
// are `running`, idle past the grace window, and whose recent terminal tail shows the
// error qualify.
export function detectStall(input: StallDetectionInput): StallDetectionResult {
	if (input.agentId !== "claude") {
		return { stalled: false, reason: "not-claude" };
	}
	if (input.state !== "running") {
		return { stalled: false, reason: "not-running" };
	}
	const idleForMs = input.now - (input.lastOutputAt ?? 0);
	if (idleForMs < IDLE_GRACE_MS) {
		return { stalled: false, reason: "not-idle" };
	}
	if (input.tailText.includes(PRIMARY_MATCH)) {
		return { stalled: true, reason: "primary" };
	}
	if (input.tailText.includes(SECONDARY_MATCH)) {
		return { stalled: true, reason: "secondary" };
	}
	return { stalled: false, reason: "no-match" };
}

// Reduce a serialized xterm snapshot to the last `maxLines` non-empty lines. Scanning
// only the tail is what makes the match "recent": an older stall that already recovered
// has been pushed out of the visible tail by newer output.
export function extractRecentTail(snapshot: string, maxLines: number): string {
	const lines = stripAnsi(snapshot)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	return lines.slice(-maxLines).join("\n");
}

// Per-task injection budget: 15-min cooldown + max 4 per rolling 24h. In-memory —
// a daemon restart both resets this and replaces the tasks, so nothing is lost.
export class InjectionRateLimiter {
	private readonly timestampsByTask = new Map<string, number[]>();

	private prune(taskId: string, now: number): number[] {
		const kept = (this.timestampsByTask.get(taskId) ?? []).filter((ts) => now - ts < DAY_MS);
		this.timestampsByTask.set(taskId, kept);
		return kept;
	}

	canInject(taskId: string, now: number): { allowed: boolean; reason: string } {
		const timestamps = this.prune(taskId, now);
		const last = timestamps[timestamps.length - 1];
		if (last !== undefined && now - last < MIN_INTERVAL_MS) {
			return { allowed: false, reason: "cooldown" };
		}
		if (timestamps.length >= MAX_PER_DAY) {
			return { allowed: false, reason: "daily-cap" };
		}
		return { allowed: true, reason: "ok" };
	}

	record(taskId: string, now: number): void {
		const timestamps = this.prune(taskId, now);
		timestamps.push(now);
		this.timestampsByTask.set(taskId, timestamps);
	}

	forget(taskId: string): void {
		this.timestampsByTask.delete(taskId);
	}
}

// Minimal structural view of TerminalSessionManager — keeps the watchdog decoupled and
// trivially fakeable in tests. The real manager satisfies this.
interface WatchableTerminalManager {
	listSummaries(): RuntimeTaskSessionSummary[];
	getRestoreSnapshot(taskId: string): Promise<{ snapshot: string } | null>;
	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null;
}

export interface StallWatchdogDependencies {
	listManagedWorkspaces: () => Array<{ terminalManager: WatchableTerminalManager }>;
	now?: () => number;
	log?: (message: string) => void;
}

export interface StallWatchdog {
	start: () => void;
	scanOnce: () => Promise<void>;
	close: () => void;
}

export function createStallWatchdog(deps: StallWatchdogDependencies): StallWatchdog {
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	const limiter = new InjectionRateLimiter();
	let timer: NodeJS.Timeout | null = null;
	let scanning = false;

	const evaluateSession = async (
		manager: WatchableTerminalManager,
		summary: RuntimeTaskSessionSummary,
	): Promise<void> => {
		const nowMs = now();
		// Cheap pre-checks before paying for a snapshot.
		if (summary.agentId !== "claude" || summary.state !== "running") {
			return;
		}
		if (nowMs - (summary.lastOutputAt ?? 0) < IDLE_GRACE_MS) {
			return;
		}
		const snapshot = await manager.getRestoreSnapshot(summary.taskId);
		if (!snapshot) {
			return;
		}
		const tailText = extractRecentTail(snapshot.snapshot, TAIL_LINES);
		const detection = detectStall({
			state: summary.state,
			agentId: summary.agentId,
			lastOutputAt: summary.lastOutputAt,
			now: nowMs,
			tailText,
		});
		if (!detection.stalled) {
			return;
		}
		const gate = limiter.canInject(summary.taskId, nowMs);
		if (!gate.allowed) {
			log(`skip task ${summary.taskId}: ${gate.reason}`);
			return;
		}
		const result = manager.writeInput(summary.taskId, Buffer.from(INJECT_TEXT, "utf8"));
		if (result === null) {
			// No live pty to write to — do not consume budget.
			return;
		}
		limiter.record(summary.taskId, nowMs);
		const idleSeconds = Math.round((nowMs - (summary.lastOutputAt ?? 0)) / 1000);
		log(`injected "continue" into task ${summary.taskId} (match=${detection.reason}, idle=${idleSeconds}s)`);
	};

	const scanOnce = async (): Promise<void> => {
		if (scanning) {
			return;
		}
		scanning = true;
		try {
			for (const { terminalManager } of deps.listManagedWorkspaces()) {
				for (const summary of terminalManager.listSummaries()) {
					try {
						await evaluateSession(terminalManager, summary);
					} catch (error) {
						log(`error evaluating task ${summary.taskId}: ${String(error)}`);
					}
				}
			}
		} finally {
			scanning = false;
		}
	};

	return {
		start: () => {
			if (timer || !isStallWatchdogEnabled()) {
				return;
			}
			timer = setInterval(() => {
				void scanOnce();
			}, POLL_MS);
			timer.unref();
			log(
				`started (poll=${POLL_MS}ms, idleGrace=${IDLE_GRACE_MS}ms, minInterval=${MIN_INTERVAL_MS}ms, maxPerDay=${MAX_PER_DAY})`,
			);
		},
		scanOnce,
		close: () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
