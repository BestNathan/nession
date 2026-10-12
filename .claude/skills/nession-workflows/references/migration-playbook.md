# Workflow naming and migration playbook (Issue #1649)

> **Target mapping, not a live rename.** Re-inventory `.github/workflows/` from the current `main` before starting. Existing GitHub Action names/paths are contract surfaces, not cosmetic strings. The inventory below reflects the repository at design time (2026-10-12).

## Suggested catalog

| Current file | Target file | Target Actions name | Notes |
|---|---|---|---|
| `agent-sc-acceptance.yml` | **Migrated** | `Agent / SC Acceptance` | Model-execution entrypoint; deterministic compatibility bypass and trusted updater still require future separation |
| `agent-issue-audit.yml` | **Done** | `Agent / Issue Audit` | Actually invokes LLM; renamed with Metrics subscription and telemetry source |
| `agent-provider-smoke.yml` | unchanged | `Agent / Provider Smoke` | Actually invokes LLM |
| `requirement-acceptance.yml` | `acceptance-orchestrator.yml` | `Acceptance / Orchestrator` | Handles dispatch, PR gate and Issue-close guard; must not be misnamed as an Agent |
| `acceptance-cases.yml` | unchanged | `Acceptance / Cases` | Source-aligned Case execution using shared E2E Runner |
| `acceptance-case-ingest.yml` | unchanged initially | `Acceptance / Case Ingest` | Trusted append-only record + authorized projection |
| `acceptance-case-smoke.yml` | retire when replaced | `Acceptance / Case Smoke` (transitional) | #1474 hard-coded smoke; remove only after generic PR Case selector covers it |
| `e2e.yml` | `e2e-tests.yml` | `E2E / Tests` | Regression E2E; exact SHA and playwright outcomes |
| `e2e-scenario-smoke.yml` | unchanged | `E2E / Scenario Smoke` | Reproduction/observations |
| `e2e-run-ingest.yml` | `e2e-scenario-ingest.yml` | `E2E / Scenario Ingest` | Verify actual source, preserve non-evaluative runs |
| `e2e-test-run-ingest.yml` | `e2e-test-ingest.yml` | `E2E / Test Ingest` | Trusted test Run Records |
| `quality.yml` | `ci-quality.yml` | `CI / Quality Gate` | Verify required check renaming semantics before cutover |
| `metrics-ingest.yml` | `metrics-agent-telemetry.yml` | `Metrics / Agent Telemetry Ingest` | Metrics owns tokens/cost/usage; is **not** an Agent executor |
| `repo-metrics.yml` | `metrics-repository.yml` | `Metrics / Repository Health` | Collect repository health indicators |
| `staging.yml` | `release-staging.yml` | `Release / Staging Artifacts` | This workflow builds/publishes staging artifacts; don't call deployment proof |
| `release.yml` | `release-production.yml` | `Release / Production` | Version-triggered release, image publication and approval/rollout |
| `deploy.yml` | unchanged | `Deploy / Manual` | Actual manual deployment |
| `task-runner.yml` | unchanged | `Task / Ephemeral Runner` | Generic task execution, not automatically LLM Agent |
| `task-result-ingest.yml` | unchanged | `Task / Result Ingest` | Trusted Task result write boundary |
| historical Bug Acceptance Replay | **Retired** | Not an active workflow | #1522, #1523, #1527 closed with fully checked SCs and exact run evidence retained on their Issues; Git history preserves the original one-time workflow |

**Classification is determined by actual job execution**, never by a textual search for `agent`, `nession-agent`, or `metrics`. The catalog is a proposed migration target, not a mandate to rename every file in one PR.

## Critical dependency graph

Examples from the current repository:

```text
requirement-acceptance.yml
  -- reusable uses path --> acceptance.yml
  -- canonical metrics source --> metrics-ingest.yml

acceptance-cases.yml ("Acceptance Cases")
  -- workflow_run display name --> acceptance-case-ingest.yml

e2e.yml ("E2E Tests")
  -- workflow_run display name --> e2e-test-run-ingest.yml

e2e-scenario-smoke.yml ("E2E Scenario Smoke")
  -- workflow_run display name --> e2e-run-ingest.yml

acceptance.yml, requirement-acceptance.yml, agent-issue-audit.yml,
agent-provider-smoke.yml
  -- workflow_run display names --> metrics-ingest.yml
  -- telemetry path & stable workflow_id --> scripts/agent-workflow-telemetry-contract.mjs

all required PR checks
  -- exact displayed check / job identity --> branch protection or rulesets
```

