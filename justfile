# Use sccache for faster Rust compilation if installed (brew install sccache).
# Empty string → cargo ignores the wrapper, no-op if sccache is missing.
export RUSTC_WRAPPER := `which sccache 2>/dev/null || echo ""`

# ── Rust ────────────────────────────────────────────────────────────────────

# Format check (fast, safe to run on every commit)
fmt:
    cargo fmt --all -- --check

# Clippy strict mode — must pass with 0 warnings.
# --all-targets so test code is linted too; without it #[cfg(test)] modules and
# tests/ are skipped entirely.
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# Unit tests only (pre-commit)
test-unit:
    ./scripts/filtered-test.sh --lib

# Integration tests only (pre-push)
test-integration:
    ./scripts/filtered-test.sh --test integration

# Full test suite (unit + integration)
test: test-unit test-integration

# Per-crate coverage check against thresholds
coverage:
    ./scripts/check-coverage.sh

# Fast pre-commit checks (fmt + clippy)
quick: fmt lint

# Full CI checks (fmt + lint + tmux-socket gate + coverage — coverage runs all tests)
check: fmt lint check-tmux-socket coverage

# ── Design tokens + UI contracts ────────────────────────────────────────────

tokens-gen:
    node design/scripts/generate-tokens.mjs

tokens-check:
    node design/scripts/generate-tokens.mjs --check

# UI contract unit tests (node --test; tokens + contracts + inventory helpers)
design-test:
    node --test design/scripts/*.test.mjs

contracts-gen:
    node design/scripts/resolve-contracts.mjs

contracts-check:
    node design/scripts/resolve-contracts.mjs --check

# Human-readable evidence report for #760. This is an audit view, not design truth.
design-inventory:
    node design/scripts/audit-design-system.mjs

# Machine-readable form for follow-up analysis/tooling.
design-inventory-json:
    node design/scripts/audit-design-system.mjs --json

# Deterministic inventory integrity check used by Web CI.
design-inventory-check:
    node design/scripts/audit-design-system.mjs --check

check-design-tokens:
    ./scripts/check-design-tokens.sh

# ── Canonical design gate (#759) ────────────────────────────────────────────
# One implementation, three entry points: manual/Agent, git hooks, CI. Hooks
# and CI call `design-check` rather than listing design steps themselves, so
# the three cannot drift into three different rule sets. See the header of
# scripts/design-check.sh for the layers and why they are shaped this way.

# The gate. This is what a developer, an Agent, and CI all run.
design-check:
    ./scripts/design-check.sh

# Print the gate's layers without running them.
design-check-list:
    ./scripts/design-check.sh --list

# ESLint over web/src — design rules ride on the repo config (see design-check.sh)
web-eslint:
    cd web && npx eslint . --report-unused-disable-directives --max-warnings 0

# Fault fixtures: prove each design rule still FAILS on what it claims to catch
design-rule-fixtures:
    node --test web/eslint-plugin-nession/__tests__/*.test.js

check-design-tokens-selftest:
    ./scripts/check-design-tokens-selftest.sh

# ── Web ─────────────────────────────────────────────────────────────────────

# Lint + type-check (fast, pre-commit).
# Depends on design-check rather than repeating its steps: token/contract/
# inventory sync and the ESLint pass are the design gate's job, and `eslint .`
# runs the same config either way. Type-checking is web-specific and stays here.
web-lint: design-check
    cd web && npx tsc --noEmit

# All web tests (unit + integration)
web-test: web-test-unit web-test-integration

# Unit tests only (pure logic, node environment)
web-test-unit:
    ./scripts/filtered-web-test.sh --project unit

# Integration tests only (jsdom environment)
web-test-integration:
    ./scripts/filtered-web-test.sh --project integration

# Coverage check (pre-push, >= 80% threshold)
web-coverage:
    ./scripts/filtered-web-test.sh --coverage

# Workspace policy (root = main mirror; dev in worktrees)
check-workspace:
    ./scripts/check-dev-workspace.sh session --fetch

# Static test-isolation check (runs in pre-commit; ~1.5s)
check-test-isolation:
    ./scripts/check-test-isolation.sh

# Prove the isolation checker still detects each violation it claims to
check-test-isolation-selftest:
    ./scripts/check-test-isolation-selftest.sh

# Shell regression tests for pre-push diff-base resolution
check-git-diff-base:
    ./scripts/test-pre-push-diff-base.sh

# Diagnostic: run every test binary twice at once (slow, probabilistic — not a gate)
check-test-concurrency:
    ./scripts/check-test-concurrency.sh

# Static check: every tmux spawn carries an explicit -S socket (runs in pre-commit)
check-tmux-socket:
    ./scripts/check-tmux-socket.sh

# Prove the tmux-socket checker still detects each spawn form it claims to
check-tmux-socket-selftest:
    ./scripts/check-tmux-socket-selftest.sh


# ── Full pre-push ───────────────────────────────────────────────────────────
# Unit tests for both Rust and web (pre-commit)
# `unit` is a redundant alias for `test-unit`; the web unit project is
# `web-test-unit`.
unit: test-unit

pre-push: test coverage web-test web-coverage

# ── Helpers ──────────────────────────────────────────────────────────────────

# List all available commands
_default:
    @just --list
