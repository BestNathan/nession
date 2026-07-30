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

# Full test suite (only shows failures + summary)
test:
    ./scripts/filtered-test.sh

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

# Unit tests (pre-push) — jsdom noise filtered
web-test:
    ./scripts/filtered-web-test.sh

# Coverage check (pre-push, >= 80% threshold) — jsdom noise filtered
web-coverage:
    ./scripts/filtered-web-test.sh --coverage

# ── Full pre-push ───────────────────────────────────────────────────────────
pre-push: test coverage web-test web-coverage

# ── Helpers ──────────────────────────────────────────────────────────────────

# List all available commands
_default:
    @just --list
