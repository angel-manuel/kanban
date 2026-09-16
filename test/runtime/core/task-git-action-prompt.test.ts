import { describe, expect, it } from "vitest";

import { buildTaskGitActionPrompt, TASK_GIT_BASE_REF_PROMPT_VARIABLE } from "../../../src/core/task-git-action-prompt";

describe("buildTaskGitActionPrompt", () => {
	it("interpolates the shared base ref variable into custom templates", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				baseRef: "main",
				templates: {
					commitPromptTemplate: `Commit onto ${TASK_GIT_BASE_REF_PROMPT_VARIABLE.token}.`,
				},
			}),
		).toBe("Commit onto main.");
	});

	it("falls back to the default action prompt when no template is configured", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				baseRef: "main",
			}),
		).toBe("Handle this pull request action using the provided git context.");
	});

	it("replaces every occurrence of the base ref token", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				baseRef: "release/2.0",
				templates: {
					commitPromptTemplate: "Rebase onto {{base_ref}} then commit onto {{base_ref}}.",
				},
			}),
		).toBe("Rebase onto release/2.0 then commit onto release/2.0.");
	});

	// The server passes a RuntimeConfigState, whose templates are already defaulted by
	// normalizePromptTemplate, so the *Default fallback branch is never reached there.
	it("prefers a configured template over the supplied default", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				baseRef: "main",
				templates: {
					openPrPromptTemplate: "Open a PR against {{base_ref}}.",
					openPrPromptTemplateDefault: "Default PR prompt.",
				},
			}),
		).toBe("Open a PR against main.");
	});

	it("falls back to the supplied default when the template is blank", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				baseRef: "main",
				templates: {
					commitPromptTemplate: "   ",
					commitPromptTemplateDefault: "Default commit prompt for {{base_ref}}.",
				},
			}),
		).toBe("Default commit prompt for main.");
	});
});
