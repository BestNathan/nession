# Workflow catalog and safe migration playbook

The **executable current-state authority** is scripts/workflow-conventions.mjs (CATALOG), together with the actual .github/workflows directory. This page describes the implemented taxonomy from Issue #1649 and the rules for future changes. Do not use an old filename from a historical run as a current dispatch path.

## Current canonical workflow ownership

| Owner | Workflow file | GitHub Actions display name | Responsibility |
|---|---|---|---|
| Agent | agent-sc-acceptance.yml | Agent / SC Acceptance | Model-backed, read-only per-SC evaluation and telemetry |
| Agent | agent-issue-audit.yml | Agent / Issue Audit | Model-backed Issue auditing |
| Agent | agent-provider-smoke.yml | Agent / Provider Smoke | Model provider smoke |
| Acceptance | acceptance-orchestrator.yml | Acceptance / Orchestrator | PR/merged-SHA/Issue-close routing and deterministic Gate; telemetry ID remains requirement-acceptance |
| Acceptance | acceptance-cases.yml | Acceptance / Cases | Source-aligned per-SC Case execution at exact SHA |
| Acceptance | acceptance-case-ingest.yml | Acceptance / Case Ingest | Trusted Case Run Record authentication and Issue projection |
| Acceptance | acceptance-case-smoke.yml | Acceptance / Case Smoke | Generic source-aligned PR Case execution |
| E2E | e2e-tests.yml | E2E / Tests | Regression at exact source SHA |
| E2E | e2e-scenario-smoke.yml | E2E / Scenario Smoke | Reproducible Scenario observations |
| E2E | e2e-scenario-ingest.yml | E2E / Scenario Ingest | Trusted Scenario Run Records |
| E2E | e2e-test-ingest.yml | E2E / Test Ingest | Trusted Test Run Records |
| CI | ci-quality.yml | CI / Quality Gate | Deterministic Rust/Web/tooling checks |
| Metrics | metrics-agent-telemetry.yml | Metrics / Agent Telemetry Ingest | Agent token/cost/turn/tool/skill telemetry |
| Metrics | metrics-repository.yml | Metrics / Repository Health | Repository health metrics |
| Release | release-staging.yml | Release / Staging Artifacts | Staging builds and artifacts, not deployment proof |
| Release | release-production.yml | Release / Production | Production release/version/artifact workflow |
| Deploy | deploy-manual.yml | Deploy / Manual | Manual GitOps deployment |
| Task | task-runner.yml | Task / Ephemeral Runner | Ephemeral Task execution, not automatically LLM |
| Task | task-result-ingest.yml | Task / Result Ingest | Trusted Task result ingestion |

There are **19 active workflows** across six main domains and the separately owned Task domain. The historical hard-coded Bug Acceptance Replay for #1522/#1523/#1527 was retired after their SCs and historical immutable evidence were validated. The original Case Smoke tied to #1474 was replaced with generic source-aligned representative Case selection; the canonical Smoke workflow filename remains unchanged.

## Real trusted dependency graph

- Acceptance / Orchestrator selects and routes PR, staging/main merged-SHA and Issue-close obligations. It calls main-owned Agent / SC Acceptance for declared Agent-method SCs. Acceptance / Cases provides separate executable Case evidence, followed by trusted Acceptance / Case Ingest.
- CI / Quality Gate and E2E / Tests must be checked at exact PR-head SHA before pre-merge approval; their file paths are ci-quality.yml and e2e-tests.yml.
- E2E / Tests triggers E2E / Test Ingest by display name. E2E / Scenario Smoke triggers E2E / Scenario Ingest. Task / Ephemeral Runner triggers Task / Result Ingest.
- Actual LLM Agent invocations and orchestrator runs are subscribed by Metrics / Agent Telemetry Ingest. Only a run that produced real model-call telemetry creates usage data. A no-model orchestrator run must not synthesize token/turn records.
- Untrusted Case/PR-head code cannot hold Issue-write authority. The main-owned trusted evaluator/projector authenticates exact source run/attempt, target SHA, method and immutable SC contract digest.

The current Issue grammar supports optional Acceptance Plan with when = pr / merged / deployed, method = agent / case, and mandatory explicit staging/main branch for merged conditions. Legacy Acceptance Report stages remain required. **Actual production deployed execution is not implemented**: it will need independently authenticated environment, revision/digest and authorization. A main merge is not a production deployment.

## Names, paths and identity are distinct contracts

- workflow_run.workflows subscribes using the **display name**, so rename producers and subscribers atomically.
- Reusable workflow uses paths, gh workflow run paths, gh run list --workflow file paths, and trusted ingestion allowlists are **file-path contracts**, not display names.
- For exact-SHA PR check consumers, keep ci-quality.yml and e2e-tests.yml, while preserving job/check identities such as rust-check, web-check and e2e. Check live PR-head outcomes and required-check settings when changing a display name.
- Canonical NSESSION_AGENT_WORKFLOW_ID is a stable **logical identity**. The identifiers requirement-acceptance and issue-audit remain unchanged despite workflow naming changes. Preserve agent-telemetry artifacts and immutable metrics orphan storage.
- Evidence and Run Records identify actual run id, attempt, target SHA, Issue/SC digest and artifact digest. Historic records retain their historic workflow names.
- scripts/gate-consumer-parity.mjs resolves workflow paths from workflow-conventions.mjs CATALOG; the CI/CD Skill's Current workflow owners section is also validated by workflow-conventions. Never introduce a second active name/path catalog.

## Migration discipline

1. Inventory current main workflow paths, top-level names, triggers, subscribed display names, reusable workflow references, artifact identifiers, exact-SHA CLI consumers and trusted source allowlists.
2. Identify **direct responsibility**, never infer Agent just from use of the nession-agent binary or from collected model results. Metrics, Acceptance, E2E, CI, Delivery and Task remain separate owners.
3. Extend workflow-conventions and gate-consumer-parity with positive and negative fixtures first. Never bypass them to force a rename.
4. Change producer, subscriber, manual dispatch, trusted provenance, Skills and required-check consumers in one verified transition; reject missing or duplicate identities.
5. Submit an isolated workflow-only PR to main and run CI / Quality Gate, E2E / Tests, Acceptance / Case Smoke and independent Requirement Acceptance gating on the exact PR head.
6. Merge with a **merge commit**, not squash or rebase. Inspect merged main/staging push workflows and trusted ingestion afterward; record evidence and distinguish success, failure and skipped (no-artifact) paths.
7. For a criterion requiring merged or deployed proof, require fresh exact-target main-SHA evidence or authenticated actual deployment identity. Do not reuse staging evidence or interpret workflow success as an SC Pass without assertions.
8. Retire one-offs only after generic replacements and source/history integrity have been independently verified.

## Recorded end-to-end method separation

[Requirement #1674](https://github.com/BestNathan/nession/issues/1674) contains independent staging-SHA Agent run 38255975987 and executable Case run 38255975783, and independent main-SHA Agent run 38258395366 and executable Case run 38258395018 with trusted Case Ingest 38258723607. The staging SHA is 9249399c1a09b713c67d98687aa49e96bdc802fa and the main SHA is 01111075dc08afa931907ee268d2dd7376d037d1. Both Case runs authenticated a real Server and observed an online Agent, with distinct immutable records. Main Release run 38258395318 was cancelled, so this **does not** prove deployment.

Implementation owners remain nession-cicd (CI/release), nession-acceptance (SC runtime and trusted evaluation), nession-agent-workflow-metrics (telemetry), and nession-gates (blocking invariants). This page owns taxonomy and coordination.
