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
  → branch off main → PR to staging → quality gate passes → squash-merge to staging
  → staging builds + deploys to staging environment → validate on staging
  → audit what is being released → PR staging → main with every `Closes #N` → --merge
  → release builds multi-arch images → ArgoCD syncs to production
  → sync main → staging (fast-forward) → version bump if warranted
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
git checkout -b feat/description origin/main   # every branch comes off main
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

For `feat/**` and `fix/**` branches, the flow is **branch off main → PR to staging → quality gate → squash-merge to staging → staging deploy → validate → PR staging → main with `--merge`**.

```bash
# 1. Push → create PR targeting staging
git push origin <branch-name>
gh pr create --base staging --title "feat: ..." --body "..."

# 2. Auto-merge to staging when quality gate passes
gh pr merge <PR-NUMBER> --auto --squash

# 3. Watch staging workflow + rollout
./scripts/deploy-watch.sh staging

# 4. After staging validation, open the release PR (see "Release: staging → main")
```

The feat→staging merge method is **free**. `--squash` is the default because it gives one commit per feature on `staging`, but nothing downstream depends on it: issues close from the release PR body, and the release uses a merge commit which does not care how many commits it is absorbing.

**Auto-merge to staging is safe** because staging is the integration environment — not production. The quality gate (rust-check + web-check) ensures code correctness. Human validation happens on staging before the staging → main merge.

**`--auto` only works when the PR has a check to wait on.** Feature PRs to staging trigger the quality gate, so `--auto` is fine. `chore/**` PRs trigger no CI, so GitHub immediately reports `CLEAN` and rejects auto-merge with `GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)`. Merge those directly, without `--auto`.

### Release: staging → main

```bash
# 1. Audit what is about to ship, and find the issues it resolves
gh pr list --state merged --base staging --limit 20
gh issue list --state open

# 2. Open the release PR. Every issue needs its own Closes line.
gh pr create --base main --head staging \
  --title "chore: release (staging → main)" \
  --body "$(cat <<'BODY'
## 变更内容
- feat: ... (#PR)
- fix: ... (#PR)

## 测试报告
- staging 验收: ...

Closes #<ISSUE>
Closes #<ISSUE>
BODY
)"

# 3. MUST be --merge
gh pr merge <PR-NUMBER> --merge

# 4. Sync main back into staging — fast-forward, no force push
git fetch origin
git push origin origin/main:refs/heads/staging
```

**The release PR must be `--merge`.** A merge commit records `staging`'s tip as a second parent, so `staging` stays an ancestor of `main` and step 4 is a fast-forward forever.

`--rebase` breaks this. GitHub's rebase-merge replays `staging`'s commits onto `main` as new SHAs and **leaves `staging` pointing at the originals**, so `staging` is never an ancestor of `main`. Measured over three release cycles:

| Method | Cycle 1 sync | Cycle 2 release | End state |
|--------|--------------|-----------------|-----------|
| `--merge` | fast-forward | clean | `staging` ancestor of `main`, 0/0 |
| `--rebase` | not a fast-forward, needs a merge commit | **conflict** | `staging` 3 commits *ahead* of `main` with duplicates |

`--squash` is worse still: N commits collapse into one whose combined patch-id matches nothing, so the next release replays all N. Measured: release PR #268 was squash-merged and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

This is also the historical cause of `staging` sitting ~16 commits behind `main` and needing the merge-commit realignment in PR #279.

### Version bump

A bump is a **separate PR after the release merged**, not part of it. Cut it from `main`, which by then already contains the release.

```bash
git fetch origin
git checkout -b chore/bump-version-X.Y.Z origin/main
# Bump version in all four files: Cargo.toml, Cargo.lock,
# web/package.json, web/package-lock.json
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push -u origin chore/bump-version-X.Y.Z
gh pr create --base main --title "chore: bump version to X.Y.Z" --body "Version bump"
gh pr merge <PR-NUMBER> --rebase  # Direct merge, no --auto (no checks to wait on)
```

Not every release needs one. Decide by what shipped: user-visible feature → minor, fix only → patch, docs/chore only → none.

**But "none" means the release never reaches production.** 15 of `release.yml`'s 18 jobs carry `if: needs.version-check.outputs.version_changed == 'true'`; the two cleanup jobs have no `if:` but depend on gated jobs, so they skip too. The release PR itself changes no version file, so `version-check` reports `false` and everything downstream skips — no images, no GitHub Release, no `k8s/overlays/production` update, nothing for ArgoCD to sync. Measured on release PR #287: `version-check: success`, everything else `skipped`.

