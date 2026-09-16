import type { RuntimeTaskAutoReviewMode } from "./api-contract";

// Builds the follow-up prompt that asks an agent to commit its work or open a pull request
// once a task reaches review.
//
// This lives in `src/core/` rather than the browser app because two callers need it: the
// web UI's auto-review hooks, and the server-side unattended task driver that stands in for
// them when no browser is connected. The web UI reaches it through the
// `@runtime-task-git-action-prompt` alias.

export type TaskGitAction = Extract<RuntimeTaskAutoReviewMode, "commit" | "pr">;

interface TaskGitPromptVariable {
	key: string;
	token: string;
	description: string;
}

export const TASK_GIT_BASE_REF_PROMPT_VARIABLE: TaskGitPromptVariable = {
	key: "base_ref",
	token: "{{base_ref}}",
	description: "the branch this task worktree was created from",
};

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

export interface BuildTaskGitActionPromptInput {
	action: TaskGitAction;
	// The only value the templates can interpolate. Callers pass the task card's baseRef
	// directly; there is no need to resolve full worktree info just to build this string.
	baseRef: string;
	templates?: TaskGitPromptTemplates | null;
}

function resolveTemplate(action: TaskGitAction, templates?: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function interpolateTemplate(template: string, variables: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

export function buildTaskGitActionPrompt(input: BuildTaskGitActionPromptInput): string {
	const variables: Record<string, string> = {
		[TASK_GIT_BASE_REF_PROMPT_VARIABLE.key]: input.baseRef,
	};
	const template = resolveTemplate(input.action, input.templates);
	return interpolateTemplate(template, variables);
}
