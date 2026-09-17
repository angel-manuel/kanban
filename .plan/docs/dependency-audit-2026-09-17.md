# Dependency audit snapshot — 2026-09-17

Baseline audit taken when this fork took over dependency maintenance from
`cline/kanban`. Policy lives in [`docs/dependency-policy.md`](../../docs/dependency-policy.md).

Tooling: npm 11.11.1, Node 25.8.2. No versions were bumped as part of producing
this snapshot — the remediation below was verified against throwaway copies of
the manifests in a scratch directory, and the repo's lockfiles are untouched.

## Totals

| Project | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Runtime (`/`) | 0 | 3 | 20 | 11 | 34 |
| Web UI (`/web-ui`) | 0 | 3 | 10 | 0 | 13 |
| Desktop (`/packages/desktop`) | 0 | 0 | 0 | 0 | 0 |

Every finding has a fix available within the current major version. Nothing in
this snapshot requires a breaking upgrade.

## High severity

| Package | Project | Resolved | Advisory | Fixed in |
| --- | --- | --- | --- | --- |
| `fast-uri` | runtime | 3.1.5 | SSRF + host confusion, 4 advisories (`GHSA-f65p-4m7j-42xc`, `GHSA-jqff-g426-hqxp`, `GHSA-5jgf-p345-68v8`, `GHSA-fph4-wmhf-6fwf`) | 3.1.6 |
| `brace-expansion` | runtime | 5.0.5 | DoS, 4 advisories (`GHSA-rgw5-rvv9-x895`, `GHSA-mh99-v99m-4gvg`, `GHSA-3jxr-9vmj-r5cp`) | 5.0.9 |
| `ip-address` | runtime | 10.1.0 | Octal/decimal octet confusion → SSRF (`GHSA-mwp4-54f8-5fhr`) | >10.3.0 |
| `vite` | web-ui | 6.4.2 | `server.fs.deny` bypass on Windows (`GHSA-fx2h-pf6j-xcff`) | 6.4.3 |
| `js-cookie` | web-ui | ≤3.0.5 | Prototype hijack → cookie-attribute injection (`GHSA-qjx8-664m-686j`) | 3.0.8 |
| `react-use` | web-ui | 17.6.0 | Depends on vulnerable `js-cookie` | 17.6.1 |

`vite` is a dev/build dependency; the advisory is Windows-specific and this repo
builds on Linux and macOS in CI. `fast-uri` and `ip-address` sit under the
runtime's HTTP path and matter more.

## Moderate and low, by cluster

- **OpenTelemetry chain (12 moderate, both runtime and web-ui).** All trace back
  to `@opentelemetry/core` <2.8.0 (`GHSA-8988-4f7v-96qf`, unbounded memory
  allocation in W3C Baggage propagation), reached via `@clinebot/core`,
  `@sentry/node`, and `posthog-js`. One override fixes the whole cluster.
- **`@ai-sdk/*` (11 low, runtime).** All trace to `@ai-sdk/provider-utils`
  (`GHSA-866g-f22w-33x8`, uncontrolled resource consumption), pulled in through
  `@clinebot/*`.
- **Hono (2 moderate, runtime).** `hono` ≤4.13.4 and `@hono/node-server` ≤1.19.14
  — `serveStatic` middleware bypass and path traversal. Both are held below the
  fix by this repo's own override floors; see stale pins.
- **Express/qs chain (runtime).** `qs`, `body-parser`, `express-rate-limit` —
  all DoS-class, all fixed by a plain lockfile refresh.
- **`@anthropic-ai/sdk` (moderate, runtime).** `GHSA-p7fg-763f-g4gf`, insecure
  default file permissions in the local filesystem memory tool. Reached via
  `@anthropic-ai/claude-agent-sdk`.
- **`fflate` (moderate, web-ui).** Infinite loop on malformed ZIP64, via
  `posthog-js`.

## Stale pins we are carrying ourselves

The pattern `abd4912c` called "our own stale pin": an override floor written as
`">=X <Y"` is satisfied by the already-locked `X`, so the lockfile never moves
and the override holds the vulnerable version in place.

