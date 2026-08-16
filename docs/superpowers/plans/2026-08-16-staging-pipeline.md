# Staging Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure CI/CD into a three-workflow pipeline (quality -> staging -> release) with a `staging` integration branch so multiple features can be validated together before batch-releasing to production.

**Architecture:** `quality.yml` gates PRs to `staging` (rust-check + web-check). `staging.yml` builds and deploys on push to `staging`. `release.yml` is unchanged (builds and releases on push to `main`). Both staging and production kustomize overlays remain on `main`, updated by their respective workflows.

**Tech Stack:** GitHub Actions YAML, kustomize, Docker, GHCR

**Spec:** `docs/superpowers/specs/2026-08-16-staging-pipeline-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `.github/workflows/quality.yml` | PR quality gate for staging (rust-check + web-check) |
| Rename + Edit | `.github/workflows/cicd.yml` -> `.github/workflows/staging.yml` | Full build + deploy on staging push |
| Update | `CLAUDE.md` | PR targets, workflow descriptions |
| Update | `.claude/skills/nession-cicd/SKILL.md` | Three-stage pipeline documentation |
| Update | `.claude/skills/nession-development/SKILL.md` | PR flow, branch strategy, auto-merge |
| No change | `.github/workflows/release.yml` | Already correct (only modifies production overlay) |

---

### Task 1: Create quality.yml

**Files:**
- Create: `.github/workflows/quality.yml`

- [ ] **Step 1: Create the quality gate workflow**

Write the following content to `.github/workflows/quality.yml`:

```yaml
name: Quality Gate

on:
  pull_request:
    branches: [staging]

jobs:
  rust-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with: { cache-workspaces: ".", cache-all-crates: "true" }
      - uses: extractions/setup-just@v2
      - run: jq --version
      - uses: actions/cache@v4
        with:
          path: ~/.cargo/bin/cargo-llvm-cov
          key: cargo-llvm-cov-v1
      - run: which cargo-llvm-cov || cargo install cargo-llvm-cov
      - run: rustup component add llvm-tools-preview
      - run: just check

  web-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
          cache-dependency-path: web/package-lock.json
      - uses: extractions/setup-just@v2
      - run: cd web && npm ci
      - run: just web-lint
      - run: just web-test
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `head -5 .github/workflows/quality.yml`
Expected output:
```
name: Quality Gate

on:
  pull_request:
    branches: [staging]
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/quality.yml
git commit -m "feat: add quality gate workflow for staging PRs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Rename cicd.yml to staging.yml and update trigger

**Files:**
- Rename: `.github/workflows/cicd.yml` to `.github/workflows/staging.yml`
- Edit: `.github/workflows/staging.yml` (line 1: name, line 5: trigger branches)

- [ ] **Step 1: Rename the file**

```bash
git mv .github/workflows/cicd.yml .github/workflows/staging.yml
```

- [ ] **Step 2: Change workflow name**

In `.github/workflows/staging.yml`, replace line 1:

Replace this string:
```
name: CI/CD
```

With:
```
name: Staging
```

- [ ] **Step 3: Change trigger branch**

In `.github/workflows/staging.yml`, replace line 5:

Replace this string:
```
    branches: ['feat/**', 'fix/**']
```

With:
```
    branches: ['staging']
```

- [ ] **Step 4: Verify the changes**

Run: `head -6 .github/workflows/staging.yml`
Expected:
```
name: Staging

on:
  push:
    branches: ['staging']
```

Run: `ls .github/workflows/`
Expected: `quality.yml  release.yml  staging.yml` (no `cicd.yml`)

Run: `diff <(git show HEAD:.github/workflows/cicd.yml | head -6) <(head -6 .github/workflows/staging.yml)`
Expected: Only lines 1 and 5 differ.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: rename cicd.yml to staging.yml, trigger on staging branch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Three sections need updating. Use `grep -n` to find exact line numbers before editing.

- [ ] **Step 1: Update "CI 触发" line in Quality Gates section**

Find the line:
```
- **CI 触发**：push `feat/**` / `fix/**`。`rust-check`（fmt + clippy + test）+ `web-check`（lint + tsc + test）。与 pre-commit 必须一致。
```

Replace with:
```
- **CI 触发**：三个 workflow 分工。`quality.yml`（PR -> staging：rust-check + web-check）；`staging.yml`（push to staging：完整 build + deploy）；`release.yml`（push to main：release）。与 pre-commit 必须一致。
```

- [ ] **Step 2: Update the PUBLISH step in Development Cycle**

Find the block starting with `# 3. PUBLISH` through `# 4. MERGE`. Replace:

