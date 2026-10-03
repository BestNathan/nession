---
name: nession-cicd
description: Use when changing or troubleshooting Nession GitHub Actions, staging/release flow, deployment, version promotion, Docker/GitOps automation, or failed CI/deploy runs.
---

# Nession CI/CD

This Skill owns **CI, staging, release, and deployment execution**. Workflows are routers; domain rules remain with their scripts/Gates/scoped owners.

Read `.github/AGENTS.md` before editing workflows and `nession-gates` when changing Gate routing.

## 1. First classify the problem

Identify the failing boundary before editing:

- repository quality / Gate;
- workflow setup/tooling;
- build/package;
- staging deployment;
- requirement acceptance;
- release/version promotion;
- GitOps/ArgoCD rollout.

Do not “fix CI” by weakening the domain invariant that CI exposed.

## 2. Development rules

Workflow changes still happen in a worktree from latest `main`; use `nession-development`.

Do not build/push release Docker images manually as a substitute for CI. Local development builds are for diagnosis, not release publication.

## 3. Current workflow owners

Treat the files themselves as live truth:

- `.github/workflows/quality.yml`
- `.github/workflows/staging.yml`
- `.github/workflows/release.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/requirement-acceptance.yml`
- `.github/workflows/acceptance.yml`
- `.github/workflows/deploy.yml`

When this Skill and workflow YAML disagree, inspect history/intent and repair the stale prose; do not copy the YAML's rule lists into this Skill.

## 4. Quality failures

For a named Gate failure:

```bash
./gates/run --describe <gate-id>
./gates/run <gate-id>
```

Follow reason/repair/owner. Use `nession-gates` for Gate design or routing changes.

For workflow-runtime failure, inspect the exact run/job/step and separate:

- product/test failure;
- missing dependency/tool;
- Actions permissions/trust boundary;
- cache/artifact problem;
- runner outage/transient provider issue.

Do not blind-retry deterministic failures.

## 5. Requirement acceptance

Acceptance execution belongs to `nession-acceptance`; issue structure belongs to `nession-writing-requirements`.

The GitHub workflow is only the router around the canonical acceptance validator. In `pull_request_target`, never execute untrusted PR-head code with credentials.

## 6. Staging and release

Before promotion:

1. identify the exact commit/PR being promoted;
2. verify required quality/acceptance evidence;
3. verify version policy if the release changes version;
4. merge using the repository's current required merge strategy;
5. observe the resulting workflow and deployment until the requested boundary is proven.

Do not assume an old staging/main relationship; inspect current workflow triggers and branch state.

Version consistency is enforced by `release-version-consistency`. Version files must move together when a bump is required.

## 7. Deployment / GitOps

CI owns image publication. GitOps owns desired deployment state.

Do not manually mutate production desired state merely to make a rollout “look fixed”. Diagnose whether the failure is:

- image/build;
- manifest/GitOps state;
- ArgoCD sync;
- Kubernetes scheduling/runtime;
- application health.

Keep one owner per layer.

## 8. Monitoring a change

After a merge/release, report the concrete workflow run, status, failing/passing job, and deployed revision when relevant.

Do not claim deployment success from “workflow green” if the user asked for runtime rollout proof.

## 9. Router design

A workflow may prepare environment, select Gates, invoke canonical validators, publish artifacts, or perform authorized deployment.

It must not duplicate:

- protocol rule lists;
- design rule lists;
- acceptance semantics;
- coverage thresholds;
- repair prose already owned by a Gate.

## 10. Common repair rules

- stale base/head evidence -> rerun on the intended head, not an arbitrary newer one;
- missing tool -> fix setup, not the quality rule;
- permissions failure -> repair trust/permissions boundary;
- deterministic test failure -> fix code/test owner;
- deployment failed after successful build -> investigate GitOps/Kubernetes/app runtime separately.

## Stop conditions

Pause the destructive/publishing action when:

- release authority was not requested;
- the exact head cannot be identified;
- a credentialed workflow would execute untrusted code;
- “fix” requires bypassing a required Gate;
- production mutation would replace the repository's GitOps owner.

Use the current workflow files as executable truth and keep this Skill focused on the operational decision flow.
