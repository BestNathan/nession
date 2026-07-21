# ── Rust ────────────────────────────────────────────────────────────────────

# Format check (fast, safe to run on every commit)
fmt:
    cargo fmt --all -- --check

# Clippy strict mode — must pass with 0 warnings
lint:
    cargo clippy --workspace -- -D warnings

# Full test suite (only shows failures + summary)
test:
    ./scripts/filtered-test.sh

# Per-crate coverage check against thresholds
coverage:
    ./scripts/check-coverage.sh

# Fast pre-commit checks (fmt + clippy)
quick: fmt lint

# Full CI checks (fmt + lint + test + coverage)
check: fmt lint test coverage

# ── Web ─────────────────────────────────────────────────────────────────────

# Lint + type-check (fast, pre-commit)
web-lint:
    cd web && npx eslint . --report-unused-disable-directives --max-warnings 0
    cd web && npx tsc --noEmit

# Unit tests (pre-push)
web-test:
    cd web && npx vitest run --reporter=default

# Coverage check (pre-push, >= 80% threshold)
web-coverage:
    cd web && npx vitest run --coverage --reporter=default

# ── Full pre-push ───────────────────────────────────────────────────────────
pre-push: test coverage web-test web-coverage

# ── Helpers ──────────────────────────────────────────────────────────────────

# List all available commands
_default:
    @just --list