Find:
```
# 3. PUBLISH — push and create PR (include `Closes #<ISSUE>` in body) → CI runs docker-publish
git push -u origin feat/<slug>
gh pr create --title "feat: <description>" --body "..."

# 4. MERGE — after review, merge to main (CI auto-publishes images)
#    For feat/** branches, use auto-merge to merge automatically when CI checks pass:
gh pr merge <PR-NUMBER> --auto --squash

#    CI will automatically merge the PR once all checks pass
```

Replace with:
```
# 3. PUBLISH — push and create PR targeting **staging** (include `Closes #<ISSUE>` in body)
git push -u origin feat/<slug>
gh pr create --base staging --title "feat: <description>" --body "..."

# 4. MERGE to staging — quality gate (rust-check + web-check) must pass
#    For feat/** branches, use auto-merge to merge automatically when checks pass:
gh pr merge <PR-NUMBER> --auto --squash

#    CI builds and deploys to staging automatically after merge
```

- [ ] **Step 3: Update the VERSION BUMP and RETURN steps**

Find the block starting with `# 5. VERSION BUMP` through `# 6. RETURN`. Replace:

Find:
```
# 5. VERSION BUMP — create a separate branch from main for version bump
git checkout main && git pull
git checkout -b chore/bump-version
# Edit Cargo.toml and web/package.json to bump version
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push origin chore/bump-version
gh pr create --title "chore: bump version to X.Y.Z" --body "Version bump"
# chore/** branches don't trigger CI, so merge directly (no --auto needed)
gh pr merge <PR-NUMBER> --squash

# 6. RETURN — back to main, pull merged result. OLD BRANCH IS DEAD.
git checkout main
git pull
```

Replace with:
```
# 5. VERSION BUMP + RELEASE — after staging validation, bump version and merge staging to main
git checkout main && git pull
git checkout -b chore/bump-version
# Edit Cargo.toml and web/package.json to bump version
git add -A && git commit -m "chore: bump version to X.Y.Z"
git push origin chore/bump-version
# Merge staging into main (brings all validated features)
git merge staging
git push
gh pr create --title "chore: bump version to X.Y.Z" --body "Version bump + staging merge"
# chore/** branches don't trigger CI, so merge directly (no --auto needed)
gh pr merge <PR-NUMBER> --squash

# 6. RETURN — back to main, pull merged result. OLD BRANCH IS DEAD.
git checkout main
git pull
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for staging pipeline

- PRs now target staging branch (not main)
- Three workflows: quality, staging, release
- Version bump includes merging staging to main

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update nession-cicd skill

**Files:**
- Modify: `.claude/skills/nession-cicd/SKILL.md`

- [ ] **Step 1: Update Overview section**

Find:
```
**CI builds images. You don't.** Development happens locally. CI triggers on merge to main. ArgoCD deploys to k8s.

```
Local dev → cargo run / npm run dev → verify locally
  → version bump (minor 0.x.0 or patch 0.x.y)
  → push branch → create PR → merge to main
  → CI builds multi-arch images → ArgoCD syncs to k8s
```
```

Replace with:
```
**CI builds images. You don't.** Development happens locally. Three workflows handle deployment:
- **Quality Gate** (`quality.yml`): PR to staging triggers rust-check + web-check
- **Staging** (`staging.yml`): merge to staging triggers full build + deploy to staging
- **Release** (`release.yml`): merge to main triggers release build + deploy to production

```
Local dev → verify locally
  → push branch → PR to staging → quality gate passes → merge to staging
  → staging builds + deploys to staging environment → validate on staging
  → version bump (minor 0.x.0 or patch 0.x.y) → merge staging to main
  → release builds multi-arch images → ArgoCD syncs to production
```
```

- [ ] **Step 2: Update "Push and create PR" section**

Find:
```
```bash
git checkout -b feat/description
git add -A
git commit -m "feat: description"
git push origin feat/description
gh pr create --title "feat: description" --body "..."
```

