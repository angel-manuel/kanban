/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
	readonly POSTHOG_KEY?: string;
	readonly POSTHOG_HOST?: string;
	readonly SENTRY_DSN?: string;
	readonly FEATUREBASE_ORGANIZATION?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