So the rule is:

| Release contains | Bump |
|---|---|
| runtime changes under `crates/` or `web/src/` | **mandatory** — skip it and production silently stays on the old images |
| tests, docs, CI config only | optional |

One escape hatch exists: if the git tag `v<version>` does not resolve, `version-check` sets `version_changed=true` regardless, so a failed release can be retried at the same version without bumping (issue #71).

**All four files must land on the same version.** `release.yml` tags server/agent from `Cargo.toml` and ui from `web/package.json` but gates both on one `version_changed`. Bumping only `web/package.json` would re-push `server-<old>` / `agent-<old>` over already-released tags and then try to create a Release at the existing `v<old>` tag. `version-check` now hard-fails on a mismatch rather than letting that through.

### Direct-to-main path

Work that touches **no build input** skips `staging`:

```bash
git fetch origin
git checkout -b docs/<slug> main      # or chore/<slug>
git add -A && git commit -m "docs: ..."
git push -u origin docs/<slug>
gh pr create --base main --title "docs: ..." --body "..."
gh pr merge <PR-NUMBER> --rebase      # no --auto: no checks to wait on
```

Applies to `docs/**`, `chore/**` (config, deps, cleanup), `.github/workflows/*`, and `k8s/**` manifests.

**Hard boundary: anything under `crates/` or `web/src/` must go through `staging`.** `quality.yml` only runs on PRs targeting `staging`, so a PR to `main` has no CI gate at all — the only protection is the local pre-commit hook. Routing code changes straight to `main` would ship them with no independent verification and no staging soak.

Two consequences to accept:

- Direct-to-main changes never pass through `staging`, so `staging` falls behind until the next sync. Sync it with `git push origin origin/main:refs/heads/staging` — a fast-forward, no PR needed.
- `.github/workflows/*` changes only take effect from the default branch, which is why they were already on this path. Note that `push`-triggered workflows use the workflow file *at the pushed commit*, so `staging.yml` behaviour on `staging` still reflects `staging`'s copy until `staging` is re-synced — a workflow fix merged to `main` does not change staging builds until step 7 runs.

**⚠ Never put an empty commit on `staging`.** Empty commits have no patch-id, so de-duplication cannot see them and they are re-applied on **every** subsequent release. Use `gh workflow run` to trigger workflows, not `git commit --allow-empty`. Drop an existing one with `git rebase -i origin/staging`.

### Why the merge method differs per step

`staging.yml` writes `chore: update staging image tags` commits to **`main`**, not to `staging` (it checks out `ref: main` while running on a push to `staging`). So `main` gains a commit `staging` lacks after every staging build, and the two diverge between releases. The method that decides whether that stays cheap is **`staging → main`**, not `feature → staging`.

Those kustomize commits touch only `k8s/overlays/staging/kustomization.yaml`, while a release PR carries feature files — different paths, so the 3-way merge does not conflict. Measured across three release cycles with a kustomize commit landing on `main` before each release: zero conflicts under `--merge`. (Earlier revisions of this doc claimed the staging overlay blob was a guaranteed conflict source. That was true only while `staging` was never synced back from `main`; step 7 of the flow removes it.)

Note the steady state: because every push to `staging` — including a `main → staging` sync — triggers `staging.yml`, which then writes a kustomize commit to `main`, `main` normally sits exactly 1 commit ahead of `staging`. That is expected and harmless. `paths-ignore` keeps docs-only syncs from triggering a build at all.

| Step | Method | Effect |
|------|--------|--------|
| `feature → staging` | `--squash` (free) | One commit per feature. Nothing downstream depends on it. |
| `staging → main` | `--merge` (mandatory) | Merge commit records `staging`'s tip as a parent, so `staging` stays an ancestor of `main` and the sync back is always a fast-forward. |
| `main → staging` sync | fast-forward push | Only possible because the release used a merge commit. Never force-push. |

See **Release: staging → main** above for the measured three-cycle comparison of `--merge` vs `--rebase`.

### Branch base

A PR's diff is computed against `merge-base(base, head)`. Branching everything off `main` is correct **because the sync step keeps `main` from falling behind `staging`** — after a release plus sync, the two refs are identical, so "off `main`" and "off `staging`" are the same commit.

Skip the sync and that stops being true: `main` starts missing unreleased work, and a branch cut from `main` lacks code it needs. Measured — with a feature on `staging` but not yet released, a follow-up fix branched from `main` **conflicts**, while the same fix branched from `origin/staging` applies cleanly as a single commit. So the one exception is:

> Follow-up work on code that is on `staging` but not yet released → branch off `origin/staging`.

The reverse mistake still applies in the other direction: a branch cut from `main` but targeting `staging` while `main` is *ahead* drags every extra commit into `staging`. Measured: a `docs/**` branch cut from `main` dragged 5 of `main`'s commits into `staging`. The sync step is what prevents this.

`EnterWorktree` bases on `origin/main` (`worktree.baseRef` accepts only `fresh` | `head`, so it cannot be pointed at another ref), which is now the correct base — no reset needed unless you need the `origin/staging` exception.

### Issue auto-close

Put every `Closes #N` in the **`staging` → `main` release PR body**. Nowhere else.

GitHub interprets closing keywords "only when the pull request targets the repository's *default* branch"; otherwise "these keywords are ignored, no links are created". So:

```
feat → staging PR body:  Closes #N   → IGNORED, no link, issue stays open
staging → main PR body:  Closes #N   → linked at PR creation, closed on merge
```

Measured: PR #257 had a correctly formatted `Closes #256` on its own line with base `staging`, and `closingIssuesReferences` was **0** — not even a UI link. That is why auto-close never worked here before; issues #240, #239 and #177 were all closed by hand.

Because the keyword now rides a PR body targeting the default branch, the merge method is irrelevant and the issue **does** get a proper linked-PR entry in its sidebar — unlike the older commit-message approach, where GitHub notes "the pull request that contains the commit will not be listed as a linked pull request".

This is why the release PR needs an audit step: nothing upstream carries the issue reference for you, so an issue not listed in the release PR body stays open after shipping.

```bash
gh pr view <RELEASE-PR> --json closingIssuesReferences   # verify before merging
```

`PR_BODY` also forces `squash_merge_commit_title = PR_TITLE`; GitHub rejects `COMMIT_OR_PR_TITLE` + `PR_BODY` as an invalid combination. So squash subjects are always the PR title now, never a single commit's own subject.

**Because the body becomes permanent history**, keep it a change record: 变更内容 + 测试报告 + `Closes #N`. Screenshots go in a PR comment (`gh pr comment`), never the body.

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

**After staging validation**, open the release PR (`staging` → `main`, merged with `--merge`), then sync `main` → `staging`, then bump the version if warranted. The `release.yml` workflow then:
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

### Cleanup jobs are deliberately inert

`staging.yml` and `release.yml` each end with a `cleanup-ghcr` job, and `release.yml` also has `cleanup-releases`. **None of them has ever deleted anything**, and two of them must stay that way until someone makes an explicit decision.

The reason they no-op: `gh api /users/<owner>/packages/...` needs a token with `read:packages`, and the default `GITHUB_TOKEN` cannot read user-scoped packages. The calls fail. They used to fail into `2>/dev/null || true` and still print "Cleanup complete"; they now emit `::warning::` and exit 0 honestly.

Before "fixing" any of them by adding a PAT, know what would happen on the next run:

| Job | Effect once a token is added |
|-----|------------------------------|
| `staging.yml` → `cleanup-ghcr` | Deletes hash-tagged GHCR versions beyond the newest 5 logical versions. Reasonable — this is the intended behaviour. |
| `release.yml` → `cleanup-ghcr` | Same, now correctly scoped to hash tags. **Before this was fixed it had no tag filter at all** and would have deleted `server-<version>` / `agent-<version>` / `ui-<version>` — the live production images and every rollback target — because staging pushes 9 hash-tagged versions per build and always owns the 5 newest slots. |
| `release.yml` → `cleanup-releases` | **Would delete 48 of the 53 existing GitHub Releases and their git tags** (`--cleanup-tag`). Irreversible. Deleting a tag also flips `version-check`'s `version_changed` back to `true` for that version. Intentionally left unwired; decide the retention policy first. |

If you add a PAT, add it to one job at a time and check the run log before the next release.

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

Merge to main (release PR merged with --merge, then optional version bump):
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
