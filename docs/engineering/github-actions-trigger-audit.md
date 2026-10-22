# GitHub Actions trigger audit — #2095

**Audit baseline:** `34b2d5674b08bd131173ef5210d69388c233e353` (2026-10-20). **Verified subsequent changes:** main PR 2097 and PR 2109; staging compatibility PR 2114 (merged as `0987fff9`); main E2E metadata fallback PR 2118 (merged as `65c604e1`). Exact trigger semantics remain owned by the checked-in workflows/scripts; this audit is a reviewed snapshot, not a competing policy engine.

## Invariants

- PR checks should run **only when their validated inputs change**. Source paths and job-level relevance are separate; `pull_request.paths` prevents workflow-run creation, while job conditions save heavy work only after a run exists.
- GitHub workflow files and access-boundary scripts require lightweight security/contract checks even without application changes. `workflow_run`, `issue_comment`, cron and manual runs do not have PR diff semantics.
- Do not filter `main`-push exact-SHA Quality/E2E/Cases if trusted postmerge consumers require every merge SHA. Preserve distinct verdicts for Pass / Fail / Not Applicable; no fabricated E2E Pass.
- For required checks, a filtered-out workflow can leave the check Pending indefinitely. Audit branch rules before enabling filters; when applicable retain a stable cheap context rather than a fake success.
- Workflow-run receiver/event fan-out, duplicate webhooks, and empty receiver runs are **#2031**; this issue resolves code-change applicability, not a second durable event coordinator.

## Complete workflow inventory (43 workflow files)

