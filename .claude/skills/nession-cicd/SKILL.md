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

### Container-image Iron Laws

**Never build Nession Docker images locally. No exceptions.**

- do not run `docker build` for Nession images;
- do not `docker push` Nession images to GHCR;
- do not manually create multi-arch manifests;
- do not manually patch Kubernetes/GitOps image tags to bypass CI;
- if an image/release is broken, fix CI or roll back to an already-published artifact.

CI is the single source of truth for Nession container images. Diagnose application code with the native local development commands owned by `nession-development`; do not use a local Docker build as an alternate image pipeline.

### Artifact retention

Release/rollback history is append-only unless a separate approved policy explicitly changes it.

Do not add cleanup/pruning that removes:

- hash-tagged staging images;
- version-tagged production images;
- GitHub Releases needed for historical release/rollback traceability.

Rollback depends on previously published artifacts remaining available.

## Repository merge and branch policy

These are repository policy, not GitHub UI defaults:

- **Every PR merge uses a merge commit**: `gh pr merge <N> --merge` (or `--auto --merge` when a required check is pending).
- **Never merge with `--rebase` or `--squash`.** Branch-local history cleanup may happen before the PR is merged, but the repository merge itself preserves the branch tip and original commit ancestry.
- Normal feature/fix delivery goes through the staging flow before release to `main`.
- **Exception for `.github/workflows/*`:** workflow-definition changes are fast-tracked in a separate worktree based on `origin/main`, submitted as their own PR directly to `main`, and merged with `--merge`. Do not bury a workflow fix inside a feature PR waiting on staging.
- The staging -> main release PR is also merged with `--merge`.

### PR base routing

Choose the target branch from the changed surface:

| Change | PR base |
|---|---|
| anything under `crates/` or `web/src/` | `staging` — runtime/build-input changes require integration + staging validation |
| `.github/workflows/*` | `main` — separate fast-track workflow PR |
| docs-only changes | `main` |
| repository chore/config/cleanup with no runtime build input | `main` |
| `scripts/**` / `justfile` changes with no runtime build-input change | `main` |

If a “chore”, script, or config change also changes runtime/build inputs under `crates/` or `web/src/`, the runtime rule wins and it goes through `staging`.

Direct-to-main changes still use a worktree and `--merge`. They do not get a free pass around the relevant local/Gate checks.

The long historical rationale is intentionally not carried in this entrypoint; this section preserves the operational invariants agents must follow.

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
4. merge with the repository policy above (`--merge`, never rebase/squash);
5. observe the resulting workflow and deployment until the requested boundary is proven.

Do not assume an old staging/main relationship; inspect current workflow triggers and branch state.

Version consistency is enforced by `release-version-consistency`. Version files must move together when a bump is required.

## Release version policy

Production release is **version-triggered**. `release.yml` runs on pushes to `main`, but its build/release/deploy jobs proceed only when the version moves forward (or the current version tag is absent for a retry). Merging runtime code to `main` without the required bump leaves production on the previous images.

Decide from what shipped:

| Release content | Version action |
|---|---|
| runtime changes under `crates/` or `web/src/` | **bump required** |
| user-visible feature | minor bump |
| fix-only runtime release | patch bump |
| tests/docs/CI/config only | normally no bump |

Nession is pre-1.0, so normal release decisions are minor or patch, not major.

The bump is a **separate PR after the staging -> main release PR has merged**:

1. refresh latest `main` and create a dedicated worktree;
2. bump all four files together: `Cargo.toml`, `Cargo.lock`, `web/package.json`, `web/package-lock.json`;
3. open the bump PR directly to `main`;
4. merge it with `--merge` (no squash/rebase);
5. observe `release.yml` through image publication, GitHub Release, production approval, and GitOps/ArgoCD rollout.

If `v<version>` is absent because a release failed or never completed, `release.yml` may retry that same version without another bump. The executable version comparison/retry behavior remains owned by `.github/workflows/release.yml`; `release-version-consistency` only proves the version files agree, not whether a bump is required.

## 7. Deployment / GitOps

CI owns image publication. GitOps owns desired deployment state.

Do not manually mutate production desired state merely to make a rollout “look fixed”. Diagnose whether the failure is:

- image/build;
- manifest/GitOps state;
- ArgoCD sync;
- Kubernetes scheduling/runtime;
- application health.

Keep one owner per layer.

## 8. Deployment monitoring

Use the repository's canonical end-to-end monitor instead of reconstructing partial `gh` / `kubectl` checks:

```bash
# after merging to staging
./scripts/deploy-watch.sh staging

# after release/version promotion to production
./scripts/deploy-watch.sh prod
```

`scripts/deploy-watch.sh` owns the combined view of the relevant GitHub Actions phases plus Kubernetes rollout/pod health, and exits non-zero on failure. Its prerequisites are `gh`, `kubectl`, and `jq`.

After a merge/release, report the concrete workflow run, deployed revision, and runtime rollout result. Do not claim deployment success from “workflow green” when the requested boundary includes Kubernetes/application rollout proof.

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
