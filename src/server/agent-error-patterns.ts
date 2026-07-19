// Vocabulary for API error lines claude prints into its terminal, and how the runtime
// should react to each.
//
// The stall watchdog scans the terminal scrollback tail; when it finds one of these it
// needs to know whether nudging the session can help. A transient overload clears itself
// if we type "continue"; an expired token never will, and retrying it just burns the
// injection budget while the task sits silently in `running`.
//
// Credit exhaustion is classified by `isCreditLimitError` (src/cline-sdk/cline-session-state.ts)
// rather than re-listed here: it already takes a plain string, so once we have isolated the
// `API Error:` detail we can hand it straight over and keep that vocabulary in one place.

import { isCreditLimitError } from "../cline-sdk/cline-session-state";

export type AgentErrorClass =
	// The specific "Response stalled mid-stream" freeze. Nudging resumes the turn.
	| "stall"
	// Server-side or network hiccup — overload, 5xx, dropped connection. Retryable.
	| "transient"
	// Rate or usage limit. Retryable, but only after a much longer wait.
	| "rate-limited"
	// Auth, credits, or a malformed request. No amount of nudging fixes it.
	| "fatal";

export interface AgentErrorMatch {
	errorClass: AgentErrorClass;
	// Id of the pattern that matched, surfaced in watchdog log lines.
	pattern: string;
}

interface ErrorPattern {
	id: string;
	errorClass: AgentErrorClass;
	matches: (tailText: string) => boolean;
}

// Every pattern below must be anchored to the shape of a real claude error line, never
// matched loosely against the scrollback. The tail we scan is 30 lines of whatever the
// agent last printed, which routinely includes source code, diffs, and grep output — an
// agent reading this very file would otherwise be classified as fatally broken and
// silently parked.
//
// The anchor is the same in both cases: the error has to *start its own line*, allowing
// only whitespace and claude's box-drawing gutter before it. Quoted strings, diff bodies,
// and grep hits carry other leading characters (`"`, `[`, `+`, `#`), so they never match.
const LINE_START = String.raw`(?:^|\n)[\s>⎿│└├─]*`;

// 1. Most failures render as a single `API Error: <detail>` line. Isolate those details
//    once, then test each pattern against them rather than against the whole tail.
const API_ERROR_LINE = new RegExp(`${LINE_START}API Error:([^\\n]*)`, "gi");

function apiErrorDetails(tailText: string): string[] {
	return [...tailText.matchAll(API_ERROR_LINE)].map((match) => match[1] ?? "");
}

function apiErrorDetail(detail: string): (tailText: string) => boolean {
	const test = new RegExp(detail, "i");
	return (tailText) => apiErrorDetails(tailText).some((line) => test.test(line));
}

// 2. A few are printed by the CLI itself rather than relayed from the API, so they have
//    no `API Error:` prefix and are matched against the tail directly.
function ownLine(detail: string): (tailText: string) => boolean {
	const test = new RegExp(`${LINE_START}${detail}`, "i");
	return (tailText) => test.test(tailText);
}

// Ordered most-specific-first: the first match wins, so the generic `API Error` fallback
// at the end only applies to lines nothing else recognised.
const PATTERNS: readonly ErrorPattern[] = [
	// --- fatal: a nudge cannot fix these, flag the session for review instead ---
	{ id: "auth-error", errorClass: "fatal", matches: apiErrorDetail(/authentication_error|invalid x-api-key/.source) },
	{ id: "permission-error", errorClass: "fatal", matches: apiErrorDetail("permission_error") },
	{ id: "http-auth", errorClass: "fatal", matches: apiErrorDetail(String.raw`\b40[13]\b`) },
	{
		id: "credits-exhausted",
		errorClass: "fatal",
		// Delegates to the Cline-path vocabulary so both agents recognise the same wording.
		matches: (tailText) =>
			apiErrorDetails(tailText).some((line) => isCreditLimitError(line) || /credit balance is too low/i.test(line)),
	},
	{
		id: "prompt-too-long",
		errorClass: "fatal",
		matches: apiErrorDetail(/prompt is too long|input length and .max_tokens/.source),
	},
	{ id: "invalid-request", errorClass: "fatal", matches: apiErrorDetail("invalid_request_error") },
	// Printed by the CLI on an expired subscription token, with no API Error prefix.
	{ id: "oauth-expired", errorClass: "fatal", matches: ownLine(/oauth token (?:has )?expired/.source) },

	// --- rate limited: retryable, but the cooldown has to be much longer ---
	{ id: "rate-limit", errorClass: "rate-limited", matches: apiErrorDetail("rate_limit_error") },
	{ id: "http-429", errorClass: "rate-limited", matches: apiErrorDetail(String.raw`\b429\b`) },
	// The subscription-plan limit, also printed by the CLI rather than relayed.
	{ id: "usage-limit", errorClass: "rate-limited", matches: ownLine("claude usage limit reached") },

	// --- transient: server or network hiccup, a nudge resumes the turn ---
	{ id: "overloaded", errorClass: "transient", matches: apiErrorDetail("overloaded_error") },
	{ id: "http-5xx", errorClass: "transient", matches: apiErrorDetail(String.raw`\b5\d\d\b`) },
	{
		id: "connection",
		errorClass: "transient",
		matches: apiErrorDetail(
			/connection error|fetch failed|network error|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/
				.source,
		),
	},
	{ id: "timeout", errorClass: "transient", matches: apiErrorDetail(/request timed out|request timeout/.source) },

	// --- the original signal ---
	{ id: "stalled-mid-stream", errorClass: "stall", matches: apiErrorDetail("Response stalled mid-stream") },

	// Generic trailing fallback, preserving the watchdog's original behaviour: an
	// unrecognised API error on an idle session is assumed retryable.
	{ id: "generic-api-error", errorClass: "transient", matches: ownLine("API Error") },
];

// Classify the most severe error visible in an already-ANSI-stripped terminal tail, or
// null when the tail shows no error at all.
export function classifyClaudeErrorTail(tailText: string): AgentErrorMatch | null {
	for (const pattern of PATTERNS) {
		if (pattern.matches(tailText)) {
			return { errorClass: pattern.errorClass, pattern: pattern.id };
		}
	}
	return null;
}
