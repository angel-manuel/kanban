import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { useId, useMemo, useState } from "react";
import { ScheduleRecurrencePicker } from "@/components/schedules/schedule-recurrence-picker";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type {
	RuntimeAgentId,
	RuntimeScheduleCreateRequest,
	RuntimeScheduleOverlapPolicy,
	RuntimeScheduleRecurrence,
	RuntimeScheduleSummary,
	RuntimeTaskAutoReviewMode,
} from "@/runtime/types";

// Create/edit form for a recurring schedule.
//
// The form owns its own draft state and hands a complete request back on submit, so the
// dialog above it stays a list-versus-form switch rather than a second state container.

const DEFAULT_RECURRENCE: RuntimeScheduleRecurrence = { kind: "daily", hour: 2, minute: 0 };

export interface ScheduleFormProps {
	schedule: RuntimeScheduleSummary | null;
	serverTimezone: string;
	isSaving: boolean;
	onCancel: () => void;
	onSubmit: (input: RuntimeScheduleCreateRequest) => void;
}

export function ScheduleForm({
	schedule,
	serverTimezone,
	isSaving,
	onCancel,
	onSubmit,
}: ScheduleFormProps): React.ReactElement {
	const nameId = useId();
	const promptId = useId();
	const baseRefId = useId();
	const agentId = useId();
	const reviewId = useId();
	const overlapId = useId();

	const [name, setName] = useState(schedule?.name ?? "");
	const [recurrence, setRecurrence] = useState<RuntimeScheduleRecurrence>(schedule?.recurrence ?? DEFAULT_RECURRENCE);
	const [timezone, setTimezone] = useState(schedule?.timezone ?? serverTimezone);
	const [prompt, setPrompt] = useState(schedule?.task.prompt ?? "");
	const [baseRef, setBaseRef] = useState(schedule?.task.baseRef ?? "");
	const [selectedAgentId, setSelectedAgentId] = useState<RuntimeAgentId | "">(schedule?.task.agentId ?? "");
	const [autoReviewMode, setAutoReviewMode] = useState<RuntimeTaskAutoReviewMode>(
		schedule?.task.autoReviewMode ?? "pr",
	);
	const [overlapPolicy, setOverlapPolicy] = useState<RuntimeScheduleOverlapPolicy>(schedule?.overlapPolicy ?? "skip");
	const [startInPlanMode, setStartInPlanMode] = useState(schedule?.task.startInPlanMode ?? false);

	const agents = useMemo(() => getRuntimeLaunchSupportedAgentCatalog(), []);
	const canSubmit = name.trim().length > 0 && prompt.trim().length > 0 && !isSaving;

	const submit = (): void => {
		if (!canSubmit) {
			return;
		}
		onSubmit({
			name: name.trim(),
			enabled: schedule?.enabled ?? true,
			recurrence,
			timezone,
			overlapPolicy,
			task: {
				prompt: prompt.trim(),
				startInPlanMode,
				autoReviewMode,
				...(selectedAgentId ? { agentId: selectedAgentId } : {}),
				baseRef: baseRef.trim() || null,
			},
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1">
				<label htmlFor={nameId} className="text-[12px] text-text-secondary">
					Name
				</label>
				<input
					id={nameId}
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Nightly audit"
					className="h-8 rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
				/>
			</div>

			<ScheduleRecurrencePicker
				recurrence={recurrence}
				timezone={timezone}
				serverTimezone={serverTimezone}
				onRecurrenceChange={setRecurrence}
				onTimezoneChange={setTimezone}
			/>

			<div className="flex flex-col gap-1">
				<label htmlFor={promptId} className="text-[12px] text-text-secondary">
					Prompt
				</label>
				<textarea
					id={promptId}
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					rows={5}
					placeholder="Research the codebase and open one cleanup pull request per area of the system."
					className="rounded-md border border-border-bright bg-surface-2 px-2 py-1.5 text-[13px] text-text-primary resize-y focus:border-border-focus focus:outline-none"
				/>
			</div>

			<div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
				<div className="flex flex-col gap-1">
					<label htmlFor={agentId} className="text-[12px] text-text-secondary">
						Agent
					</label>
					<NativeSelect
						id={agentId}
						value={selectedAgentId}
						onChange={(event) => setSelectedAgentId(event.target.value as RuntimeAgentId | "")}
						fill
					>
						<option value="">Project default</option>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.label}
							</option>
						))}
					</NativeSelect>
				</div>

				<div className="flex flex-col gap-1">
					<label htmlFor={baseRefId} className="text-[12px] text-text-secondary">
						Base branch
					</label>
					<input
						id={baseRefId}
						value={baseRef}
						onChange={(event) => setBaseRef(event.target.value)}
						placeholder="Repository default"
						className="h-8 rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
					/>
				</div>

				<div className="flex flex-col gap-1">
					<label htmlFor={reviewId} className="text-[12px] text-text-secondary">
						When it finishes
					</label>
					<NativeSelect
						id={reviewId}
						value={autoReviewMode}
						onChange={(event) => setAutoReviewMode(event.target.value as RuntimeTaskAutoReviewMode)}
						fill
					>
						<option value="pr">Open a pull request</option>
						<option value="commit">Commit to the base branch</option>
					</NativeSelect>
				</div>

				<div className="flex flex-col gap-1">
					<label htmlFor={overlapId} className="text-[12px] text-text-secondary">
						If the previous run is still going
					</label>
					<NativeSelect
						id={overlapId}
						value={overlapPolicy}
						onChange={(event) => setOverlapPolicy(event.target.value as RuntimeScheduleOverlapPolicy)}
						fill
					>
						<option value="skip">Skip this run</option>
						<option value="allow">Start another anyway</option>
					</NativeSelect>
				</div>
			</div>

			<label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer w-fit">
				<input
					type="checkbox"
					checked={startInPlanMode}
					onChange={(event) => setStartInPlanMode(event.target.checked)}
					className="accent-accent"
				/>
				Start in plan mode
			</label>

			<div className="flex justify-end gap-2 pt-1">
				<Button variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button variant="primary" onClick={submit} disabled={!canSubmit}>
					{schedule ? "Save changes" : "Create schedule"}
				</Button>
			</div>
		</div>
	);
}
