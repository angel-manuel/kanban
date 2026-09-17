import * as Sentry from "@sentry/react";

// Opt-in only. This fork ships without a DSN so it never reports to the upstream project's
// Sentry account; set SENTRY_DSN at build time to point it at your own.
const sentryDsn = import.meta.env.SENTRY_DSN?.trim() ?? "";
const sentryEnvironment = import.meta.env.MODE;

let initialized = false;

export function initializeSentry(): void {
	if (!sentryDsn || initialized) {
		return;
	}

	Sentry.init({
		dsn: sentryDsn,
		environment: sentryEnvironment,
		release: `kanban@${__APP_VERSION__}`,
		sendDefaultPii: false,
		initialScope: {
			tags: {
				app: "kanban",
				runtime_surface: "web",
			},
		},
	});

	initialized = true;
}

export function isSentryEnabled(): boolean {
	return initialized;
}
