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
  → branch off main → PR to staging → quality gate passes → rebase-merge to staging
  → staging builds + deploys to staging environment → validate on staging
  → audit what is being released → PR staging → main with every `Closes #N` → --merge
  → version bump if warranted → release builds multi-arch images → ArgoCD syncs to production
  → sync main → staging (fast-forward)
```

**Every merge is `--rebase` except the release, which must be `--merge`.** Nothing is ever squashed. The asymmetry is deliberate — see **Why the release uses a merge commit**.

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

**Nothing is ever pruned.** The repo is public, so GHCR storage and GitHub Releases are unmetered — there are no cleanup jobs and none should be added. Every hash-tagged staging image, every version-tagged production image, and all 53+ releases are retained indefinitely, which is what makes "roll back via GHCR" reliable: any previously built tag is still pullable.

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

For `feat/**` and `fix/**` branches, the flow is **branch off main → PR to staging → quality gate → rebase-merge to staging → staging deploy → validate → PR staging → main with `--merge` → sync main back to staging**.

```bash
# 1. Push → create PR targeting staging
git push origin <branch-name>
gh pr create --base staging --title "feat: ..." --body "..."

# 2. Auto-merge to staging when quality gate passes
gh pr merge <PR-NUMBER> --auto --rebase

# 3. Watch staging workflow + rollout
./scripts/deploy-watch.sh staging

# 4. After staging validation, open the release PR (see "Release: staging → main")
```

**`--rebase`, not `--squash`.** Rebase-merge replays the branch's commits onto `staging` individually, each keeping its own message. It leaves the feature branch itself on orphaned SHAs, which costs nothing — the branch is dead after merge and nobody syncs back to it. (That is exactly why the *release* cannot use `--rebase`: `staging` is long-lived and does get synced back.) Two consequences:

- **Commit messages are the permanent record.** No merge method in this flow writes the PR body to a commit. Measured: PR #301 rebase-merged as `673664f` and kept the commit's own message while the (different, Chinese) PR body was discarded; squash-merged PR #303 became `3a35e20` whose message *is* `PR_TITLE` + `PR_BODY`; and `--merge` writes `MERGE_MESSAGE` + `PR_TITLE`. The repo still has `squash_merge_commit_message = PR_BODY` configured, but nothing squashes any more.
- **Clean up the branch locally before merging.** `wip`/`fixup` commits land verbatim. Squash them with `git rebase -i` on the branch, not with a squash-merge.


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

# 4. Version bump if warranted (see "Version bump"), then wait for release.yml
./scripts/deploy-watch.sh prod

# 5. Sync main → staging. Always a fast-forward; no force push.
#    Last, once main has stopped moving (bump + prod tag commit are in).
git fetch origin
git push origin origin/main:refs/heads/staging
```

**Step 5 goes last** because the bump and `release.yml`'s `chore: update prod image tags` both land on `main` after step 3 — syncing earlier just leaves `staging` two commits behind again. It is still a fast-forward at that point: `staging`'s tip is an ancestor of the merge commit, which is an ancestor of everything added after it.

### Why the release uses a merge commit

**`--merge` records `staging`'s tip as a second parent**, so `staging` stays an ancestor of `main` and step 5 is a fast-forward forever. No orphaned commits are created and `staging` never needs a force push.

**`--rebase` cannot give that**, because GitHub's rebase-merge *always* rewrites the commits and leaves the head branch pointing at the originals. It rewrites even when nothing requires it: measured on PR #305, whose branch was already a linear descendant of `main`, the landed commit `787f8be` and the branch tip `39825da` had the **identical tree** `deaf21f4` and differed only because the committer date moved 12:14:04 → 12:16:43. There is no configuration that makes it fast-forward.

Those orphans are *usually* harmless — a later rebase skips them by patch-id:

| Orphan on `staging` | patch-id | Twin on `main` | patch-id | Next release |
|---|---|---|---|---|
| `67afd56` | `e56a93b449d8` | `62a5731` | `e56a93b449d8` | skipped, harmless |
| `aeb25f8` | `fdf7df10c5d8` | `8d0125d` | `be13108ebd0b` | **re-applies, conflicts** |

Both rows are from the single 0.29.0 release. The second diverged because that commit's release rebase **resolved a conflict**, so what landed on `main` is not the same patch as what `staging` still holds. Such an orphan re-conflicts on *every* subsequent release until someone drops it by hand. Confirmed in a controlled repro: identical patch-id → rebase skips the orphan and replays only the new work; divergent patch-id → the orphan replays and collides.

So the choice is not "rebase is broken" — it is that rebase makes correctness depend on patch-id de-duplication continuing to hold, while `--merge` removes the class outright. Feature branches keep using `--rebase` precisely because they are dead after merge and orphaning them is free.

**`--squash` is wrong for a further reason:** N commits collapse into one whose combined patch-id matches nothing, so a later replay re-applies all N. Measured historically: release PR #268 was squash-merged and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

### ArgoCD tracks `main`, not the `staging` branch

Worth knowing independently of merge strategy, because it explains why `staging.yml` writes to `main`:

| App | path | targetRevision |
|---|---|---|
| `nession` | `k8s/overlays/production` | `main` |
| `nession-staging` | `k8s/overlays/staging` | `main` |

The `staging` **branch** is not the deploy source for the staging **environment** — `staging.yml` builds on a push to `staging` but writes the overlay tag to `main`, and only that write reaches the cluster. Measured 2026-08-18: the `staging` branch's own overlay said `agent-67afd56` while the running staging pods were on `agent-aeb25f8`, the value from `main`. A consequence worth remembering: the overlay file on the `staging` branch is inert, so never "fix" a stale-looking tag there.

**If the release PR reports `mergeable: false`, do NOT back-merge `main` into `staging`.** Move the conflict onto a throwaway branch:

```bash
git checkout -b chore/release-<sha> origin/main
git cherry-pick <staging-commit>...          # resolve conflicts here
git push -u origin chore/release-<sha>
gh pr create --base main --head chore/release-<sha> --title "chore: release (...)" --body "..."
gh pr merge <PR-NUMBER> --rebase
```

Then sync step 5 as usual. Measured 2026-08-17: `staging → main` reported `mergeable: false` (conflict on `k8s/overlays/staging/kustomization.yaml`); `mergeable: false` blocks `--merge`, `--rebase` and `--squash` alike, so switching method never routes around a real conflict. The cherry-pick branch (PR #300) merged cleanly and `staging` was never touched. Under this flow the conflict should not arise at all — see the `k8s/overlays/**` rule below for the one thing that causes it.

**Verify before merging** that the release is actually mergeable:

```bash
gh pr view <PR> --json mergeable,mergeStateStatus
gh api repos/BestNathan/nession/pulls/<PR> --jq '{mergeable,rebaseable,mergeable_state}'
```

**`--squash` is wrong here for a second reason:** N commits collapse into one whose combined patch-id matches nothing, so a later replay re-applies all N. Measured historically: release PR #268 was squash-merged and the next release conflicted on `web/src/terminal/DeviceProfile.ts` — a file the offending PR never touched.

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

**But "none" means the release never reaches production.** 15 of `release.yml`'s 16 jobs carry `if: needs.version-check.outputs.version_changed == 'true'` — `version-check` is the only ungated job. The release PR itself changes no version file, so `version-check` reports `false` and everything downstream skips — no images, no GitHub Release, no `k8s/overlays/production` update, nothing for ArgoCD to sync. Measured on release PR #287: `version-check: success`, everything else `skipped`.

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

- Direct-to-main changes never pass through `staging`, so `staging` falls behind until the next sync. If `staging` has no unreleased work on it, sync immediately (`git push origin origin/main:refs/heads/staging` — a fast-forward, no PR needed); otherwise wait for the next release, which syncs it anyway. Note that a feature branch cut from `main` also carries `main`'s newer commits into `staging` when it merges, so the gap tends to close on its own.
- `.github/workflows/*` changes only take effect from the default branch, which is why they were already on this path. Note that `push`-triggered workflows use the workflow file *at the pushed commit*, so `staging.yml` behaviour on `staging` still reflects `staging`'s copy until `staging` is synced — a workflow fix merged to `main` does not change staging builds until the sync runs.

**⚠ Never put an empty commit on `staging`.** Empty commits have no patch-id, so nothing can de-duplicate them, and they ride into `main` on the release as noise. Use `gh workflow run` to trigger workflows, not `git commit --allow-empty`. Drop an existing one with `git rebase -i origin/staging`.

### Why `main` and `staging` diverge between releases

`staging.yml` writes `chore: update staging image tags` commits to **`main`**, not to `staging` (it checks out `ref: main` while running on a push to `staging`). So `main` gains a commit `staging` lacks after every staging build, and the two diverge between releases.

Those kustomize commits touch only `k8s/overlays/staging/kustomization.yaml`, while feature work touches `crates/` and `web/src/` — **disjoint paths, so the release does not conflict.** Verified 2026-08-18 by dry-running the release merge in the steady state (`staging` ahead by one feature commit, `main` ahead by one kustomize commit): clean.

That only holds while feature branches never carry a snapshot of the overlay file. **The overlay files under `k8s/overlays/**` are CI-owned on `main`; a feature branch must never touch them.** The 0.29.0 release conflict came from exactly that: a branch cut from `main` inherited a previous overlay bump and carried it into `staging`, where it then collided with `main`'s newer value.

| Step | Method | Effect |
|------|--------|--------|
| `feature → staging` | `--rebase` | Commits replayed individually, each keeping its own message. Orphans the (now dead) feature branch, which costs nothing. |
| `staging → main` | `--merge` | Records `staging`'s tip as a second parent, so `staging` stays an ancestor of `main`. No orphans. |
| `main → staging` sync | fast-forward push | Possible only because the release used a merge commit. Never force-push. |

After the sync the refs are identical, and the next staging build puts `main` exactly 1 commit ahead again. That is the expected steady state.

### Branch base

A PR's diff is computed against `merge-base(base, head)`. Branching everything off `main` is correct **because the post-release sync keeps `main` from falling behind `staging`** — right after a release the two refs are identical, so "off `main`" and "off `staging`" are the same commit.

Skip the sync and that stops being true: `main` starts missing unreleased work, and a branch cut from `main` lacks code it needs. Measured — with a feature on `staging` but not yet released, a follow-up fix branched from `main` **conflicts**, while the same fix branched from `origin/staging` applies cleanly as a single commit. So the one exception is:

> Follow-up work on code that is on `staging` but not yet released → branch off `origin/staging`.

The reverse mistake still applies in the other direction: a branch cut from `main` but targeting `staging` while `main` is *ahead* drags every extra commit into `staging`. Measured: a `docs/**` branch cut from `main` dragged 5 of `main`'s commits into `staging`. The sync is what prevents this. (Those dragged commits are de-duplicated at the release, so they are noise in review rather than a correctness problem.)

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

**The PR body is review material, not git history.** Under rebase-merge it is never written to a commit — each replayed commit keeps its own message (measured: PR #301 → `673664f`). Still keep the body a change record — 变更内容 + 测试报告, plus `Closes #N` on the release PR — because it is what a reviewer and the release audit read. Screenshots go in a PR comment (`gh pr comment`) rather than the body, now purely so the body stays scannable.

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

**After staging validation**, open the release PR (`staging` → `main`, merged with `--merge`), bump the version if warranted, then sync `main` → `staging` last. The `release.yml` workflow then:
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
