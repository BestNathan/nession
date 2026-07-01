---
name: nession-development
description: Use when developing Nession features, writing or running unit tests, setting up integration tests, deciding how to bump versions (minor vs patch), creating pull requests, or onboarding to the Nession development workflow
---

# Nession Development

## Overview

Monorepo (Rust workspace + React web UI). Develop locally with `cargo run`/`npm run dev`, test with `cargo test`/`tsc`, version bump with the nession-cicd skill, and submit changes via PR. Never build Docker images locally — CI handles that.

## 1. Local Development

### Start the stack

Three terminals, from repo root:

```bash
# Terminal 1 — server (WebSocket :19090, HTTP :10080)
cargo run -p nession-server

# Terminal 2 — agent (needs tmux on the host)
cargo run -p nession-agent

# Terminal 3 — web UI (Vite dev server :13000, proxies /ws → :19090)
cd web && npm run dev
```

The UI is at `http://localhost:13000`. Vite proxies WebSocket connections to the server.

### Build everything

```bash
cargo build                    # All Rust crates
cd web && npm run build        # Production web build → web/dist/
```

### Useful commands

```bash
cargo check                    # Fast compile check (no codegen)
cargo fmt -- --check           # Check formatting
cargo clippy -- -D warnings    # Lint
cd web && npx tsc --noEmit     # TypeScript check
cd web && npm run lint         # ESLint
```

## 2. Unit Tests

### Rust

Unit tests use `#[cfg(test)]` modules inside `src/` or standalone `tests/` files. All async tests use `#[tokio::test]`.

**Run all tests:**
```bash
cargo test                     # Entire workspace
```

**Run a single crate:**
```bash
cargo test -p nession-server
cargo test -p nession-agent
cargo test -p nession-common
cargo test -p nession-cli
```

**Run a single test:**
```bash
cargo test -p nession-server test_generate_connection_token
cargo test -p nession-server broker_test
```

**Write a unit test** (inline `#[cfg(test)]` module):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_my_function() {
        let result = my_function("input");
        assert_eq!(result, expected);
    }
}
```

**Write an integration test** (in `tests/` directory, tests the public API):
```rust
// crates/nession-server/tests/my_test.rs
use nession_server::some_module::SomeType;

#[tokio::test]
async fn test_end_to_end_flow() {
    let server = start_test_server().await;
    let client = connect_client(server.addr).await;
    // ... test the full flow ...
}
```

### Web (React)

No test runner configured. Use TypeScript + ESLint + build as quality gates:

```bash
cd web
npx tsc --noEmit              # Type errors = test failure
npm run lint                  # Lint errors = test failure
npm run build                 # Build errors = test failure
```

## 3. Integration Testing

Integration tests live in `crates/*/tests/`. They spin up real servers, connect real WebSocket clients, and exercise full flows.

### Server integration tests

`crates/nession-server/tests/integration_test.rs` — starts a server on a random port, connects via WebSocket, tests auth/agent-registration/session-lifecycle.

```bash
cargo test -p nession-server --test integration_test
```

### WebSocket tests

`crates/nession-server/tests/websocket_test.rs` — tests WebSocket connection lifecycle, message serialization, error handling.

```bash
cargo test -p nession-server --test websocket_test
```

### Agent E2E tests

`crates/nession-agent/tests/e2e_test.rs` — full agent flow (needs tmux on the host).

```bash
# Requires tmux installed
cargo test -p nession-agent --test e2e_test
```

### Running all integration tests

```bash
# All crates, all tests (unit + integration)
cargo test

# Integration tests only (skip unit tests)
cargo test --test '*'
```

### Test database

Integration tests use SQLite with temporary databases. Each test creates its own DB file:

```rust
let db_path = format!("./test_{}.db", uuid::Uuid::new_v4());
// ... run test ...
std::fs::remove_file(&db_path).ok(); // cleanup
```

## 4. Version Bumping

Single version across all components: `Cargo.toml` + `web/package.json` must match.

| Change | Bump | Example |
|--------|------|---------|
| New feature, behavior change | Minor | `0.3.1` → `0.4.0` |
| Bug fix, small tweak | Patch | `0.3.1` → `0.3.2` |

**When in doubt, choose patch.** Files to update:

```bash
# Edit Cargo.toml
version = "0.4.0"

# Edit web/package.json
"version": "0.4.0"
```

For the full version bump workflow (including CI image tagging implications), use the nession-cicd skill: `.claude/skills/nession-cicd/SKILL.md`.

## 5. Creating a Pull Request

```bash
# 1. Create feature branch
git checkout -b feat/my-feature

# 2. Make changes, commit
git add -A
git commit -m "feat: description of change"

# 3. Verify before pushing
cargo test && cargo clippy -- -D warnings
cd web && npx tsc --noEmit && npm run lint && npm run build && cd ..

# 4. Push
git push origin feat/my-feature

# 5. Create PR
gh pr create \
  --title "feat: description" \
  --body "## Summary
- Change 1
- Change 2

## Test Plan
- [ ] cargo test passes
- [ ] web build passes
- [ ] Manual verification on dev server"
```

**Never push directly to main.** All changes go through PRs. CI triggers on merge — no manual Docker builds or k8s deploys needed.

## Quick Reference

| Task | Command |
|------|---------|
| Run all tests | `cargo test` |
| Run one crate | `cargo test -p nession-server` |
| Run one test | `cargo test -p nession-server test_name` |
| Integration tests | `cargo test --test '*'` |
| TypeScript check | `cd web && npx tsc --noEmit` |
| Web build | `cd web && npm run build` |
| Start server | `cargo run -p nession-server` |
| Start UI dev | `cd web && npm run dev` |
| Create PR | `gh pr create --title "feat: ..." --body "..."` |
| Version bump | Edit `Cargo.toml` + `web/package.json` |

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `docker build` for Nession | **Forbidden.** CI does that. |
| Pushing to main directly | Always use a feature branch + PR. |
| Bumping only Cargo.toml or only package.json | Both files must agree on version. |
| Running `cargo test` with wrong working directory | Always run from repo root. |
| Forgetting to run `cargo fmt` / `cargo clippy` before push | CI may reject the PR. |
| Writing integration tests that don't clean up temp DBs | Use unique names, clean up in the test. |
