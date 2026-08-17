---
name: nession-cicd
description: Use when troubleshooting CI/CD pipeline failures for nession, modifying the GitHub Actions workflow, investigating failed Docker builds or k8s deployments, or understanding the CI → ArgoCD deploy chain
---

# Nession CI/CD

## Overview

**CI builds images. You don't.** Development happens locally. Three workflows handle deployment:
- **Quality Gate** (`quality.yml`): PR to staging triggers rust-check + web-check
- **Staging** (`staging.yml`): merge to staging triggers full build + deploy to staging
- **Release** (`release.yml`): merge to main triggers release build + deploy to production

```
Local dev → verify locally
  → push branch → PR to staging → quality gate passes → rebase-merge to staging
  → staging builds + deploys to staging environment → validate on staging
  → version bump (minor 0.x.0 or patch 0.x.y) → rebase staging onto bump branch → PR to main
  → release builds multi-arch images → ArgoCD syncs to production
```

## Deployment Monitoring

Use `scripts/deploy-watch.sh` to monitor deployments end-to-end:

```bash
# After merging PR to staging — watch staging build + rollout
./scripts/deploy-watch.sh staging

# After merging to main + version bump — watch release + prod rollout
./scripts/deploy-watch.sh prod
```

**What it does:**
- Watches the appropriate GitHub Actions workflow (staging.yml for staging, release.yml for prod)
- Shows only key phases (Check → Versions → Build → Docker → Merge → Kustomize)
- On CI failure: shows the failed job's log tail and suggests fixes based on error patterns
- On CI success: monitors k8s rollout status for all 3 deployments with pod health checks
- Exits non-zero on any failure so it can be used in scripts/CI

**Prerequisites:** `gh`, `kubectl`, `jq`

## ⛔ Iron Law

```
NEVER BUILD DOCKER IMAGES LOCALLY
```

**No exceptions:**
- Don't `docker build` for nession
- Don't `docker push` to GHCR
- Don't manually update k8s manifests for image tags
- Don't manually create multi-arch manifests
- If k8s is broken, fix CI or roll back via GHCR — don't patch images by hand

CI is the single source of truth for all container images.

## Development Flow

### 1. Develop and verify locally

```bash
# Start server (auto-reload on change)
cargo run -p nession-server

# Start agent (in another terminal)
cargo run -p nession-agent

# Start web UI (in another terminal)
cd web && npm run dev
```

Verify business logic and flows against the running local services. Do NOT deploy to k8s to test.

### 2. Version bump → see nession-development

Version bumping (minor vs patch, which files to update) is covered in the nession-development skill. Use that skill for all version decisions. CI automatically reads versions from `Cargo.toml` and `web/package.json` on merge.

### 3. Push and create PR

```bash
git fetch origin
git checkout -b feat/description origin/staging   # branch from the ref you target
git add -A
git commit -m "feat: description"
git push origin feat/description
gh pr create --base staging --title "feat: description" --body "..."
```

**Do NOT push directly to main or staging.** All changes go through PRs targeting `staging`.

**Exception — `.github/workflows/*` changes:** GitHub Actions workflows only take effect from the default branch (main). Workflow changes on feature branches are ignored by GitHub. When modifying `.github/workflows/*`, the workflow commit MUST be cherry-picked to a separate branch off `main`, fast-tracked as its own PR, and merged to main immediately — otherwise the change has no effect until the feature PR merges (which may be days or never).

```
# 正确流程 — workflow 变更必须独立合入 main
git checkout -b chore/workflow-fix origin/main
git cherry-pick <workflow-commit-hash>
git push -u origin chore/workflow-fix
gh pr create --title "chore: ..." --body "..."
gh pr merge <N> --rebase
```

**Merging feature branches (auto-merge to staging):**

For `feat/**` and `fix/**` branches, the flow is **branch off origin/staging → PR to staging → quality gate → squash-merge to staging → staging deploy → validate → rebase staging onto a bump branch → PR to main**.

```bash
# 1. Push → create PR targeting staging
git push origin <branch-name>
gh pr create --base staging --title "feat: ..." --body "..."

# 2. Auto-merge to staging when quality gate passes
#    --squash here: one commit per feature on staging. This does NOT hurt
#    patch-id de-duplication — that single commit is what gets rebased onto
#    main later, patch intact. Only staging -> main must avoid --squash.
gh pr merge <PR-NUMBER> --auto --squash

# 3. Watch staging workflow + rollout
./scripts/deploy-watch.sh staging

# 4. After staging validation, rebase staging onto a bump branch and PR to main
#    See version bump section below
```

**Auto-merge to staging is safe** because staging is the integration environment — not production. The quality gate (rust-check + web-check) ensures code correctness. Human validation happens on staging before the staging → main merge.