**Do NOT push directly to main.** All changes go through PRs.
```

Replace with:
```
```bash
git checkout -b feat/description
git add -A
git commit -m "feat: description"
git push origin feat/description
gh pr create --base staging --title "feat: description" --body "..."
```

**Do NOT push directly to main or staging.** All changes go through PRs targeting `staging`.
```

- [ ] **Step 3: Update "Merge triggers CI" section**

Find the section starting with `### 4. Merge triggers CI`. Replace:

Find:
```
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
```

Replace with:
```
### 4. Merge to staging triggers build + deploy

When the PR is merged to staging, GitHub Actions (`staging.yml`) automatically:
1. Reads versions from `Cargo.toml` + `package.json` and computes the short git hash
2. Builds web UI (`npm ci && npm run build`)
3. Builds Rust binaries natively for amd64 AND arm64
4. Creates multi-arch Docker images tagged with **hash** (`server-{sha}`, `agent-{sha}`, `ui-{sha}`)
5. Updates `k8s/overlays/staging/kustomization.yaml` on main with hash-based image tags (commit with `[skip ci]`)
6. ArgoCD detects the kustomize change and syncs to staging k8s

**After staging validation**, create a version bump branch from main, merge staging into it, and PR to main. The `release.yml` workflow then:
1. Builds version-tagged Docker images (`server-{version}`, `agent-{version}`, `ui-{version}`)
2. Creates GitHub Release with native binaries
3. Updates `k8s/overlays/production/kustomization.yaml` with version-based image tags
4. ArgoCD syncs to production k8s

**No manual steps after merge.** CI → ArgoCD is fully automatic.
```

- [ ] **Step 4: Update Key Files table**

Find:
```
| File | Purpose |
|------|---------|
| `Cargo.toml` | Workspace version (Rust binaries) |
| `web/package.json` | Web UI version |
| `.github/workflows/docker-publish.yml` | CI pipeline |
| `k8s/kustomization.yaml` | Image tag mapping (auto-updated by CI) |
```

Replace with:
```
| File | Purpose |
|------|---------|
| `Cargo.toml` | Workspace version (Rust binaries) |
| `web/package.json` | Web UI version |
| `.github/workflows/quality.yml` | PR quality gate (rust-check + web-check) |
| `.github/workflows/staging.yml` | Staging build + deploy (push to staging) |
| `.github/workflows/release.yml` | Release build + deploy (push to main) |
| `k8s/overlays/staging/kustomization.yaml` | Staging image tags (auto-updated by staging.yml) |
| `k8s/overlays/production/kustomization.yaml` | Production image tags (auto-updated by release.yml) |
```

- [ ] **Step 5: Update CI Pipeline Architecture section**

Find:
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
```

Replace with:
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
```

- [ ] **Step 6: Update auto-merge section**

