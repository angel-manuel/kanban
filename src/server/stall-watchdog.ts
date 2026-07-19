// Watchdog that detects claude sessions frozen on an API error and decides what to do
// about it.
//
// Any of these errors leaves the task in the `running` state with `lastOutputAt` frozen
// and the error line as the last thing on screen (none of them fire claude's Stop hook).
// We detect that condition — recent error string in the terminal tail + output idle —
// then act on what the error actually was:
//
//   stall / transient  → inject "continue" (max once per 15 min, 4 per rolling 24h)
//   rate-limited       → inject "continue", but only after a much longer cooldown
//   fatal              → flag the session for review; a nudge would never help
//
// Everything is in-process: it reads the terminal scrollback mirror and calls
// `writeInput` / `transitionToReview` directly, with no HTTP/WS/passcode round-trip.

import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { stripAnsi } from "../terminal/output-utils";
import { type AgentErrorClass, classifyClaudeErrorTail } from "./agent-error-patterns";

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
// Rate limits take far longer to clear than an overload, so retrying on the normal
// cooldown would just spend the daily budget against a limit that has not reset yet.
export const RATE_LIMIT_INTERVAL_MS = envInt("KANBAN_STALL_RATE_LIMIT_INTERVAL_MS", 30 * 60_000);
export const MAX_PER_DAY = envInt("KANBAN_STALL_MAX_PER_DAY", 4);
// How long to leave a task alone after parking it for review, so a resumed session is not
// immediately re-parked off the same error line still visible in the tail.
export const REVIEW_COOLDOWN_MS = envInt("KANBAN_STALL_REVIEW_COOLDOWN_MS", 15 * 60_000);
export const TAIL_LINES = envInt("KANBAN_STALL_TAIL_LINES", 30);

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

export type WatchdogAction =
	// Nothing to do — no error, or the session does not qualify.
	| "none"
	// Inject "continue" to resume the frozen turn.
	| "nudge"
	// Move the session to awaiting_review so the user sees it.
	| "review";

export interface StallDetectionResult {
	action: WatchdogAction;
	// Matched pattern id, or why the session was skipped. Used in log lines.
	reason: string;
	errorClass: AgentErrorClass | null;
}

// Cooldown to apply before the next nudge for this error class.
export function cooldownForErrorClass(errorClass: AgentErrorClass): number {
	return errorClass === "rate-limited" ? RATE_LIMIT_INTERVAL_MS : MIN_INTERVAL_MS;
}