| Override | Declared floor | Resolved | Problem |
| --- | --- | --- | --- |
| `fast-uri` (root) | `>=3.1.5 <4` | 3.1.5 | **Floor is below the fix (3.1.6).** Actively holding a high-severity version. |
| `hono` (root) | `>=4.12.34 <5` | 4.12.34 | **Floor is below the fix (4.13.5).** |
| `@hono/node-server` (root) | `>=1.14.0` | 1.19.11 | Floor is ~6 minors stale, and **unbounded** — a lockfile refresh could cross into 2.x unannounced. |
| `nanoid@<4` | root `>=3.3.18`, web-ui `>=3.3.17`, desktop `>=3.3.17` | 3.3.18 everywhere | Floors disagree across manifests. `abd4912c` raised the root floor and left the other two behind. Not currently exploitable. |
| `js-yaml` (root) | `>=4.3.1 <5` | not installed | Dead override — `js-yaml` is not in the root tree at all. |
| `dompurify` (web-ui) | `>=3.4.13 <4` | 3.4.13 | Floor equals lock; 3.4.15 exists. Not vulnerable today, but will not move on its own. |
| `simple-git` (root) | `>=3.36.0` | 3.36.0 | Equals current latest. Fine today; unbounded floor. |
| `undici` | desktop overrides it, **root does not** | root nests `undici` ≤6.27.0 under `dify-ai-provider` | Missing override at root leaves a high-severity nested copy. |

## Verified remediation path

Both projects can be brought to zero findings without a single major bump. This
was confirmed against scratch copies; **it has not been applied.**

**Web UI — no manifest change needed.** A lockfile refresh alone clears all 13
findings (`vite` 6.4.2 → 6.4.3, `js-cookie` → 3.0.8, `react-use` → 17.6.1):

```bash
npm --prefix web-ui audit fix
```

**Runtime — refresh plus six override corrections.** `npm audit fix` alone takes
34 → 13; the remaining 13 are the OTel chain and the nested `undici`, both held
by missing or stale overrides. With these corrections applied, the runtime
audits clean:

```jsonc
"overrides": {
  "fast-uri": ">=3.1.6 <4",            // was >=3.1.5 <4
  "hono": ">=4.13.5 <5",               // was >=4.12.34 <5
  "@hono/node-server": ">=1.19.15 <2",  // was >=1.14.0, now bounded
  "undici": "$undici",                  // new; npm rejects a literal range here
  "@opentelemetry/core": ">=2.8.0 <3",  // new; clears the whole OTel cluster
  "@ai-sdk/provider-utils": ">=3.0.28 <4" // new; clears the @ai-sdk lows
}
```

`undici` must be spelled `"$undici"` rather than a version range — npm rejects an
override on a package that is also a direct dependency with
`EOVERRIDE: Override for undici@^6.27.0 conflicts with direct dependency`.

The resulting resolution changes 46 packages, **all within their current major**.
Notable: `@opentelemetry/core` 2.6.1 → 2.11.0 (and the four duplicated copies
collapse to one), `@sentry/node` 10.45.0 → 10.75.0, `fast-uri` 3.1.5 → 3.1.8,
`hono` 4.12.34 → 4.13.8, `@anthropic-ai/sdk` 0.81.0 → 0.93.0, `ip-address`
10.1.0 → 10.7.2, and `brace-expansion` drops out of the tree entirely.

`@clinebot/*` stays at 0.0.38 throughout — the OTel cluster is resolved by the
override, not by moving the SDK.

## Traps

- **`npm audit fix --force` will downgrade the core SDK.** npm proposes
  `@clinebot/core` 0.0.38 → 0.0.28, and after a refresh → 0.0.5. 0.0.38 is the
  latest published version; these are not fixes. Never run `--force` here.
- **`npm audit fix --dry-run --json` under-reports.** It returned
  `added 0 / removed 0 / changed 0` with unchanged vulnerability counts, while
  the identical command without `--dry-run` on a scratch copy cleared the tree
  completely. Verify on a copy rather than trusting the dry run.
- `npm audit` resolves from the lockfile alone and needs no `node_modules`,
  which is what lets the audit workflow skip installing.

## Follow-up

1. Land the remediation above as its own PR, runtime and web-ui separately.
2. Until it lands, `.github/workflows/audit.yml` will fail — it fails on high
   severity and there are currently 3 + 3.
3. Align the `nanoid@<4` floors and drop the dead root `js-yaml` override.
4. Schedule the deferred majors listed in the policy's "Open decisions".
