import packageJson from "../../package.json" with { type: "json" };

/**
 * The npm package name this build was published under.
 *
 * This is deliberately read from package.json rather than hardcoded: this repository is a fork,
 * and a hardcoded upstream name would make the self-update path fetch, compare against, and
 * install the upstream package instead of this one.
 */
export const KANBAN_PACKAGE_NAME: string = typeof packageJson.name === "string" ? packageJson.name : "kanban";
