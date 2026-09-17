# Contributing to Kanban (angel-manuel fork)

> **This repository is a modified fork of [cline/kanban](https://github.com/cline/kanban), and is not
> affiliated with or endorsed by Cline Bot Inc.** Contributions here go to this fork only. If you want
> your change in the official project, open it against
> [cline/kanban](https://github.com/cline/kanban) instead — maintainers here cannot merge on their behalf,
> and issues filed here are not seen by the upstream team.

Thanks for your interest in contributing! This project is in research preview, and we're focused on making the existing feature set rock-solid across platforms and agents before expanding scope. Community help is invaluable here.

## What We're Looking For

Kanban currently supports Claude, Codex, Gemini, OpenCode, Droid, and Cline as runtime agents, and runs on macOS, Linux, and Windows. The surface area for cross-compatibility issues is large, and that's where contributions have the most impact.

We are actively looking for help with:

- Cross-platform support: fixing bugs and inconsistencies across macOS, Linux, and Windows (terminal behavior, path handling, symlinks, shell detection, etc.)
- Agent compatibility: adding support for new CLI agents, fixing integration issues with existing ones, and improving agent detection/lifecycle management
- Bug fixes: anything that makes the current feature set more stable and reliable
- Test coverage: adding tests for untested paths, especially platform-specific and agent-specific behavior

We are not currently accepting feature PRs. If you have a feature idea, please open an [issue](https://github.com/angel-manuel/kanban/issues) instead. We may incorporate it into the roadmap, but the priority right now is stability and compatibility.

## Reporting Bugs

Before opening a new issue, search [existing issues](https://github.com/angel-manuel/kanban/issues) to avoid duplicates. When filing a bug, include:

- Your OS and version
- Which CLI agent you're using (and its version)
- Steps to reproduce
- Expected vs. actual behavior
- Any relevant terminal output or screenshots

If you discover a security vulnerability in this fork, please report it privately using [this repository's security advisory form](https://github.com/angel-manuel/kanban/security/advisories/new). If the vulnerability also affects upstream, please additionally report it to [cline/kanban](https://github.com/cline/kanban/security/advisories/new) so the original project can fix it too.

## Before Contributing

For bug fixes and compatibility improvements, open an issue first (unless it's a trivial fix like a typo or minor correction). Describe the problem and your proposed approach so we can align before you invest time.

PRs without a corresponding issue may be closed.

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/angel-manuel/kanban.git
   cd kanban
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the dev server:
   ```bash
   npm run dev        # Backend watch mode
   npm run web:dev    # Frontend Vite dev server (in a separate terminal)
   ```

4. Before submitting a PR, make sure both of these pass locally:
   ```bash
   npm run check      # Lint + typecheck + tests
   npm run build      # Full production build
   ```

## Writing and Submitting Code

1. Keep PRs small and focused. One bug fix or one compatibility improvement per PR. If your change touches multiple areas, split it into separate PRs.

2. Code quality:
   - No `any` types. Find the correct type from source or `node_modules`.
   - No inline or dynamic imports. Use standard top-level imports.
   - Write production-quality code, not prototypes.

3. Add tests for your changes. Run `npm run test` to verify everything passes.

4. Use [conventional commit](https://www.conventionalcommits.org/) format for commit messages (e.g., `fix(terminal):`, `feat(agents):`, `test:`). Reference the issue number with `fixes #123` or `closes #123` when applicable.


## Adding Support for a New CLI Agent

If you'd like to add support for a new CLI agent, open an issue first to discuss. A good agent integration PR typically includes:

- Agent detection (checking if the CLI is installed and available on PATH)
- Session startup and lifecycle management
- Side panel prompt injection for supported agents so the agent can interact with the board
- Terminal integration and hook support
- Tests covering the above

Look at the existing agent implementations in `src/` for reference. The agent list lives in `src/cli.ts` and the runtime abstractions are nearby.

## Philosophy

Kanban is in foundation mode. Favor clear primitives and good tooling over early complexity. Build extensibility into the core, then layer product features iteratively.

## Community

- [Issues](https://github.com/angel-manuel/kanban/issues) — for this fork
- [Upstream project](https://github.com/cline/kanban) — the original, maintained by Cline Bot Inc.

Cline Bot Inc.'s community channels (Discord, discussions, feature-request boards) are for the
upstream project. Please do not take questions about this fork there.

## License

By submitting a pull request, you agree that your contributions will be licensed under the project's [Apache 2.0 license](./LICENSE), the same license as the upstream work this fork is derived from.
