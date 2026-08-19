# Use sccache for faster Rust compilation if installed (brew install sccache).
# Empty string → cargo ignores the wrapper, no-op if sccache is missing.
export RUSTC_WRAPPER := `which sccache 2>/dev/null || echo ""`

# ── Rust ────────────────────────────────────────────────────────────────────

# Format check (fast, safe to run on every commit)
fmt:
    cargo fmt --all -- --check

# Clippy strict mode — must pass with 0 warnings
lint:
    cargo clippy --workspace -- -D warnings

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

# ── Web ─────────────────────────────────────────────────────────────────────

# Lint + type-check (fast, pre-commit)
web-lint:
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

# ── Full pre-push ───────────────────────────────────────────────────────────
# Unit tests for both Rust and web (pre-commit)
# Note: web-test-unit dependency added in Phase 2 (Task 2.4)
unit: test-unit

pre-push: test coverage web-test web-coverage

# ── Helpers ──────────────────────────────────────────────────────────────────

# List all available commands
_default:
    @just --list
