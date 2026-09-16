import { readFile } from "node:fs/promises";
import type { z } from "zod";

// Reading and schema-validating the JSON files that make up a workspace's persisted state.
//
// Extracted from `workspace-state.ts` when `schedules.json` became a second store: the
// point is that every persisted file reports a malformed or schema-violating payload the
// same way, naming the path and telling the user they can fix or remove it.

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// Returns null for a missing file, so callers can fall back to a default without treating
// "not created yet" as an error.
export async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

function formatSchemaIssuePath(pathSegments: PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return "root";
	}
	return pathSegments
		.map((segment) => {
			if (typeof segment === "number") {
				return `[${segment}]`;
			}
			return String(segment);
		})
		.join(".");
}

export function formatSchemaIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

export function parsePersistedStateFile<T>(
	filePath: string,
	fileLabel: string,
	raw: unknown | null,
	schema: z.ZodType<T>,
	defaultValue: T,
): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid ${fileLabel} file at ${filePath}. ` +
				`Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}
