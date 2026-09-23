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

# Full CI checks (fmt + lint + tmux-socket gate + protocol gate + codegen drift +
# coverage — coverage runs all tests)
check: fmt lint check-tmux-socket check-protocol check-codegen coverage

# ── Protocol codegen (#678 Phase 5) ─────────────────────────────────────────

# The protocol gate.
#
# An unrecognised wire is ignored, not rejected, so a sender that misspells one
# — or names one that was renamed and not carried through — gets no error and
# no reply. It waits. That is what `agent.env.resource` did until #913: a
# forced env write reported a re-source failure and the session kept the old
# values.
#
# Two rules, and they are duals:
#
#   1. every wire a call site names is well formed and some runtime answers it
#   2. every advertised protocol is named by at least one call site
#
# Reads the advertised set from the generated tree (which `just check-codegen`
# keeps equal to the contracts) and from the `pub const` declarations beside
# each dispatcher. A file that deals in placeholder wires on purpose declares
# `// not-protocol-file: <reason>` in its header, and every run prints which
# files do.
#
# It used to derive `<wire>.response` for every wire as well, back when that was
# the spelling every reply carried. One wire per operation removed it (#953): a
# reply carries its request's own name and is correlated by `id`.
check-protocol:
    node scripts/protocol-gate.mjs

# Every name a call site may use — units, wires and notifications.
protocol-list:
    node scripts/protocol-gate.mjs --list

# Prove the gate still catches what it exists for: each rule is injected into a
# fixture tree and has to fail with that rule named.
protocol-check-selftest:
    ./scripts/protocol-gate-selftest.sh

# Regenerate the Web's TypeScript bindings from the Rust contracts.
# Committed output: run this and commit the result whenever a contract changes.
codegen:
    cargo run --quiet -p nession-protocol-codegen -- web/src/generated/protocol

# The drift gate: the generated bindings must be what the contracts say.
#
# Regenerating into a temporary directory and diffing is deliberate. Running the
# generator over the committed tree and asking git whether anything moved would
# also work — and would leave the tree modified on failure, so the check would
# report the same thing on every subsequent run until someone rebuilt it by
# hand. A scratch directory leaves the working tree untouched either way.
check-codegen:
    ./scripts/check-codegen-drift.sh

# Every protocol in the tree, as one JSON Schema document on stdout:
#
#     just protocol-schema > protocol-schema.json
#
# Or a single operation's slice of it, which carries only the definitions that
# operation actually references rather than the whole catalog:
#
#     just protocol-schema agent.session.create
#
# The same contracts the TypeScript bindings are generated from, projected for
# a consumer that *validates* a message rather than one that imports a shape.
protocol-schema *op:
    cargo run --quiet -p nession-protocol-codegen -- --schema {{op}}

# ── Design tokens + UI contracts ────────────────────────────────────────────

tokens-gen:
    node design/scripts/generate-tokens.mjs

tokens-check:
    node design/scripts/generate-tokens.mjs --check

# UI contract unit tests (node --test; tokens + contracts + inventory + gate helpers)
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

# Deterministic inventory integrity check. Kept as a focused helper; callers
# that need enforcement should use the canonical design-check entrypoint below.
design-inventory-check:
    node design/scripts/audit-design-system.mjs --check

# #759 canonical design-system enforcement entrypoint. Profiles and their rule
# lists are owned only by design/scripts/design-gate.mjs; hooks/CI must not copy
# those rules locally.
design-check profile="full":
    node design/scripts/design-gate.mjs --profile {{profile}}

check-design-tokens:
    ./scripts/check-design-tokens.sh

check-design-tokens-selftest:
    ./scripts/check-design-tokens-selftest.sh

# ── Web ─────────────────────────────────────────────────────────────────────

# Lint + type-check. Design source/generated integrity belongs to design-check;
# this target remains ordinary Web engineering quality.
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
