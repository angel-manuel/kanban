// Shared helpers for reading numeric tunables and on/off switches out of the environment.
//
// Background services in this directory are all built the same way: a handful of
// `KANBAN_*` knobs with sensible defaults, plus one kill switch. These two helpers used to
// live privately inside `stall-watchdog.ts`; they moved here when the unattended task
// driver needed the identical behaviour.

// Reads a non-negative integer, falling back when unset, unparseable, or negative.
export function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) {
		return fallback;
	}
	const parsed = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Features guarded this way are on unless explicitly turned off, so a typo in the value
// never silently disables a service the user expects to be running.
export function isEnvSwitchEnabled(name: string): boolean {
	const value = (process.env[name] ?? "").trim().toLowerCase();
	return value !== "off" && value !== "0" && value !== "false" && value !== "no";
}
