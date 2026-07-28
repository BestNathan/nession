---
name: nession-cicd
description: Use when troubleshooting CI/CD pipeline failures for nession, modifying the GitHub Actions workflow, investigating failed Docker builds or k8s deployments, or understanding the CI → ArgoCD deploy chain
---

# Nession CI/CD

## Overview

**CI builds images. You don't.** Development happens locally. CI triggers on merge to main. ArgoCD deploys to k8s.

```
Local dev → cargo run / npm run dev → verify locally
  → version bump (minor 0.x.0 or patch 0.x.y)
  → push branch → create PR → merge to main
  → CI builds multi-arch images → ArgoCD syncs to k8s
```

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
git checkout -b feat/description
git add -A
git commit -m "feat: description"
git push origin feat/description
gh pr create --title "feat: description" --body "..."
```

**Do NOT push directly to main.** All changes go through PRs.

**Exception — `.github/workflows/*` changes:** GitHub Actions workflows only take effect from the default branch (main). Workflow changes on feature branches are ignored by GitHub. When modifying `.github/workflows/*`, the workflow commit MUST be cherry-picked to a separate branch off `main`, fast-tracked as its own PR, and merged to main immediately — otherwise the change has no effect until the feature PR merges (which may be days or never).

```
# 正确流程 — workflow 变更必须独立合入 main
git checkout -b chore/workflow-fix origin/main
git cherry-pick <workflow-commit-hash>
git push -u origin chore/workflow-fix
gh pr create --title "chore: ..." --body "..."
gh pr merge <N> --squash
```

**Auto-merge for feature branches:**

For `feat/**` and `fix/**` branches, use auto-merge to automatically merge the PR once all CI checks pass:

```bash
# Enable auto-merge (squash merge when checks pass)
gh pr merge <PR-NUMBER> --auto --squash

# Check status
gh pr view <PR-NUMBER> --json autoMergeRequest,state,statusCheckRollup

# Cancel auto-merge if needed
gh pr merge <PR-NUMBER> --disable-auto
```

**When to use auto-merge:**
- Branch is `feat/**` or `fix/**` (triggers CI workflow)
- Development is complete (all features implemented)
- All tests pass locally
- PR is ready for review

**Benefits:**
- PR merges automatically when CI passes (rust-check, web-check, builds)
- No need to manually monitor CI status or click merge
- Reduces wait time between approval and merge

**⚠ Auto-merge cancels automatically if any check fails.** Fix the issue and push — auto-merge re-enables.

**Version bump branches (`chore/**`) don't trigger CI** and can be merged directly:

```bash
# After merging feature branch to main
git checkout main && git pull
git checkout -b chore/bump-version
# Bump version in Cargo.toml and web/package.json
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push origin chore/bump-version
gh pr create --title "chore: bump version to X.Y.Z" --body "Version bump"
gh pr merge <PR-NUMBER> --squash  # Direct merge, no CI needed
```

**PR 状态判断（详见 nession-development PR Workflow）：**

```
当前分支的 PR?
├─ 没有 → git push + gh pr create
├─ OPEN → gh pr edit 更新（继续迭代）
└─ MERGED → ⛔ 分支已死，新建分支 + 新 PR
```

**⚠ 已合并的 PR 不能 `gh pr edit` 追加 commit。** 合并后分支即死，如需继续修改，必须从最新 main 创建新分支和新 PR。

### 4. Merge triggers CI

When the PR is merged to main, GitHub Actions automatically:
1. Reads versions from `Cargo.toml` + `package.json` and computes the short git hash
2. Builds web UI (`npm ci && npm run build`)
3. Builds Rust binaries natively for amd64 AND arm64
4. Creates multi-arch Docker images tagged with **hash** (`server-{sha}`, `agent-{sha}`, `ui-{sha}`)
5. If version changed, also creates **version alias** tags (`server-{version}`, `agent-{version}`, `ui-{version}`)
6. Updates `k8s/kustomization.yaml` with hash-based image tags
7. ArgoCD detects the kustomize change and syncs to k8s

**No manual steps after merge.** CI → ArgoCD is fully automatic.

## Quick Reference

### Image Tags (managed by CI, not you)

| Image | Primary Tag (always) | Version Alias (on version change) | Source |
|-------|---------------------|-----------------------------------|--------|
| server | `server-{sha}` | `server-{version}` | Git hash / `Cargo.toml` |
| agent | `agent-{sha}` | `agent-{version}` | Git hash / `Cargo.toml` |
| ui | `ui-{sha}` | `ui-{version}` | Git hash / `web/package.json` |

**Every push to main builds images with hash tags.** Version tags are additional aliases
pointing to the same image, created only when `Cargo.toml` or `package.json` version changes.
**K8s always deploys hash-based tags** for immutable, traceable deployments.

### Key Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Workspace version (Rust binaries) |
| `web/package.json` | Web UI version |
| `.github/workflows/docker-publish.yml` | CI pipeline |
| `k8s/kustomization.yaml` | Image tag mapping (auto-updated by CI) |

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
git push to main
  → versions job: read Cargo.toml + package.json + short SHA
  → build-web: npm ci && npm run build (arch-independent, always)
  → build-amd64 + build-arm64 (parallel): cargo build --release, Docker build
      → Push hash tag (always): server-{sha}-{arch}
      → Push version tag (if version changed): server-{version}-{arch}
  → merge: docker buildx imagetools create (multi-arch manifests)
      → Create hash manifest (always): server-{sha}
      → Create version alias (if version changed): server-{version}
  → update-kustomize: kustomize edit set image → commit (hash-based tags)
  → ArgoCD: auto-sync to k8s
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
