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

# Full CI checks (fmt + lint + coverage — coverage already runs all tests)
check: fmt lint coverage

# ── Design tokens ───────────────────────────────────────────────────────────

tokens-gen:
    node design/scripts/generate-tokens.mjs

tokens-check:
    node design/scripts/generate-tokens.mjs --check

check-design-tokens:
    ./scripts/check-design-tokens.sh

check-design-tokens-selftest:
    ./scripts/check-design-tokens-selftest.sh

# ── Web ─────────────────────────────────────────────────────────────────────

# Lint + type-check (fast, pre-commit)
web-lint: tokens-check
    cd web && npx eslint . --report-unused-disable-directives --max-warnings 0
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

# Diagnostic: run every test binary twice at once (slow, probabilistic — not a gate)
check-test-concurrency:
    ./scripts/check-test-concurrency.sh

# ── Full pre-push ───────────────────────────────────────────────────────────
# Unit tests for both Rust and web (pre-commit)
# Note: web-test-unit dependency added in Phase 2 (Task 2.4)
unit: test-unit

pre-push: test coverage web-test web-coverage

# ── Helpers ──────────────────────────────────────────────────────────────────

# List all available commands
_default:
    @just --list
