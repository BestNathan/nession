# Gate inventory — #1242

Status: **incremental verified cutover** — Hooks and Justfile quality routes use Gate IDs; CI setup/build/deploy and remaining workflow self-tests require separate parity work.

## Mapped blocking checks

- workspace: `dev-workspace-commit`, `dev-workspace-push`
- Rust: `rust-format`, `rust-clippy`, `rust-test-unit`, `rust-test-integration`, `rust-coverage`
- build tooling: `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`
- isolation: `test-isolation`, `test-isolation-selftest`, `tmux-socket-isolation`, `tmux-socket-isolation-selftest`
- protocol: `protocol-integrity`, `protocol-integrity-selftest`, `protocol-codegen-drift`
- design: `design-system-fast`, `design-system-full`, `design-system-browser`
- Web: `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`, `web-coverage`
- repository tooling: `instruction-contract`, `repo-health-selftest`, `repo-metrics-selftest`, `issue-contract-selftest`, `issue-audit-agent-selftest`, `issue-audit-cursor-selftest`
- acceptance: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`, `requirement-acceptance-pr`, `requirement-acceptance-close`
- E2E: `e2e-playwright`
- release: `release-version-consistency`
- Gate system: `gate-runtime-contract`

## Suites

- `gate-system`: `gate-runtime-contract`
- `pre-commit`: `dev-workspace-commit`, `instruction-contract`, `rust-format`, `rust-clippy`, `rust-test-unit`, `test-isolation`, `tmux-socket-isolation`, `protocol-integrity`, `design-system-fast`, `web-eslint`, `web-typecheck`, `web-test-unit`
- `pre-push`: `dev-workspace-push`, `rust-test-unit`, `rust-test-integration`, `rust-coverage`, `protocol-integrity`, `protocol-codegen-drift`, `design-system-full`, `web-test-unit`, `web-test-integration`, `web-coverage`
- `quality-rust`: `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`
- `quality-web`: `instruction-contract`, `repo-health-selftest`, `repo-metrics-selftest`, `protocol-integrity`, `issue-contract-selftest`, `issue-audit-agent-selftest`, `issue-audit-cursor-selftest`, `design-system-full`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `quality`: `instruction-contract`, `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`, `repo-health-selftest`, `repo-metrics-selftest`, `issue-contract-selftest`, `issue-audit-agent-selftest`, `issue-audit-cursor-selftest`, `design-system-full`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `staging`: `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `release`: `release-version-consistency`, `rust-format`, `rust-clippy`, `rustc-wrapper`, `worktree-target-seed`, `build-cache-verifier`, `tmux-socket-isolation`, `protocol-integrity`, `protocol-codegen-drift`, `rust-coverage`, `web-eslint`, `web-typecheck`, `web-test-unit`, `web-test-integration`
- `e2e`: `design-system-browser`, `e2e-playwright`
- `acceptance-tooling`: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`
- `requirement-acceptance-pr`: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`, `requirement-acceptance-pr`
- `requirement-acceptance-close`: `requirement-acceptance-selftest`, `acceptance-executor-selftest`, `acceptance-agent-selftest`, `requirement-acceptance-close`

## Explicit non-Gates

Dependency/browser/tool installation, Docker/native build/package/publish/deploy operations, probabilistic test-concurrency diagnostics, and metrics publication remain operations/diagnostics. Existing hooks, justfile and workflows remain authoritative until cutover.

## Consumer cutover and parity (PR for #1242)

| Surface | Classification | Gate mapping / boundary |
|---|---|---|
| `.githooks/pre-commit` | Router | Changed-file buckets -> `gates/run <ids...>`; screenshot relocation remains a non-Gate maintenance operation |
| `.githooks/pre-push` | Router | Git diff-base buckets -> `gates/run <ids...>`; missing diff base routes broad checks |
| `just check` | Router | `gates/run --suite quality-rust`; includes original acceptance-runtime/acceptance-cases self-tests |
| `just web-lint` | Router | `web-eslint` + `web-typecheck` (no combined shadow rule) |
| `just test` / `just web-test` | Router | Separate unit/integration Gate IDs, aggregated by one runner |
| `quality.yml` Rust check | Router | Uses `just check` -> `quality-rust` (CI setup remains an operation) |
| `quality.yml` Web/tooling check | Router + uncutover self-tests | Explicit self-tests remain while corresponding Gate IDs and CI parity are audited |
| E2E/staging/release workflows | Router + operations | Environment preparation, build/publish/deploy are non-Gates; quality check consumers will be migrated separately |
| GitHub issue-close/acceptance | Router | Already uses distinct stage-specific `requirement-acceptance-*` Gate IDs in the workflow |
| Domain validators / `scripts/check-*.sh` | Gate implementation | Remain single owners of rules; their `gates/checks/<id>.sh` files are interfaces, not duplicated rules |
| Dependency installs, Docker image jobs, GitOps publish | Utility/operation | Not blocking repository invariants; keep out of Gate scripts |
| Probabilistic test concurrency, build-cache status, metrics publication | Diagnostic | Nonblocking; do not silently promote to Gate |

**Parity caveat:** no all-workflow cutover is claimed here. Preserve every historical blocking self-test until it has a named Gate and positive/negative evidence. Any modified detection adapter requires catalog contract and its domain self-test, not just a green linter.
