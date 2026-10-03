# Gate inventory — #1242

Status: **complete parallel Gate catalog; no consumer cutover.**

## Mapped blocking checks

- workspace: `dev-workspace-commit`, `dev-workspace-push`
- Rust: `rust-format`, `rust-clippy`, `rust-test-unit`, `rust-test-integration`, `rust-coverage`
- build tooling: `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`
- isolation: `test-isolation`, `test-isolation-selftest`, `tmux-socket-isolation`, `tmux-socket-isolation-selftest`
- protocol: `protocol-integrity`, `protocol-integrity-selftest`, `protocol-codegen-drift`
- design: `design-system-fast`, `design-system-full`, `design-system-browser`
- Web: `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`, `web-coverage`
- repository tooling: `repo-health-selftest`, `repo-metrics-selftest`, `issue-contract-selftest`, `issue-audit-agent-selftest`, `issue-audit-cursor-selftest`
- acceptance: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`, `requirement-acceptance-pr`, `requirement-acceptance-close`
- E2E: `e2e-playwright`
- release: `release-version-consistency`
- Gate system: `gate-runtime-contract`

## Suites

- `gate-system`: `gate-runtime-contract`
- `pre-commit`: `dev-workspace-commit`, `rust-format`, `rust-clippy`, `rust-test-unit`, `test-isolation`, `tmux-socket-isolation`, `protocol-integrity`, `design-system-fast`, `web-eslint`, `web-typecheck`, `web-test-unit`
- `pre-push`: `dev-workspace-push`, `rust-test-unit`, `rust-test-integration`, `rust-coverage`, `protocol-integrity`, `protocol-codegen-drift`, `design-system-full`, `web-test-unit`, `web-test-integration`, `web-coverage`
- `quality-rust`: `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`
- `quality-web`: `repo-health-selftest`, `repo-metrics-selftest`, `protocol-integrity`, `issue-contract-selftest`, `issue-audit-agent-selftest`, `issue-audit-cursor-selftest`, `design-system-full`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `quality`: `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`, `repo-health-selftest`, `repo-metrics-selftest`, `issue-contract-selftest`, `issue-audit-agent-selftest`, `issue-audit-cursor-selftest`, `design-system-full`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `staging`: `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `release`: `release-version-consistency`, `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `e2e`: `design-system-browser`, `e2e-playwright`
- `acceptance-tooling`: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`
- `requirement-acceptance-pr`: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`, `requirement-acceptance-pr`
- `requirement-acceptance-close`: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`, `requirement-acceptance-close`

## Explicit non-Gates

Dependency/browser/tool installation, Docker/native build/package/publish/deploy operations, probabilistic test-concurrency diagnostics, and metrics publication remain operations/diagnostics. Existing hooks, justfile and workflows remain authoritative until cutover.
