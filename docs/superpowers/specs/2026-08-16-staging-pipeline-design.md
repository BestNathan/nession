# Staging Branch CI/CD Pipeline Design

## Problem

Current CI/CD pipeline triggers on every `feat/**` and `fix/**` push, builds Docker images, and updates staging kustomize directly on `main`. This means:

1. Every feature branch push immediately deploys to staging — no integration testing between features
2. Multiple features can't be validated together on staging before release
3. No clear separation between "quality gate for merging" and "deployment to staging"

## Solution

Introduce a three-workflow pipeline with a `staging` integration branch:

```
feat/fix ──PR──▶ staging          (quality.yml: rust-check + web-check)
                    │ merge
                    ▼
               staging branch      (staging.yml: build → docker → deploy staging)
                    │ 验收通过
                    ▼
               PR: staging → main  (手动 + version bump)
                    │ merge
                    ▼
               main branch         (release.yml: build → docker → release → deploy prod)
```

Multiple feature branches can merge to staging independently, be validated together, then batch-release to production.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Kustomize overlay 管理 | staging 和 production overlay 都在 `main` 分支 | 集中管理，staging workflow checkout main 来更新 staging overlay |
| quality gate 实现 | 独立 `quality.yml` 文件 | 职责清晰，branch protection 配置简单 |
| PR 方向 | feat/fix → staging → main，顺序固定 | 所有功能先在 staging 集成验收，再批量发布 |
| staging → main 合并方式 | 手动 PR（含 version bump） | 人工控制发布节奏 |
| workflow 变更的部署方式 | chore 分支直接合入 main | GitHub Actions 从 default branch 读取 workflow，变更必须先到 main 才生效 |

## Workflow Files

### 1. quality.yml (新建)

**触发条件:** `pull_request` targeting `staging` 分支

**Jobs:**
- `rust-check` — 和当前 cicd.yml 的 rust-check 完全相同
- `web-check` — 和当前 cicd.yml 的 web-check 完全相同

**用途:** GitHub branch protection required check。PR 必须通过 quality gate 才能合并到 staging。

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

### 2. staging.yml (cicd.yml 重命名 + 改 trigger)

**触发条件:** `push` to `staging` 分支

**和当前 cicd.yml 的差异:**

| 项目 | 当前 | 改后 |
|------|------|------|
| `name` | `CI/CD` | `Staging` |
| `on.push.branches` | `['feat/**', 'fix/**']` | `['staging']` |

**其他所有 jobs 保持不变:**
- versions → build-web + build-amd64 + build-arm64 → docker × 6 → merge → update-staging-kustomize → cleanup-ghcr
- `update-staging-kustomize` 仍然 checkout `main` 并 commit 到 `main`（带 `[skip ci]`）
- 镜像 tag 继续用 `sha-<short-sha>` 格式

### 3. release.yml (不变)

**触发条件:** `push` to `main`

**确认:** 当前 release.yml 只修改 `k8s/overlays/production/kustomization.yaml`，不涉及 staging overlay。满足 "release 不修改 staging 镜像" 的要求。

**`[skip ci]` 安全性:** staging.yml 向 main 提交 staging kustomize 更新时带 `[skip ci]`，不会触发 workflow。此外 release.yml 本身有 `version_changed` gate，即使触发也不会执行实际 build/deploy。

## Branch Protection Rules (GitHub Settings)

### staging 分支

- Require pull requests before merging
- Required status checks: `Quality Gate` (quality.yml workflow)
- Allow squash merge

### main 分支

- 保持现有设置不变

## Files to Modify

| File | Change |
|------|--------|
| `.github/workflows/quality.yml` | 新建 |
| `.github/workflows/staging.yml` | 从 cicd.yml 重命名，改 name 和 trigger |
| `.github/workflows/cicd.yml` | 删除（已重命名为 staging.yml） |
| `CLAUDE.md` | 更新 Development Workflow 中的 PR 目标和 CI 描述 |
| `.claude/skills/nession-cicd/SKILL.md` | 更新为三阶段 pipeline 描述 |
| `.claude/skills/nession-development/SKILL.md` | 更新 PR 目标、分支策略、auto-merge 说明 |

## Deployment Strategy

本次变更涉及 workflow 文件修改。根据已有规则——"workflow 变更必须独立合入 main 才能生效"——实施策略为：

1. 在 `chore/staging-pipeline` 分支上完成所有变更
2. 直接 PR 到 `main`（不走 staging 流程，因为这是 pipeline 基础设施变更）
3. 合并后立即生效

## Rollback

如需回退到旧流程：
1. 恢复 `cicd.yml`（删除 staging.yml + quality.yml）
2. 恢复 CLAUDE.md 和 skill 文件
3. 通过 chore 分支合入 main