// Pure decision: is this session frozen on an API error right now, and if so what should
// happen? Only claude sessions that are `running`, idle past the grace window, and whose
// recent terminal tail shows an error qualify.
export function detectStall(input: StallDetectionInput): StallDetectionResult {
	if (input.agentId !== "claude") {
		return { action: "none", reason: "not-claude", errorClass: null };
	}
	if (input.state !== "running") {
		return { action: "none", reason: "not-running", errorClass: null };
	}
	const idleForMs = input.now - (input.lastOutputAt ?? 0);
	if (idleForMs < IDLE_GRACE_MS) {
		return { action: "none", reason: "not-idle", errorClass: null };
	}
	const match = classifyClaudeErrorTail(input.tailText);
	if (!match) {
		return { action: "none", reason: "no-match", errorClass: null };
	}
	return {
		action: match.errorClass === "fatal" ? "review" : "nudge",
		reason: match.pattern,
		errorClass: match.errorClass,
	};
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

// Per-task injection budget: a per-error-class cooldown + max 4 per rolling 24h.
// In-memory — a daemon restart both resets this and replaces the tasks, so nothing
// is lost.
export class InjectionRateLimiter {
	private readonly timestampsByTask = new Map<string, number[]>();

	private prune(taskId: string, now: number): number[] {
		const kept = (this.timestampsByTask.get(taskId) ?? []).filter((ts) => now - ts < DAY_MS);
		this.timestampsByTask.set(taskId, kept);
		return kept;
	}

	canInject(taskId: string, now: number, minIntervalMs = MIN_INTERVAL_MS): { allowed: boolean; reason: string } {
		const timestamps = this.prune(taskId, now);
		const last = timestamps[timestamps.length - 1];
		if (last !== undefined && now - last < minIntervalMs) {
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

// Parking is not budget-limited the way nudging is — a session that keeps hitting a fatal
// error should keep being surfaced. It still needs a cooldown, though: `error` is a
// resumable review reason (see `canReturnToRunning`), so a hook or the user can put the
// session back into `running` while the error line is still sitting in the 30-line tail.
// Without this guard the very next scan would re-park it and fight the user.
export class ReviewCooldown {
	private readonly lastParkedAt = new Map<string, number>();

	canPark(taskId: string, now: number): boolean {
		const last = this.lastParkedAt.get(taskId);
		return last === undefined || now - last >= REVIEW_COOLDOWN_MS;
	}

	record(taskId: string, now: number): void {
		this.lastParkedAt.set(taskId, now);
	}

	forget(taskId: string): void {
		this.lastParkedAt.delete(taskId);
	}
}

// Minimal structural view of TerminalSessionManager — keeps the watchdog decoupled and
// trivially fakeable in tests. The real manager satisfies this.
interface WatchableTerminalManager {
	listSummaries(): RuntimeTaskSessionSummary[];
	getRestoreSnapshot(taskId: string): Promise<{ snapshot: string } | null>;
	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null;
	transitionToReview(taskId: string, reason: "error"): RuntimeTaskSessionSummary | null;
}

export interface StallWatchdogDependencies {
	listManagedWorkspaces: () => Array<{ workspaceId: string; terminalManager: WatchableTerminalManager }>;
	// Fires the same ready-for-review notification the hook path uses. PTY summaries are
	// not diffed for review transitions in the state hub, so this has to be explicit.
	notifyReviewReady?: (workspaceId: string, taskId: string) => void;
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
	const reviewCooldown = new ReviewCooldown();
	let timer: NodeJS.Timeout | null = null;
	let scanning = false;

	const evaluateSession = async (
		workspaceId: string,
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
		if (detection.action === "none") {
			return;
		}
		const idleSeconds = Math.round((nowMs - (summary.lastOutputAt ?? 0)) / 1000);

		if (detection.action === "review") {
			// Unrecoverable: park the task for the user instead of retrying it.
			if (!reviewCooldown.canPark(summary.taskId, nowMs)) {
				log(`skip task ${summary.taskId}: review-cooldown`);
				return;
			}
			const reviewed = manager.transitionToReview(summary.taskId, "error");
			if (reviewed?.state !== "awaiting_review") {
				// Record anyway: without it a session the reducer refuses to move would be
				// retried every poll forever.
				reviewCooldown.record(summary.taskId, nowMs);
				log(
					`could not flag task ${summary.taskId} for review (match=${detection.reason}, state=${reviewed?.state ?? "missing"})`,
				);
				return;
			}
			reviewCooldown.record(summary.taskId, nowMs);
			deps.notifyReviewReady?.(workspaceId, summary.taskId);
			log(`flagged task ${summary.taskId} for review (match=${detection.reason}, idle=${idleSeconds}s)`);
			return;
		}

		const errorClass = detection.errorClass ?? "transient";
		const gate = limiter.canInject(summary.taskId, nowMs, cooldownForErrorClass(errorClass));
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
		log(
			`injected "continue" into task ${summary.taskId} (match=${detection.reason}, class=${errorClass}, idle=${idleSeconds}s)`,
		);
	};

	const scanOnce = async (): Promise<void> => {
		if (scanning) {
			return;
		}
		scanning = true;
		try {
			for (const { workspaceId, terminalManager } of deps.listManagedWorkspaces()) {
				for (const summary of terminalManager.listSummaries()) {
					try {
						await evaluateSession(workspaceId, terminalManager, summary);
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
