# Dependency and security update policy

Upstream `cline/kanban` has effectively stopped maintaining dependencies. Since
`v0.1.70` (2026-07-12) the only `main` commits are two pure security
remediations — `14e371ff` (2026-08-11, undici/ws/trace remediation) and
`abd4912c` (2026-09-04, nanoid/electron/dompurify bumps). This fork therefore
owns dependency maintenance outright.

This page is the triage policy. The automation that implements it lives in
[`.github/dependabot.yml`](../.github/dependabot.yml) and
[`.github/workflows/audit.yml`](../.github/workflows/audit.yml).

## Where dependencies live

Three independent npm projects, each with its own lockfile. There is no npm
workspaces root — `npm install` in one does not touch the others.

| Project | Manifest | Installed by |
| --- | --- | --- |
| Runtime / CLI | `package.json` | `npm install` |
| Web UI | `web-ui/package.json` | `npm --prefix web-ui install` |
| Desktop shell | `packages/desktop/package.json` | `npm --prefix packages/desktop install` |

`npm run install:all` does all three. Any audit or bump has to be repeated per
project, which is why the audit workflow loops over all three explicitly.

## Automation, and what it does not cover

**Dependabot** (`.github/dependabot.yml`) watches all three npm projects plus
GitHub Actions. Nothing auto-merges — every PR is reviewed by a human.

- **Version updates** are grouped and batched **weekly** (Mondays 06:00 UTC):
  dev dependencies in one PR, production dependencies in another, Radix
  packages in their own group. Majors are excluded from the groups, so each
  major arrives as its own reviewable PR.
- **Security updates** are deliberately left **ungrouped**, so each advisory
  opens its own PR as soon as it lands rather than waiting for the weekly batch.
- A **cooldown** (3 days, 7 for majors) keeps a freshly published version from
  being pulled in within hours of release, so a compromised publish has a window
  to be caught and yanked first.

> Dependabot security updates must also be switched on in
> **Settings → Code security → Dependabot alerts / Dependabot security updates**.
> That is a repository setting; the config file alone cannot enable it.

**What Dependabot does not do: it does not manage npm `overrides` blocks.** All
three manifests pin transitive packages through `overrides`. A floor written as
`">=X <Y"` is satisfied by the already-locked version `X`, so the lockfile never
moves and the override quietly holds a vulnerable version indefinitely. This is
exactly the failure `abd4912c` described as "our own stale pin". Dependabot will
never open a PR for it.

That gap is why `.github/workflows/audit.yml` exists: it audits the resolved
lockfiles weekly (and on any PR touching a manifest or lockfile), which is where
a stale override floor actually shows up. High and critical findings fail the
job; moderate and low are reported in the job summary only.

## Triage policy

Severity is the npm audit / GitHub advisory severity, adjusted for whether the
vulnerable code path is actually reachable in Kanban.

| Severity | Response |
| --- | --- |
| Critical | Patch immediately, out of band. Release a patch version. |
| High | Patch within a week. Does not wait for the weekly batch. |
| Moderate | Fold into the next weekly Dependabot batch. |
| Low | Batch; may be deferred if the fix requires a major bump. |

Reachability matters and should be recorded in the PR. A DoS advisory in a
build-time dev dependency is not the same risk as one in the HTTP server the
runtime exposes. Downgrade the response if the path is unreachable, but write
down why.

**Never run `npm audit fix --force` in this repo.** `npm audit` currently
proposes "fixing" `@clinebot/core` by moving `0.0.38` → `0.0.28` → `0.0.5`.
`0.0.38` is the latest published version; those are downgrades of the core agent
SDK, not fixes. The advisory is in the OpenTelemetry chain underneath it and is
correctly resolved with an `@opentelemetry/core` override instead.

## Quarterly override review

`npm audit` catches an override floor once it becomes vulnerable. This review
catches floors that are *about* to, and dead overrides that no longer apply.

For each `overrides` entry in the three manifests:

1. Compare the floor against the resolved version in the lockfile. If they are
   equal, the floor is load-bearing and will not move on its own — check whether
   a newer patch exists.
2. Compare the floor against the version that actually fixes the advisory it was
   added for. A floor below the fixed version is a stale pin.
3. Check the override still matches something installed. `npm ls <pkg>` returning
   nothing means the override is dead and should be removed.
4. Check that open-ended floors (`">=X"` with no upper bound) cannot silently
   cross a major boundary on the next lockfile refresh.
5. Keep the same package's floor consistent across all three manifests.

## Syncing from upstream

Upstream is treated as dormant, not dead. `upstream` remains configured as a
git remote.

- **Check monthly.** `git fetch upstream && git log --oneline HEAD..upstream/main`.
  A quick look is cheap; there is no value in a faster cadence while upstream is
  quiet.
- **If upstream revives** — more than an occasional security commit — reassess.
  Until then, cherry-pick rather than merge: upstream's remaining commits are
  narrow security remediations, and cherry-picking keeps this fork's history
  legible.
- **Do not adopt upstream dependency commits blindly.** They target upstream's
  lockfiles. Take the intent (the floor being raised, and why), then re-resolve
  against this fork's lockfiles and re-run the audit.
- Fork-specific divergence — package identity, release plumbing, telemetry
  targets — is listed under "Open decisions" below and should not be reverted by
  a sync.

## CI on this fork

`ci.yml` and `test.yml` carry no repository-name gates and reference no secrets,
so they run unmodified on the fork. `npm run build` invokes
`scripts/upload-sentry-sourcemaps.mjs`, which no-ops cleanly unless *both*
`SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are set, so the build step needs no
credentials at all.

> Forks have GitHub Actions disabled by default. Enable them once under
> **Actions → "I understand my workflows, go ahead and enable them"**.

`publish.yml` is the exception. Its telemetry destinations are already opt-in
after `cc18f654`, but the npm trusted publisher and the Slack channel still need
attention before a release will work here. See below.

## Open decisions

These need a human call and are not resolved by this policy.

1. **npm trusted publisher.** `cc18f654` already scoped the package as
   `@angel-manuel/kanban`, so it can no longer collide with upstream's unscoped
   `kanban`. `publish.yml` still publishes via npm OIDC trusted publishing,
   which has to be registered for the new scoped package before a release will
   succeed. The alternatives are a classic `NODE_AUTH_TOKEN`, or dropping npm
   publish and keeping GitHub releases only.
2. **Slack release announcement.** The channel ID in `publish.yml` is still
   upstream's. The step is now skipped when `SLACK_RELEASE_BOT_TOKEN` is absent,
   so it no longer fails a fork release, but it will not announce anywhere until
   repointed.
3. **Deferred majors.** Several majors are available but are *not* required for
   security: `vite` 6 → 8, `undici` 6 → 8, `@hono/node-server` 1 → 2, `fast-uri`
   3 → 4, `nanoid` 3/5 → 6, `electron` beyond 41. Schedule these deliberately.

Package metadata and telemetry destinations are **not** open questions —
`cc18f654` repointed `name`/`repository`/`homepage`/`bugs`/`author` at this fork
and made every telemetry sink (Sentry, PostHog, Featurebase, OTEL) opt-in from
the environment, inert when unset. Do not re-point any of them at upstream's
accounts.
