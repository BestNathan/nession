---
name: nession-development
description: Use when developing Nession features, writing or running tests, deciding how to bump versions (minor vs patch), creating pull requests, or onboarding to the Nession development workflow
---

# Nession Development

## Overview

Monorepo (Rust workspace + React web UI). Develop locally with `cargo run`/`npm run dev`, test with `cargo test`, version bump in `Cargo.toml` + `web/package.json`, submit changes via PR. Never build Docker images locally — CI handles that.

**⚠ Before ANY development work, verify you are NOT on `main`:**

```bash
git branch --show-current   # must NOT show "main"
```

If on `main`, create a feature branch immediately. **Never commit to main.**

## 1. Local Development

Three terminals, from repo root:

```bash
# Terminal 1 — server (WebSocket :19090, HTTP :10080)
cargo run -p nession-server

# Terminal 2 — agent (needs tmux on the host)
cargo run -p nession-agent

# Terminal 3 — web UI (Vite dev server :13000, proxies /ws → :19090)
cd web && npm run dev
```

The UI is at `http://localhost:13000`.

```bash
cargo build                    # All Rust crates
cd web && npm run build        # Production web build → web/dist/
cargo fmt -- --check           # Check formatting
cargo clippy -- -D warnings    # Lint
cd web && npx tsc --noEmit     # TypeScript check
cd web && npm run lint         # ESLint
```

## 2. Tests

Rust unit tests go in `#[cfg(test)]` modules inside `src/` or standalone files under `crates/*/tests/`. All async, using `#[tokio::test]`. Web uses `tsc --noEmit` + `eslint` as quality gates (no test runner).

```bash
cargo test                  # All tests (unit + integration)
cargo test -p nession-server  # Single crate
cargo test --test '*'       # Integration tests only
```

### Testing Gates

Before merging any PR, these MUST pass:

| Gate | Command | Threshold |
|------|---------|-----------|
| Unit + integration tests | `cargo test` | 100% pass |
| Coverage (Rust) | `cargo tarpaulin --out Html` | **≥ 90%** line coverage |
| Clippy (no allow) | `cargo clippy -- -D warnings` | 0 warnings, **zero** `#[allow]` |
| Formatting | `cargo fmt -- --check` | clean |
| Web unit tests | `cd web && npm test` | 100% pass |
| Web coverage | `cd web && npm run coverage` | **≥ 80%** line coverage |
| TypeScript | `cd web && npx tsc --noEmit` | 0 errors |
| ESLint | `cd web && npm run lint` | 0 warnings |
| Build | `cd web && npm run build` | success |

Coverage is enforced per-crate. New code must maintain or improve coverage — PRs that drop coverage below 90% are rejected.

```bash
# Install tarpaulin (once)
cargo install cargo-tarpaulin

# Run coverage
cargo tarpaulin --out Html --output-dir target/tarpaulin
```

### Test Database

Integration tests use SQLite with unique temporary databases. Each test MUST clean up its own DB file:

```rust
let db_path = format!("./test_{}.db", uuid::Uuid::new_v4());
// ... run test ...
std::fs::remove_file(&db_path).ok();
```

## 3. Version Bumping

Single version across all components. `Cargo.toml` and `web/package.json` must always agree.

| Change | Bump | Example |
|--------|------|---------|
| New feature, behavior change | Minor | `0.3.1` → `0.4.0` |
| Bug fix, small tweak | Patch | `0.3.1` → `0.3.2` |

**When in doubt, choose patch.** Both files must be updated:

```toml
# Cargo.toml
version = "0.4.0"
```

```json
// web/package.json
"version": "0.4.0"
```

On merge to main, CI reads the version from these files and creates version-tagged Docker images automatically.

## 4. Creating a Pull Request

**Never push directly to main.** Always use a feature branch + PR.

### PR Workflow

Before creating a PR, **always check** whether the current branch already has an open PR:

```bash
# List open PRs for the current branch
gh pr list --head "$(git branch --show-current)" --state open --json number,title,url
```

**If an open PR already exists** for the current branch → update it with `gh pr edit`:

```bash
gh pr edit <PR-NUMBER> --title "..." --body "..."
```

**If no open PR exists** → create a new one:

```bash
git push origin <branch-name>
gh pr create --title "feat: description" --body "..."
```

### PR Body Template

Every PR must include these three sections:

```markdown
## 变更内容
- [简述改了什么]

## 测试报告
- `cargo test`: <N> passed, 0 failed
- `cargo tarpaulin`: <X>% coverage (threshold: 90%)
- `cargo fmt --all -- --check`: OK
- `cargo clippy -- -D warnings`: 0 errors
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: 0 warnings
- `npm run build`: success

## 核心功能截图
<!-- 贴截图，证明功能正常 -->
```

CI triggers on merge to main — builds multi-arch Docker images, pushes tags, updates k8s manifests. No manual steps after merge.

## Quick Reference

| Task | Command |
|------|---------|
| Run all tests | `cargo test` |
| Coverage | `cargo tarpaulin --out Html` |
| TypeScript | `cd web && npx tsc --noEmit` |
| Web build | `cd web && npm run build` |
| Start server | `cargo run -p nession-server` |
| Start UI dev | `cd web && npm run dev` |
| Version bump | Edit `Cargo.toml` + `web/package.json` |
| Create PR | `gh pr create --title "feat: ..." --body "..."` |

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| Committing on `main` directly | **FORBIDDEN.** Always `git checkout -b feat/<slug>` first. Verify with `git branch --show-current`. |
| `docker build` for Nession | **Forbidden.** CI does that. |
| Pushing to main directly | Always use a feature branch + PR. |
| Bumping only one version file | Both `Cargo.toml` and `web/package.json` must match. |
| Forgetting `cargo fmt`/`cargo clippy` before push | CI may reject the PR. |
| Integration tests leaving temp DB files | Each test must clean up its own DB. |
| PR missing test report or screenshots | All three sections are required. |
| `#[allow(clippy::*)]` in Rust | **FORBIDDEN.** Every clippy lint must be fixed properly. |