Find:
```
**When to use auto-merge:**
- Branch is `feat/**` or `fix/**` (triggers CI workflow)
```

Replace with:
```
**When to use auto-merge:**
- Branch is `feat/**` or `fix/**` with PR targeting `staging` (triggers quality gate)
```

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/nession-cicd/SKILL.md
git commit -m "docs: update nession-cicd skill for staging pipeline

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update nession-development skill

**Files:**
- Modify: `.claude/skills/nession-development/SKILL.md`

- [ ] **Step 1: Update "Iron Law: Branch Naming" section**

Find:
```
**CI 触发规则：** `.github/workflows/cicd.yml` 只触发 `feat/**` 和 `fix/**` 分支。
```

Replace with:
```
**CI 触发规则：** `.github/workflows/quality.yml` 在 PR 目标为 `staging` 时触发；`.github/workflows/staging.yml` 在 push 到 `staging` 分支时触发。feat/fix 分支的 PR 必须目标为 `staging`。
```

- [ ] **Step 2: Update Development Cycle section header**

Find:
```
## 5. Development Cycle

**main 只读 → 创建 worktree → 开发 → PR → 合并 → 清理 worktree → 旧 worktree 已死 → 重复**
```

Replace with:
```
## 5. Development Cycle

**main 只读 → 创建 worktree → 开发 → PR → staging 验收 → 合并到 main 发布 → 清理 worktree → 旧 worktree 已死 → 重复**
```

- [ ] **Step 3: Update STEP 4 in Development Cycle**

Find:
```
# STEP 4: Push and create PR
git push -u origin feat/<slug>
gh pr create --title "feat: <description>" --body "..."
```

Replace with:
```
# STEP 4: Push and create PR targeting staging
git push -u origin feat/<slug>
gh pr create --base staging --title "feat: <description>" --body "..."
```

- [ ] **Step 4: Update PR Workflow auto-merge section**

Find:
```
**Auto-merge prerequisites:**
- Branch is `feat/**` or `fix/**` (triggers CI workflow)
- All CI checks are expected to pass (rust-check, web-check, builds)
- PR is ready for review (no draft)
```

Replace with:
```
**Auto-merge prerequisites:**
- Branch is `feat/**` or `fix/**` with PR targeting `staging`
- Quality gate checks are expected to pass (rust-check, web-check)
- PR is ready for review (no draft)
```

- [ ] **Step 5: Update version bump section**

Find:
```
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
```

Replace with:
```
```bash
# After staging validation passes
git checkout main && git pull
git checkout -b chore/bump-version
# Bump version in Cargo.toml and web/package.json
git add -A && git commit -m "chore: bump version to X.Y.Z"
# Merge staging into main (brings all validated features)
git merge staging
git push
gh pr create --title "chore: bump version to X.Y.Z" --body "Version bump + staging merge"
gh pr merge <PR-NUMBER> --squash  # Direct merge, no CI needed
```
```

- [ ] **Step 6: Update "PR Body Template" CI trigger line**

Find:
```
CI triggers on merge to main — builds multi-arch Docker images, pushes tags, updates k8s manifests. No manual steps after merge.
```

Replace with:
```
Quality gate triggers on PR to staging. After merge to staging, CI builds Docker images, pushes hash tags, updates staging kustomize. After staging validation and merge to main (with version bump), release workflow builds version-tagged images and updates production kustomize.
```

- [ ] **Step 7: Update deploy-watch reference**

Find:
```
**Monitor deployment:** Use `./scripts/deploy-watch.sh staging` after pushing a branch, or `./scripts/deploy-watch.sh prod` after merging to main. See `nession-cicd` skill for details.
```

Replace with:
```
**Monitor deployment:** Use `./scripts/deploy-watch.sh staging` after merging PR to staging, or `./scripts/deploy-watch.sh prod` after merging to main. See `nession-cicd` skill for details.
```

- [ ] **Step 8: Update "Common Mistakes" table**

Find:
```
| **Committing on `main` directly** | **FORBIDDEN.** main 是只读的。所有开发必须在 worktree 中进行。 |
```

Replace with:
```
| **Committing on `main` directly** | **FORBIDDEN.** main 是只读的。所有开发必须在 worktree 中进行。 |
| **PR 直接提交到 main** | **FORBIDDEN.** feat/fix PR 必须提交到 staging。只有 staging -> main 的发布 PR 才直接提交到 main。 |
```

- [ ] **Step 9: Commit**

```bash
git add .claude/skills/nession-development/SKILL.md
git commit -m "docs: update nession-development skill for staging pipeline

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Final commit and PR

- [ ] **Step 1: Verify all changes**

```bash
git log --oneline -6
```

Expected: 6 commits (spec + 5 tasks).

```bash
ls .github/workflows/
```

Expected: `quality.yml  release.yml  staging.yml`

```bash
git diff main --stat
```

Expected: 5 files changed (quality.yml new, cicd.yml deleted, staging.yml new, CLAUDE.md modified, 2 skill files modified).

- [ ] **Step 2: Push and create PR**

```bash
git push -u origin chore/staging-pipeline
gh pr create --title "chore: restructure CI/CD into staging pipeline" --body "## Changes

- Rename cicd.yml to staging.yml (trigger: staging branch)
- Add quality.yml (PR gate for staging: rust-check + web-check)
- Update CLAUDE.md and skills for new PR flow (feat/fix -> staging -> main)

## Post-merge actions needed

After merging to main, configure GitHub branch protection for staging:
- Require PRs before merging
- Required status checks: Quality Gate
- Allow squash merge"
```

---

## Post-Merge Actions (Manual)

After the PR is merged to main, configure branch protection:

1. Go to GitHub repo Settings -> Branches -> Branch protection rules
2. Add rule for `staging` branch:
   - Require a pull request before merging
   - Required status checks: search for "Quality Gate" and select it
   - Allow squash merges
3. Verify existing `main` branch protection is unchanged
