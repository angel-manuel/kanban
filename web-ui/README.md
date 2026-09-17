# Kanban Web UI

This package contains the Kanban frontend served by the runtime.

## Stack

- React + TypeScript + Vite
- Tailwind CSS v4, Radix UI primitives, Lucide icons
- Atlassian pragmatic drag-and-drop
- Vitest
- Playwright

## Telemetry

All telemetry in this fork is opt-in and **off by default**, including in release builds. This
repository is an unaffiliated fork of [cline/kanban](https://github.com/cline/kanban), so it ships
no analytics, error-reporting, or feedback destinations of its own — point them at your own
projects or leave them unset. Never point them at Cline Bot Inc.'s accounts.

1. Copy `web-ui/.env.example` to `web-ui/.env.local`.
2. Set `POSTHOG_KEY` **and** `POSTHOG_HOST` to your own PostHog project. Both are required; there
   is no default host.
3. Optionally set `SENTRY_DSN` (error reporting) and `FEATUREBASE_ORGANIZATION` (feedback widget).

When `POSTHOG_KEY` or `POSTHOG_HOST` is empty, the app does not initialize PostHog. When
`SENTRY_DSN` is empty, Sentry never initializes. When `FEATUREBASE_ORGANIZATION` is empty, the
"Send feedback" button is hidden. See [Telemetry config](../DEVELOPMENT.md#telemetry-config).

Current behavior when analytics are explicitly enabled:
- Session replay is disabled.
- Autocapture is disabled. This means PostHog does not automatically capture clicks, form edits, or other raw DOM interactions.
- Pageview events are enabled for active user metrics.

## Scripts

- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm run test`
- `npm run e2e`
