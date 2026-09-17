## Kanban (fork) — Research Preview

> [!IMPORTANT]
> **This is a modified fork, not the official Cline project.**
> It is based on [cline/kanban](https://github.com/cline/kanban) by Cline Bot Inc., licensed under
> [Apache License 2.0](./LICENSE), and has been modified by contributors to
> [angel-manuel/kanban](https://github.com/angel-manuel/kanban).
> This fork is **not affiliated with, sponsored by, or endorsed by Cline Bot Inc.**
> "Cline" is a name of Cline Bot Inc.; the Apache-2.0 license grants no trademark rights
> (see [Section 6](./LICENSE)). Please report issues with this fork to
> [this repository](https://github.com/angel-manuel/kanban/issues), **not** to upstream.
> See [Attribution and changes](#attribution-and-changes) for details.

A replacement for your IDE better suited for running many agents in parallel and reviewing diffs. Each task card gets its own terminal and worktree, all handled for you automatically. Enable auto-commit and link cards together to create dependency chains that complete large amounts of work autonomously.

> [!WARNING]
> Kanban is a research preview and uses experimental features of CLI agents like bypassing permissions and runtime hooks for more autonomy.

<div align="left">
<table>
<tbody>
<td align="center">
<a href="https://github.com/angel-manuel/kanban" target="_blank">GitHub (this fork)</a>
</td>
<td align="center">
<a href="https://github.com/angel-manuel/kanban/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban" target="_blank">Upstream project</a>
</td>
</tbody>
</table>
</div>

### 1. Open kanban

```bash
# Build and run from source (this fork is not published to npm)
git clone https://github.com/angel-manuel/kanban.git
cd kanban
npm run install:all
npm run link   # builds, then links the `kanban` binary globally
kanban
```

> [!NOTE]
> The upstream project publishes the unscoped `kanban` package on npm. This fork is configured
> to publish as `@angel-manuel/kanban` so it can never be confused with it, but no release has
> been published. Running `npx kanban` installs **upstream**, not this fork.

Run this from the root of any git repo. Kanban will detect your installed CLI agent and launch a local running webserver in your browser. No account or setup required, it works right out of the box.

### 2. Create tasks
Create a task card manually, or open the sidebar chat and ask your agent to break work down into tasks for you. Kanban injects board-management instructions into that session so you can simply ask it to add tasks, link tasks, or start work on your board.

### 3. Link and automate
<kbd>⌘</kbd> + click a card to link it to another task. When a card is completed and moved to trash, linked tasks auto-start. Combine with auto-commit for fully autonomous dependency chains: one task completes → commits → kicks off the next → repeat. It’s a pretty magical experience asking your agent to decompose a big task into subtasks that auto-commit - he’ll cleverly do it in a way that parallelizes for maximum efficiency and links tasks together for end-to-end autonomy.

### 4. Start tasks
Hit the play button on a card. Kanban creates an ephemeral worktree just for that task so agents work in parallel without merge conflicts. Under the hood, it also symlinks gitignored files like `node_modules` so you don't have to worry about slow `npm install`s for each copy of your project.

> [!NOTE]
> [Symlinks (symbolic links)](https://en.wikipedia.org/wiki/Symbolic_link) are special "shortcuts" pointing to another file or directory, allowing access to the target from a new location without duplicating data. They work great in this case since you typically don't modify gitignored files in day-to-day work, but for when you do then don't use Kanban.

As agents work, Kanban uses hooks to display the latest message or tool call on each card, so you can monitor hundreds of agents at a glance without opening each one.

### 5. Review changes
Click a card to view the agent's TUI and a diff of all the changes in that worktree. Kanban includes its own checkpointing system so you can also see a diff from the last messages you've sent. Click on lines to leave comments and send them back to the agent.

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar instead of remembering commands or asking your agent to do it.

### 6. Ship it
When the work looks good, hit **Commit** or **Open PR**. Kanban sends a dynamic prompt to the agent to convert the worktree into a commit on your base ref or a new PR branch, and work through any merge conflicts intelligently. Or skip review by enabling auto-commit / auto-PR and the agent ships as soon as it's done. Move the card to trash to clean up the worktree (you can always resume later since Kanban tracks the resume ID).

### 7. Keep track with git interface
Click the branch name in the navbar to open a full git interface to browse commit history, switch branches, fetch, pull, push, and visualize your git all without leaving Kanban. Keep track of everything your agents are doing across branches as work is completed.

---

## Attribution and changes

This program is a fork of [cline/kanban](https://github.com/cline/kanban).

- **Original work:** Kanban, Copyright 2026 Cline Bot Inc., licensed under the
  [Apache License, Version 2.0](./LICENSE). The `LICENSE` file is preserved unmodified.
- **This distribution:** contains modifications made by contributors to
  [angel-manuel/kanban](https://github.com/angel-manuel/kanban), and is distributed under the
  same Apache License 2.0. Modifications are recorded in the git history of this repository and
  in [`CHANGELOG.md`](./CHANGELOG.md).
- **Changed files carry no separate notice** beyond this statement; consult
  `git log` / `git diff` against the upstream remote for the exact set of changes.
- **No trademark license.** Apache-2.0 Section 6 grants no rights to the trade names, trademarks,
  service marks, or product names of the licensor. "Cline" and related marks belong to
  Cline Bot Inc. and are used here only to identify the upstream origin of this code and to
  describe interoperability with Cline software. This fork is not affiliated with, sponsored by,
  or endorsed by Cline Bot Inc.
- **Upstream dependencies.** This project depends on the `@clinebot/*` packages published by
  Cline Bot Inc. Those are unmodified third-party dependencies, consumed under their own terms.
- **No telemetry to upstream.** Error reporting, analytics, and in-app feedback are opt-in and
  disabled by default in this fork, so it never reports to Cline Bot Inc.'s Sentry, PostHog, or
  Featurebase accounts. See [Telemetry config](./DEVELOPMENT.md#telemetry-config).

Support requests, bug reports, and feature ideas for this fork belong in
[angel-manuel/kanban](https://github.com/angel-manuel/kanban/issues) and must not be directed at
Cline Bot Inc. or the upstream project's support channels.

---

Licensed under the [Apache License 2.0](./LICENSE). Original work Copyright 2026 Cline Bot Inc.;
modifications Copyright 2026 the angel-manuel/kanban contributors.