**`--auto` only works when the PR has a check to wait on.** Feature PRs to staging trigger the quality gate, so `--auto` is fine. `chore/**` PRs trigger no CI, so GitHub immediately reports `CLEAN` and rejects auto-merge with `GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)`. Merge those directly, without `--auto`.

**Version bump branches (`chore/**`) don't trigger CI** and can be merged directly:

```bash
# After staging validation passes
git fetch origin                  # local `staging` is frequently stale
git checkout main && git pull
git checkout -b chore/bump-version-X.Y.Z
# Rebase staging in FIRST — before the bump commit, or the bump gets buried
# mid-history. Use origin/staging, never the local ref: a stale local `staging`
# releases the wrong tree and invents conflicts that don't exist.
# Already-released commits are skipped via patch-id matching.
git rebase origin/staging
# Bump version in all four files: Cargo.toml, Cargo.lock,
# web/package.json, web/package-lock.json
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push -u origin chore/bump-version-X.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z" --body "Version bump"
gh pr merge <PR-NUMBER> --rebase  # Direct merge, no --auto (no checks to wait on)
```

**⚠ Never put an empty commit on `staging`.** Empty commits have no patch-id, so de-duplication cannot see them and they are re-applied on **every** subsequent release. Use `gh workflow run` to trigger workflows, not `git commit --allow-empty`. Drop an existing one with `git rebase -i origin/staging`.

### Why the merge method differs per step

`main` accumulates commits `staging` never sees (the automated `chore: update staging image tags` PRs), so the two branches permanently diverge and every release must reconcile them. The method that decides whether that stays cheap is **`staging → main`**, not `feature → staging`.

| Step | Method | Effect |
|------|--------|--------|
| `feature → staging` | `--squash` | One commit per feature. Harmless to de-duplication — that single commit is what gets rebased onto `main` later, patch intact. Also the only way `Closes #N` reaches `main` (see below). |
| `staging → main` | `--rebase` | Each `staging` commit lands on `main` as a 1:1 patch-id twin, so the next `git rebase origin/staging` skips already-released commits automatically. Preserves commit messages. |

Squashing at `staging → main` is what breaks it: N commits collapse into one whose combined patch-id matches nothing, so the next release replays all N and conflicts the moment `main` has touched the same files. Measured: release PR #268 was squash-merged, and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

Verified behaviour of `git rebase origin/staging` on a bump branch: already-released commits are dropped with `skipped previously applied commit`, `Merge branch 'main' into staging` commits are linearized away, and `main`-only commits rewritten during the rebase are de-duplicated again by the final rebase-merge. Net effect on `main` is exactly the new work plus the bump commit.

### Branch base

A PR's diff is computed against `merge-base(base, head)`. So a branch cut from `main` but targeting `staging` silently carries every commit `main` has that `staging` lacks, and the merge drags all of it into `staging` — bundled into the squash commit, or replayed as rewritten duplicates under rebase. Measured: a `docs/**` branch cut from `main` dragged 5 of `main`'s commits into `staging`.

Always branch feature work from `origin/staging`. `EnterWorktree` bases on `origin/main` (`worktree.baseRef` accepts only `fresh` | `head`, so it cannot be pointed at another ref) — run `git fetch origin && git reset --hard origin/staging` right after entering a feature worktree.

### Issue auto-close

The repo is configured with:

```
squash_merge_commit_message = COMMIT_MESSAGES
```

so a squash commit's body is assembled from **commit messages**; the PR description is discarded. GitHub also only honours closing keywords once they reach the **default branch** (`main`) — a merge into `staging` never triggers them.

Therefore `Closes #N` written only in a PR body is dropped at the squash and never reaches `main`. **Auto-close has never worked in this repo for this reason** — issues #240, #239 and #177 were all closed by hand, and PR #257's body carried a closing keyword while its squash commit `d674539` had none.

Put the keyword in a commit message:

```bash
git commit -m "fix: stop terminal remounting on address switch

Closes #263"
```

It then flows: commit message → squash body on `staging` → rebase-merge preserves it → lands on `main` → issue closes at release time.

**PR 状态判断（详见 nession-development PR Workflow）：**

```
当前分支的 PR?
├─ 没有 → git push + gh pr create
├─ OPEN → gh pr edit 更新（继续迭代）
└─ MERGED → ⛔ 分支已死，新建分支 + 新 PR
```

**⚠ 已合并的 PR 不能 `gh pr edit` 追加 commit。** 合并后分支即死，如需继续修改，必须从最新 main 创建新分支和新 PR。

### 4. Merge to staging triggers build + deploy