Also search:

- `gh workflow run <filename>`, `gh run list --workflow <name>`, `gh workflow view`, and GitHub REST paths.
- `workflow_run.workflows`, `uses: ./.github/workflows/*.yml`, artifact download names and query patterns.
- Script allowlists that match `workflow_run.path`, display name, event, head SHA and branch.
- `NSESSION_AGENT_WORKFLOW_ID` logical identity, `agent-telemetry-*` artifacts, `metrics` orphan storage paths, status/check contexts.
- Requirement Issue/SC source association, Case manifests, historical source-run links, manual runbooks and Skills/docs.
- Concurrency group keys, cancellation behavior, environment/secret authorization, `pull_request_target` trust boundaries.

Do not assume the name shown in GitHub Actions is the YAML filename. Renaming a display name can silently disconnect a downstream workflow_run subscriber. Renaming a path can invalidate a trusted provenance allowlist, a reusable `uses` reference, and manual `gh workflow run` commands.

## Safe sequence

1. **Snapshot current state.** Record current main SHA, all workflow paths/names/events/jobs, subscribers, data identities, required status checks and latest successful baseline runs.
2. **Establish ownership and compatibility policy.** Classify 100% of workflows (six main families plus Task), locate split-required mixed responsibilities. Confirm the current source of truth for the Action/check identity.
3. **Add deterministic tests before renaming.** Planned `workflow-conventions` Gate should parse current YAML and assert consistent file/name domain, direct LLM invocation -> Agent telemetry, event subscriptions, known reusable paths and allowlist alignment. Test negative cases. Gate must not rely on naive Agent substring heuristics.
4. **Refactor logic before changing labels.** Split optional Agent invocation away from deterministic Acceptance evaluation and Issue projection. Keep existing execution behavior through a parity window.
5. **Migrate consumers and producers compatibly.** Update `workflow_run.workflows`, reusable paths, `gh` dispatch commands, artifact consumers, trusted provenance paths, documentation and any required checks. Use an explicit short transition window if both old and new names must coexist; prevent double ingestion/writes.
6. **Cut over in small atomic cohorts.** Validate both normal and failed runs on real GitHub Actions, exact head SHA, source run attempts and ingest/projection. Do not assert success merely because GitHub accepted YAML.
7. **Retire old names and one-offs.** Confirm compatibility window ended, historical artifacts/links accessible, and no required check or consumer points to the retired identity.
8. **Update all owning Skills.** Mark the target syntax active only after the executable Issue/SC parser, runner and Gate support it.

### Test matrix for each cohort

| Test | Failure that must be caught |
|---|---|
| Static workflow graph | Dangling workflow_run display names or reusable workflow path |
| Named required checks | Renamed check silently stops blocking merge |
| Agent telemetry | New Agent execution has no artifact / source rejected / stable ID altered |
| Metrics ingest | Valid source run does not append to metrics orphan branch |
| Acceptance read-only path | PR-head executor gains write permission or access to secrets |
| Acceptance Issue projector | Cross-SHA/stale/forged result updates SC |
| E2E Case selection | Agent-only SC incorrectly requires a Case, or missing Case passes |
| Scenario/Test ingestion | Unsupported source event/head/ref silently accepted or dropped |
| Retired one-off workflows | Real replacement cannot reproduce required Case proof |
| Deployment proof | Main source SHA mistaken for actual production artifact digest |

## PR / merge policy

- Workflow-file changes are a standalone PR directly against **main**, using latest-main worktree and a **merge commit**, as required by `nession-cicd` and `.github/AGENTS.md`.
- Docs/Skill-only architectural preparation can be delivered before runtime changes; it must not claim future behavior is already active.
- Do not use a giant rename PR that combines security-sensitive `pull_request_target`, ingestion, and release rewrites without verifiable migration gates.
- For partial PRs supporting #1649, do **not** write an issue-closing or implementation reference that causes the Requirement gate to demand all future SCs immediately. Link the design issue in non-implementing narrative/context and describe the subset actually delivered.

Existing stable owners: `nession-cicd` for delivery, `nession-acceptance` for current Acceptance execution, `nession-agent-workflow-metrics` for telemetry, `nession-gates` for Gate semantics. This playbook owns only their cross-workflow coordination.
