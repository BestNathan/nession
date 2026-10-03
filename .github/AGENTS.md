# GitHub Automation Instructions

This scope owns `.github/` workflows/templates and GitHub execution routing.

Load `nession-cicd` for release/deployment changes and `nession-gates` for Gate routing.

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

## Change discipline

Workflow changes happen in a worktree and receive the same Gate/review treatment as code. Preserve concurrency/cancellation semantics deliberately; do not add broad retries that hide deterministic failures.