When the PR is merged to staging, GitHub Actions (`staging.yml`) automatically:
1. Reads versions from `Cargo.toml` + `package.json` and computes the short git hash
2. Builds web UI (`npm ci && npm run build`)
3. Builds Rust binaries natively for amd64 AND arm64
4. Creates multi-arch Docker images tagged with **hash** (`server-{sha}`, `agent-{sha}`, `ui-{sha}`)
5. Updates `k8s/overlays/staging/kustomization.yaml` on main with hash-based image tags (commit with `[skip ci]`)
6. ArgoCD detects the kustomize change and syncs to staging k8s

**After staging validation**, create a version bump branch from main, `git rebase staging` into it, bump the version, and PR to main. The `release.yml` workflow then:
1. Builds version-tagged Docker images (`server-{version}`, `agent-{version}`, `ui-{version}`)
2. Creates GitHub Release with native binaries
3. Updates `k8s/overlays/production/kustomization.yaml` with version-based image tags
4. ArgoCD syncs to production k8s

**No manual steps after merge.** CI → ArgoCD is fully automatic.

## Quick Reference

### Image Tags (managed by CI, not you)

| Image | Primary Tag (always) | Version Alias (on version change) | Source |
|-------|---------------------|-----------------------------------|--------|
| server | `server-{sha}` | `server-{version}` | Git hash / `Cargo.toml` |
| agent | `agent-{sha}` | `agent-{version}` | Git hash / `Cargo.toml` |
| ui | `ui-{sha}` | `ui-{version}` | Git hash / `web/package.json` |

**Staging uses hash tags** (`server-{sha}`). **Release uses version tags** (`server-{version}`).
**K8s always deploys immutable tags** for traceable deployments.

### Key Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Workspace version (Rust binaries) |
| `web/package.json` | Web UI version |
| `.github/workflows/quality.yml` | PR quality gate (rust-check + web-check) |
| `.github/workflows/staging.yml` | Staging build + deploy (push to staging) |
| `.github/workflows/release.yml` | Release build + deploy (push to main) |
| `k8s/overlays/staging/kustomization.yaml` | Staging image tags (auto-updated by staging.yml) |
| `k8s/overlays/production/kustomization.yaml` | Production image tags (auto-updated by release.yml) |

### Observing Deployments

```bash
# Check CI run status
gh run list --limit 3

# Watch pods after deploy
kubectl get pods -n nession -w

# Check deployed image versions
kubectl get pods -n nession -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.containers[*].image}{"\n"}{end}'

# Force rollout (only if ArgoCD didn't auto-sync)
kubectl rollout restart deployment -n nession
```

## CI Pipeline Architecture

```
PR to staging:
  → quality.yml: rust-check + web-check (gate for merge)

Merge to staging:
  → staging.yml:
  → versions job: read Cargo.toml + package.json + short SHA
  → build-web: npm ci && npm run build (arch-independent, always)
  → build-amd64 + build-arm64 (parallel): cargo zigbuild --release
  → docker: build + push hash-tagged images (server-{sha}-{arch}, etc.)
  → merge: docker buildx imagetools create (multi-arch manifests)
  → update-staging-kustomize: commit hash-based tags to main (with [skip ci])
  → ArgoCD: auto-sync to staging k8s

Merge to main (after staging validation + version bump):
  → release.yml:
  → version-check: only runs if version changed in Cargo.toml/package.json
  → build + docker: version-tagged images (server-{version}-{arch}, etc.)
  → merge: multi-arch version manifests
  → build-macos: native macOS binaries
  → create-release: GitHub Release with all binaries
  → update-prod-kustomize: commit version-based tags to main
  → ArgoCD: auto-sync to production k8s
```

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `docker build` for nession | **Forbidden.** CI builds images. |
| "I'll just patch the k8s image tag" | k8s is read-only for you. Fix the CI or roll back via GHCR tags. |
| Building locally to "test the Docker image" | Test locally with `cargo run`. |
| Major version bumps (1.x) | Nession is pre-1.0. Only minor and patch exist. |
| **PR 已合并还往分支推 commit** | **FORBIDDEN.** 合并后分支已死。新建分支 + 新 PR。 |
| **用 `gh pr edit` 更新已合并的 PR** | 没用的。已合并的 PR 不会因为新 commit 重新打开。 |

## Troubleshooting

### CI Job Fails

```bash
gh run view <run_id> --log-failed 2>&1 | tail -30
gh run rerun <run_id> --failed
```

### Pods Not Starting After Deploy

```bash
kubectl describe pod <pod-name> -n nession | grep -A10 "Events:"
```

### Stale Pods Stuck on Old Images

```bash
kubectl delete pod <pod-name> -n nession
# If old ReplicaSet keeps creating pods:
kubectl scale rs <old-rs-name> -n nession --replicas=0
```
