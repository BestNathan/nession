# Repository Gates

> **Incremental cutover** — Git hooks and the `just check`/developer quality aliases route through Gate IDs; workflow-specific setup/deployment and remaining self-test routing are tracked under #1242.

`gates/` is the repository Gate system. Gate IDs are stable kebab-case APIs; a Gate behaves like a test: green is terse, red is exhaustive.

```text
gates/
├── run
├── run-selftest.sh
├── checks/<gate-id>.sh
├── suites/<suite>.gates
└── lib/
    ├── common.sh
    └── common-selftest.sh
```

## Runner

```bash
./gates/run protocol-integrity web-eslint
./gates/run --suite quality
./gates/run --list
./gates/run --list-suites
./gates/run --describe protocol-integrity
./gates/run --validate
```

The runner executes the complete selection rather than failing fast. Exit 0 means all pass; 1 means invariant failure with no runtime error; 2 means an invariant was unproven or catalog/config/tooling failed. ERROR dominates FAIL.

Successful command output is buffered/discarded and prints one line. FAIL/ERROR expands reason, repair, command, owner and complete underlying output.

## Contract

Every `checks/<id>.sh` declares `GATE_ID`, `GATE_NAME`, `GATE_COMMAND`, `GATE_SUCCESS`, `GATE_FAILURE`, `GATE_REPAIR`, `GATE_OWNER`, and `gate_check`. Filename stem and `GATE_ID` must match exactly.

Known prerequisites use `gate_require_command`, `gate_require_path`, or `gate_require_env`. Missing tooling/context is ERROR, never a green skip. For the shared `gate_run_invariant`
helper, exit 1 (and cargo test's exit 101) means an invariant FAIL; other
nonzero statuses mean ERROR/unproven. Adapters whose command has different
exit semantics must classify explicitly; they must not blindly map all
nonzero subprocess statuses to an invariant failure.

`./gates/run --validate` verifies executability, filename/ID identity, required metadata, suite syntax and suite references. The runner avoids Bash 4-only features so it works with macOS Bash 3.2.

## Suites

Suite files contain Gate IDs only: no commands, repair prose, changed-file rules, secrets, or setup. Current files model logical execution surfaces for future cutover. Existing changed-file routers may still add conditional self-test IDs explicitly.

## Rollout boundary

Hooks route changed-file Gate ID sets into `gates/run`. The canonical Rust CI quality recipe `just check` runs the `quality-rust` suite, including its original Acceptance runtime and Cases checks. Workflow-specific setup/deployment and remaining tooling self-tests are separate migration work; they must not be removed until parity is proven. Use `just gate <id>`, `just gates <suite>`, or `./gates/run <ids...>`.

The Server Handler locality Gate (`server-handler-locality`) is included in the
`quality-rust` and aggregate `quality` suites. Its isolated self-test and
concurrency stress test are exposed by `just check-protocol` after the
protocol-integrity Gate. See #1258 for the handler locality contract.

## Browser regression routing

In normal E2E CI, `e2e-playwright` wraps the canonical `e2e/run test --all`
runner. Explicit snapshot regeneration is a mutable developer/workflow operation
and is intentionally not treated as a passing Gate. Browser dependency setup
and Rust/Web builds remain workflow-owned prerequisites.

## Hook routing contract

`gate-router-contract` runs deterministic pre-commit and pre-push scenarios with mocked Git diffs and the Gate runner. It asserts rule-owner changes select their Gate and regression fixtures, including mutation tests proving missing self-test routes are caught. Failed `git diff` broadens pre-push selection instead of returning a successful skip. Hook/Gate changes trigger `gate-runtime-contract` and `gate-router-contract`; Quality CI runs both through `quality-tooling`.
