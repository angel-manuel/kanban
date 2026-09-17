import type { PostHogConfig } from "posthog-js";

function getTrimmedEnvValue(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export const posthogApiKey = getTrimmedEnvValue(import.meta.env.POSTHOG_KEY);
// No default host: this fork must not fall back to the upstream project's analytics endpoint.
// Both POSTHOG_KEY and POSTHOG_HOST have to be set at build time for analytics to run at all.
export const posthogHost = getTrimmedEnvValue(import.meta.env.POSTHOG_HOST);

export const posthogOptions: Partial<PostHogConfig> = {
	api_host: posthogHost ?? undefined,
	defaults: "2026-01-30",
	autocapture: false,
	capture_pageview: true,
	capture_pageleave: true,
	disable_session_recording: true,
	capture_exceptions: false,
	person_profiles: "identified_only",
	disable_surveys: true,
	disable_surveys_automatic_display: true,
	disable_web_experiments: true,
};

export function isTelemetryEnabled(): boolean {
	return Boolean(posthogApiKey) && Boolean(posthogHost);
}
