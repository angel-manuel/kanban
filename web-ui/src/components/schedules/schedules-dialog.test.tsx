import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchedulesDialog } from "@/components/schedules/schedules-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeScheduleListResponse, RuntimeScheduleSummary } from "@/runtime/types";

const listQuery = vi.fn();
const createMutate = vi.fn();
const updateMutate = vi.fn();
const setEnabledMutate = vi.fn();
const removeMutate = vi.fn();
const runNowMutate = vi.fn();

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		schedules: {
			list: { query: listQuery },
			create: { mutate: createMutate },
			update: { mutate: updateMutate },
			setEnabled: { mutate: setEnabledMutate },
			remove: { mutate: removeMutate },
			runNow: { mutate: runNowMutate },
		},
	}),
}));

const toasts: Array<{ intent?: string; message?: string }> = [];
vi.mock("@/components/app-toaster", () => ({
	showAppToast: (options: { intent?: string; message?: string }) => {
		toasts.push(options);
	},
}));

const NOW = Date.now();

function makeSchedule(overrides: Partial<RuntimeScheduleSummary> = {}): RuntimeScheduleSummary {
	return {
		id: "sched-1",
		name: "Nightly refactor",
		enabled: true,
		recurrence: { kind: "daily", hour: 2, minute: 0 },
		timezone: "UTC",
		overlapPolicy: "skip",
		task: { prompt: "Refactor big files", startInPlanMode: false, autoReviewMode: "pr", baseRef: null },
		lastRunAt: null,
		lastTaskId: null,
		lastStatus: null,
		lastError: null,
		createdAt: NOW,
		updatedAt: NOW,
		nextRunAt: NOW + 3_600_000,
		description: "At 02:00 AM (UTC)",
		cronError: null,
		...overrides,
	};
}

function makeResponse(schedules: RuntimeScheduleSummary[]): RuntimeScheduleListResponse {
	return { schedules, serverTimezone: "UTC" };
}

function flush() {
	return act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("SchedulesDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		for (const mock of [listQuery, createMutate, updateMutate, setEnabledMutate, removeMutate, runNowMutate]) {
			mock.mockReset();
		}
		toasts.length = 0;
		listQuery.mockResolvedValue(makeResponse([makeSchedule()]));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	async function renderDialog(open = true) {
		act(() => {
			// Matches how main.tsx mounts the app; the rows use Tooltip.
			root.render(
				<TooltipProvider>
					<SchedulesDialog open={open} onOpenChange={() => {}} workspaceId="ws-1" />
				</TooltipProvider>,
			);
		});
		await flush();
	}

	function bodyText(): string {
		return document.body.textContent ?? "";
	}

	function findByLabel(label: string): HTMLElement | null {
		return document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	}

	it("lists schedules with their description and next run", async () => {
		await renderDialog();
		expect(bodyText()).toContain("Nightly refactor");
		expect(bodyText()).toContain("At 02:00 AM (UTC)");
		expect(bodyText()).toContain("Next");
	});

	it("says so when there are no schedules", async () => {
		listQuery.mockResolvedValue(makeResponse([]));
		await renderDialog();
		expect(bodyText()).toContain("No schedules yet");
	});

	it("shows a paused schedule instead of a next run", async () => {
		listQuery.mockResolvedValue(makeResponse([makeSchedule({ enabled: false, nextRunAt: null })]));
		await renderDialog();
		expect(bodyText()).toContain("Paused");
	});

	it("surfaces an invalid expression", async () => {
		listQuery.mockResolvedValue(makeResponse([makeSchedule({ cronError: "Expected 5 cron fields" })]));
		await renderDialog();
		expect(bodyText()).toContain("Expected 5 cron fields");
	});

	it("toggling the switch disables the schedule", async () => {
		setEnabledMutate.mockResolvedValue({ ok: true, schedule: makeSchedule({ enabled: false }) });
		await renderDialog();

		const toggle = findByLabel("Disable Nightly refactor");
		expect(toggle).not.toBeNull();
		await act(async () => {
			toggle?.click();
		});
		await flush();

		expect(setEnabledMutate).toHaveBeenCalledWith({ scheduleId: "sched-1", enabled: false });
	});

	it("run now starts the schedule and reports success", async () => {
		runNowMutate.mockResolvedValue({ ok: true, status: "ok", taskId: "task-1" });
		await renderDialog();

		await act(async () => {
			findByLabel("Run Nightly refactor now")?.click();
		});
		await flush();

		expect(runNowMutate).toHaveBeenCalledWith({ scheduleId: "sched-1" });
		expect(toasts.some((toast) => toast.message === "Schedule started.")).toBe(true);
	});

	// A skipped run is the overlap policy working, not an error.
	it("reports a skipped run as a warning rather than a failure", async () => {
		runNowMutate.mockResolvedValue({ ok: false, status: "skipped_overlap", taskId: null });
		await renderDialog();

		await act(async () => {
			findByLabel("Run Nightly refactor now")?.click();
		});
		await flush();

		expect(toasts.some((toast) => toast.intent === "warning")).toBe(true);
		expect(toasts.some((toast) => toast.intent === "danger")).toBe(false);
	});

	it("surfaces a failed mutation as an error toast", async () => {
		setEnabledMutate.mockResolvedValue({ ok: false, schedule: null, error: "Schedule not found." });
		await renderDialog();

		await act(async () => {
			findByLabel("Disable Nightly refactor")?.click();
		});
		await flush();

		expect(toasts.some((toast) => toast.intent === "danger" && toast.message === "Schedule not found.")).toBe(true);
	});

	it("asks for confirmation before deleting", async () => {
		await renderDialog();

		await act(async () => {
			findByLabel("Delete Nightly refactor")?.click();
		});
		await flush();

		expect(bodyText()).toContain("Delete schedule");
		expect(removeMutate).not.toHaveBeenCalled();
	});

	it("opens the form when creating a new schedule", async () => {
		await renderDialog();

		const newButton = [...document.body.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("New schedule"),
		);
		await act(async () => {
			newButton?.click();
		});
		await flush();

		expect(bodyText()).toContain("Create schedule");
		expect(bodyText()).toContain("Timezone");
	});

	it("does not query until it is opened", async () => {
		await renderDialog(false);
		expect(listQuery).not.toHaveBeenCalled();
	});
});
