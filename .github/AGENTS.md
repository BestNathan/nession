# GitHub Automation Instructions

This scope owns `.github/` workflows/templates and GitHub execution routing.

Load `nession-workflows` for the implemented Workflow taxonomy, Agent/non-Agent naming, SC acceptance orchestration and safe trigger/consumer migrations. Its references explicitly distinguish active merged-SHA acceptance from the still-deferred production `when: deployed` runtime boundary.

Load `nession-cicd` for release/deployment changes and `nession-gates` for Gate routing. The currently checked-in workflow files and canonical scripts remain executable truth until a migration lands.

## Workflow branch / merge policy

Repository merge policy is owned by `nession-cicd`: PRs are merged with `--merge`, never squash/rebase.

For this scope, `.github/workflows/*` is a deliberate delivery exception: make the workflow change in a separate worktree based on `origin/main`, open its own PR directly to `main`, and merge it with `--merge`. Do not make workflow activation depend on an unrelated feature's staging lifecycle.

## Workflows are routers

A workflow may:

- prepare trusted tooling/environment;
- select Gate IDs/suites;
- invoke canonical scripts/Gates;
- publish artifacts/status;
- perform explicitly authorized deployment/release actions.

A workflow must not become a second implementation of protocol, design, acceptance, coverage, or other domain rules.

## Trust boundaries

- Treat fork/PR-head code as untrusted in credentialed workflow contexts.
- `pull_request_target` policy evaluation uses trusted default-branch code and must not checkout/execute untrusted PR head with secrets.
- Secrets and production credentials stay in their owning deployment/release boundary.
- Pin decisions/evidence to the exact commit when stale-head results would be unsafe.

## Runner image

Every job pins `runs-on: ubuntu-24.04`; do not reintroduce `ubuntu-latest`.
GitHub moved `ubuntu-latest` to ubuntu-26.04 on 2026-10-26, and the Rust
fake-tmux recorder then failed under `llvm-cov` on essentially every main-based
run (#2467). The pin is a deliberate, temporary compatibility boundary until
that work is done; removing it is a migration that must prove the full
Rust/CI suite on the new image, not a cleanup.

## Browser impact policy

`scripts/e2e-full-applicability.mjs` is the single owner of "can this change
affect a browser runtime?". `e2e-full-regression.yml` and `e2e-tests.yml`
consume its classification; do not add a second path catalog to workflow YAML.
Only a positively tooling-only diff, together with a trusted `not-required`
Issue plan, may skip browser provisioning. Unknown, mixed and unverifiable
diffs fail closed to applicable (#2478).

The policy's six categories are `tooling` (CI/Acceptance scheduler, ingestion
and Gate tooling), `e2e-runner` (E2E executor, selection/report contract,
browser tests, test support and Gate suite membership), `app-runtime` (product
runtime and build inputs), `e2e-fixture-catalog` (browser fixtures, scenario
fixtures and the Case catalog/verifiers), `mixed` (several risk categories)
and `unknown`. Only an all-`tooling` change is `tooling-only`; runner and
fixture/catalog risks are distinct and both stay applicable (#2478 SC-01).

A tooling-only Main merge records the skipped Full as an authenticated
`E2E_FULL_NOT_REQUIRED_V1` receipt in the Full scope job log, because the
Acceptance harness never reads artifacts. A successful Full workflow run whose
`full` job was skipped proves the suite did **not** execute; the receipt, the
scope job's steps and the exact push run/attempt must agree.

## Change discipline

Workflow changes happen in a worktree and receive the same Gate/review treatment as code. Preserve concurrency/cancellation semantics deliberately; do not add broad retries that hide deterministic failures.