| Family | Workflow | Incoming events | Delivery/path scope | Required check context | Direct consumer / exception |
|---|---|---|---|---|---|
| Acceptance | `acceptance-agent-controller.yml` | manual | issue/SHA inputs | None configured for main/staging | Controller request artifact → Store controller ingest |
| Acceptance | `acceptance-case-ingest.yml` | workflow_run | Acceptance / Cases completed | None configured for main/staging | authenticated Case results projection |
| Acceptance | `acceptance-case-smoke.yml` | PR + manual | PR: code / E2E / Case inputs (#2097) | None configured for main/staging | pre-merge Case smoke, selected fixtures |
| Acceptance | `acceptance-cases.yml` | push + manual | staging/main pushes; exact SHA | None configured for main/staging | Case execution; Case Ingest consumes output |
| Acceptance | `acceptance-orchestrator.yml` | pull_request_target + dispatch + workflow_run + issues.closed + push | Quality/E2E workflow_run excludes main | None configured for main/staging | authenticated SC coordination; event fan-out delegated to #2031 |
| Acceptance | `acceptance-postrun-waker.yml` | workflow_run | main completed Orchestrator/fixture/E2E/Pages | None configured for main/staging | postmerge evidence waker; #2031 event fan-out |
| Acceptance | `acceptance-quota-recovery.yml` | schedule + manual + workflow_run | 15-min cron; main Quality completed | None configured for main/staging | delayed retry; #2031 durable wake replacement prerequisite |
| Acceptance | `acceptance-verified-stage.yml` | issue_comment | all comment creations; job-level authority | None configured for main/staging | trusted owner stage approval; #2031 event fan-out |
| Agent | `agent-claude-resume-seed.yml` | manual + push | main: own seed/verify workflows | None configured for main/staging | controlled provider resume fixture |
| Agent | `agent-claude-resume-verify.yml` | workflow_run | Claude Resume Seed completed | None configured for main/staging | trusted verifier |
| Agent | `agent-controller-dispatch.yml` | issue_comment + manual | all comments; job-level exact owner/main command | None configured for main/staging | privileged Controller; cannot use file-path filter for comment event |
| Agent | `agent-cursor-resume-seed.yml` | manual + push | main: own seed/verify workflows | None configured for main/staging | controlled provider resume fixture |
| Agent | `agent-cursor-resume-verify.yml` | workflow_run | Cursor Resume Seed completed | None configured for main/staging | trusted verifier |
| Agent | `agent-develop.yml` | manual | authenticated action inputs | None configured for main/staging | Developer worker |
| Agent | `agent-issue-audit.yml` | issues + manual | opened/edited/reopened | None configured for main/staging | issue contract audit |
| Agent | `agent-provider-smoke.yml` | manual + push | main selected provider/ingest scripts | None configured for main/staging | provider smoke / telemetry evidence |
| Agent | `agent-sc-acceptance.yml` | manual + reusable call | explicit source/SC/stage | None configured for main/staging | per-SC Acceptance Agent |
| CI | `ci-pages.yml` | PR | pages + Pages browser inputs | None configured for main/staging | Pages quality |
| CI | `ci-quality.yml` | PR + push | PR: relevant code/workflow paths + scope jobs; main: full exact SHA | staging: `rust-check`, `web-check` (enforced); main: none | Rust/Web checks; postmerge Quality consumers |
| CI | `ci-run-store-fixture-evidence.yml` | push + repository_dispatch | all main pushes or explicit request | None configured for main/staging | postmerge Run Store fixture evidence |
| CI | `ci-run-store-integrity-audit.yml` | repository_dispatch + schedule | daily / explicit trusted request | None configured for main/staging | Store integrity audit |
| CI | `ci-web-dist-reuse-proof.yml` | workflow_run | Quality completed | None configured for main/staging | Web dist evidence consumer; may create skipped runs (#2031) |
| Deploy | `deploy-manual.yml` | manual | environment and SHA inputs | None configured for main/staging | explicit deployment |
| Deploy | `deploy-pages.yml` | push + schedule + manual | main Pages and registry path filter; 4-hour cron | None configured for main/staging | public Pages publication |
| E2E | `e2e-scenario-ingest.yml` | workflow_run | Scenario Smoke completed | None configured for main/staging | authenticated terminal Scenario ingestion |
| E2E | `e2e-scenario-smoke.yml` | PR + push + manual | main: scoped PR/main push paths (PR 2109); staging: scoped PR paths (PR 2114) | None configured for main/staging | terminal repeated replay, authenticated Ingest |
| E2E | `e2e-test-ingest.yml` | workflow_run | E2E / Tests completed | None configured for main/staging | exact-SHA E2E evidence ingest |
| E2E | `e2e-tests.yml` | PR + push + manual | PR: runtime/E2E inputs (#2097); main/staging push unchanged | None configured for main/staging | browser E2E; main exact-SHA Store/Ingest |
| Metrics | `metrics-agent-telemetry.yml` | workflow_run + schedule | Agent/Acceptance completion; 5-min recovery | None configured for main/staging | telemetry ingestion; #2031 broad fan-out |
| Metrics | `metrics-replay-request.yml` | manual | explicit replay input | None configured for main/staging | Replay source |
| Metrics | `metrics-repository.yml` | workflow_run + schedule | Replay Request; 4-hour schedule | None configured for main/staging | repository metrics |
| Release | `release-production.yml` | push | main all; version gate at job | None configured for main/staging | versioned release (conservative trigger) |
| Release | `release-staging.yml` | push + manual | staging with docs/.github path-ignore | None configured for main/staging | staging artifact build/deploy |
| Store | `store-agent-bootstrap.yml` | push | main: only bootstrap workflow | None configured for main/staging | trusted Agent Store fixture |
| Store | `store-agent-controller-ingest.yml` | workflow_run | Agent Controller completed | None configured for main/staging | trusted controller ingest |
| Store | `store-agent-development-ingest.yml` | workflow_run + issue_comment | Developer completed; comments with job guard | None configured for main/staging | Worker result ingest/recovery |
| Store | `store-agent-dispatch-reconcile.yml` | workflow_run | Agent Development completed on main | None configured for main/staging | dispatch reconciliation |
| Store | `store-app-writer-smoke.yml` | push | main: selected ingest/workflow/inventory inputs | None configured for main/staging | writer credential/contract smoke |
| Store | `store-five-mode-readback.yml` | push + repository_dispatch | all main pushes or trusted request | None configured for main/staging | Run Store readback evidence |
| Store | `store-governance-audit.yml` | push + manual + schedule | selected Store files; daily audit | None configured for main/staging | Store governance |
| Store | `store-receipt-readback.yml` | workflow_run + repository_dispatch | six Ingest/Metrics producers or trusted request | None configured for main/staging | authenticated receipt readback; broad event fan-out (#2031) |
| Task | `task-result-ingest.yml` | workflow_run | Task Runner completed | None configured for main/staging | Task result ingestion |
| Task | `task-runner.yml` | push + manual | task/** push changing .task/** | None configured for main/staging | ephemeral task execution |

**Interpretation:** "all main pushes" entries above represent deliberately retained triggers or candidates for a later consumer-by-consumer audit, *not* evidence that each one creates expensive jobs. Job guards can skip after GitHub creates an Actions Run. Schedules are event sources, not code-change triggers.

## Confirmed defects and changes

1. **Unfiltered expensive PR workflows — fixed in [#2097](https://github.com/BestNathan/nession/pull/2097).** `CI / Quality Gate` now selects Rust, Web and lightweight workflow/security jobs; `E2E / Tests` and `Acceptance / Case Smoke` use native `pull_request.paths` while preserving main-push exact SHA evidence.
2. **Unfiltered staging PR terminal replay — fixed on main in PR 2109 and explicitly ported to staging in PR 2114.** `e2e-scenario-smoke.yml` previously ran two full Scenario replays for all staging PRs. Both deployed definitions use native path filters for relevant terminal/Scenario/runtime changes, correcting stale `agent/src/**` and `server/src/**` path references to the real crate roots.
3. **Unrelated event receiver Runs — tracked in [#2031](https://github.com/BestNathan/nession/issues/2031)** (Orchestrator, Post-Run Waker, Quota Recovery, Store Readback, Metrics). A sample of [#2099](https://github.com/BestNathan/nession/pull/2099) produced one successful Quality PR Run and one skipped `pull_request_target` Orchestrator Run; only the former is a change-driven Quality run.
4. **Exact-SHA postmerge requirement:** #2097 merged as `34b2d567`. [E2E #39453506889](https://github.com/BestNathan/nession/actions/runs/39453506889), Cases #39453506897, and E2E Test Ingest #39453803251 succeeded. [Quality #39453506977](https://github.com/BestNathan/nession/actions/runs/39453506977) initially failed in Rust integration timing (`missing ready`) and requires verified same-SHA retry before SC-07 can be accepted.

## Real before/after path proofs

| Change | PR / exact head | Quality Rust | Quality Web | E2E / Tests | Acceptance Case Smoke |
|---|---|---|---|---|---|
| Controller workflow only (pre-fix) | [#2087](https://github.com/BestNathan/nession/pull/2087), `a3d9987` | Executed | Executed | Full run #39444999306 | Ran #39444999270 |
| Controller workflow only (post-fix) | [#2099](https://github.com/BestNathan/nession/pull/2099), `15a664c` | Skipped | Skipped | Not created | Not created |
| Rust tool config only | [PR 2104](https://github.com/BestNathan/nession/pull/2104), `318321b` | Success ([39456061413](https://github.com/BestNathan/nession/actions/runs/39456061413)) | Skipped | Not created | Not created |
| Web runtime input only | [PR 2105](https://github.com/BestNathan/nession/pull/2105), `af694cc` | Skipped | Success ([39456135453](https://github.com/BestNathan/nession/actions/runs/39456135453)) | Success ([39456135485](https://github.com/BestNathan/nession/actions/runs/39456135485)) | Success ([39456135431](https://github.com/BestNathan/nession/actions/runs/39456135431)) |
| Canonical Case verifier only | [PR 2107](https://github.com/BestNathan/nession/pull/2107), `c2f2df3` | Skipped | Success ([39456254363](https://github.com/BestNathan/nession/actions/runs/39456254363)) | Success ([39456254155](https://github.com/BestNathan/nession/actions/runs/39456254155)) | Success ([39456254546](https://github.com/BestNathan/nession/actions/runs/39456254546)) |

All four controlled main-side path probes were closed **unmerged** after their exact-head Actions results were read. Every statement above is bound to an observed job conclusion or explicit absence of a PR workflow run, not merely a guessed route.

## Branch rules and reliability

At the audit snapshot, `branches/main` metadata returned no enforced required check contexts, and the named `main` ruleset was disabled. GitHub App access to `branches/main/protection` returned HTTP 403; do not claim independent verification of inaccessible admin policy. Existing Run Store App-only ruleset remains active. No required-check configuration is changed by this issue.

Coverage of input globs is necessarily conservative; if a new shared runtime/build input appears outside the paths allowlist, update the owning workflow and corresponding regression proof. Avoid centralizing trigger globs in another router.

**Related:** [#2095](https://github.com/BestNathan/nession/issues/2095), [#2031](https://github.com/BestNathan/nession/issues/2031), [#1876](https://github.com/BestNathan/nession/issues/1876), [#1690](https://github.com/BestNathan/nession/issues/1690), [#1702](https://github.com/BestNathan/nession/issues/1702).

## Staging required-check compatibility and live negative probe

Staging branch protection enforces `rust-check` and `web-check` (GitHub Actions app ID 15368), even when the PR changes only docs. Hence the main-only job-level skip mechanism is **not copied verbatim**: staging Quality keeps both required job contexts and only omits heavy steps with explicit `Not Applicable` logs when its trusted exact-PR diff classifier finds no Rust/Web inputs.

- [PR 2114](https://github.com/BestNathan/nession/pull/2114) was merged to staging as `0987fff9caf38e04ee22096cff541a3b834f21c8`. Exact-head Quality [39459082791](https://github.com/BestNathan/nession/actions/runs/39459082791), E2E [39459082759](https://github.com/BestNathan/nession/actions/runs/39459082759), Case Smoke [39459082927](https://github.com/BestNathan/nession/actions/runs/39459082927), Scenario Smoke [39459082718](https://github.com/BestNathan/nession/actions/runs/39459082718) all passed.
- **Before**: unrelated docs-only staging [PR 2111](https://github.com/BestNathan/nession/pull/2111) created Quality, E2E, Case Smoke and Scenario Smoke PR Runs under the old staging YAML.
- **After**: unmerged docs-only staging [PR 2117](https://github.com/BestNathan/nession/pull/2117) created **only** Quality [39460348578](https://github.com/BestNathan/nession/actions/runs/39460348578), with `scope` success; required `rust-check` and `web-check` success only via their explicit Not Applicable steps; no Rust/Web builds. A separately triggered `Acceptance / Orchestrator` `pull_request_target` Run was skipped (event fan-out scope #2031).
- Staging-specific compatibility is a targeted backport because workflow definitions are evaluated from the PR base branch and `staging` has diverged substantially from `main`; merging the entire main history into staging was neither required nor attempted.

## Legacy E2E planner fail-closed correction

[PR 2118](https://github.com/BestNathan/nession/pull/2118) updates the trusted `scripts/issue-e2e-selection-entry.mjs`: when Issue E2E metadata is missing, an **exact-head Git diff** must positively prove that all changed paths are unrelated Markdown/Workflow metadata before returning `not-required`. Runtime code, changed E2E/Case workflows, unknown paths, an unavailable base, an incorrect checkout and a runtime-to-docs rename all preserve the full fallback. `ci-quality.yml` YAML-only edits no longer start PR E2E by themselves. The `issue-e2e-plan-selftest` Gate owns this invariant with real Git-history positive/negative fixtures. Main `push` exact-SHA full E2E/Store ingestion triggers are unchanged.

The event-receiver fan-out across `workflow_run` / `issue_comment` and scheduled recovery remains in [Issue 2031](https://github.com/BestNathan/nession/issues/2031), without a competing CI router.

## Before/after workflow creation — exact-head controlled probes

This is a measured **Actions Run-count and heavy-Job avoidance** comparison, not a fabricated billing-minutes total. GitHub's authenticated billable Runner-minutes endpoint was not available to this audit; wall time, billable minutes and artifact download times are not interchangeable. It is still directly verified that no costly Rust/Web/Playwright jobs started in the after-case.

| PR / changed path | Quality Run | Rust/Web heavy jobs | E2E Run | Case Smoke Run | Scenario Smoke Run | Total change-driven validation Runs |
|---|---|---|---|---|---|---|
| [Before PR 2087](https://github.com/BestNathan/nession/pull/2087), Controller Workflow single-line | [39444999181](https://github.com/BestNathan/nession/actions/runs/39444999181) | 2 executed | [39444999306](https://github.com/BestNathan/nession/actions/runs/39444999306), full | [39444999270](https://github.com/BestNathan/nession/actions/runs/39444999270) | N/A (main PR target) | **3** |
| [After PR 2099](https://github.com/BestNathan/nession/pull/2099), Controller Workflow comment-only | [39453616699](https://github.com/BestNathan/nession/actions/runs/39453616699) | 0; both skipped | **Not created** | **Not created** | N/A | **1 light Run** |
| [Before staging PR 2111](https://github.com/BestNathan/nession/pull/2111), docs-only | Created (legacy) | 2 executed by unfiltered Quality | Created | Created | Created | **4** |
| [After staging PR 2117](https://github.com/BestNathan/nession/pull/2117), docs-only | [39460348578](https://github.com/BestNathan/nession/actions/runs/39460348578) | 0; required contexts success with explicit Not Applicable steps | **Not created** | **Not created** | **Not created** | **1 light Run** |

The separate `Acceptance / Orchestrator` `pull_request_target` skipped receiver is outside this count and owned by Issue 2031, not represented as a heavy CI run. The negative probes were closed unmerged. The corresponding positive controls—Rust-only [PR 2104](https://github.com/BestNathan/nession/pull/2104), Web-only [PR 2105](https://github.com/BestNathan/nession/pull/2105), Case-only [PR 2107](https://github.com/BestNathan/nession/pull/2107)—ran their applicable suites to completion. `ci-trigger-scope-selftest`, an executable Quality tooling Gate, adds real Git-diff change-path fixtures to prevent regressions in these categories.

## Required-check evidence provenance

The required-check column applies to the observed branch settings: `main` reports enforcement `off` with no contexts; `staging` reports `enforcement_level=everyone` with `rust-check` and `web-check` (GitHub Actions app ID 15368). The main ruleset was disabled at the audit snapshot. The selected job names and actual `Not Applicable` receipt are linked above. These facts must be rechecked if repository branch protection changes.
