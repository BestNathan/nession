# Repository Gates

> **Incremental adoption.** Selected Gates are already called from hooks/CI, but suite files have not replaced the existing routers. Check real hook/workflow invocations before asserting CI coverage.

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

Known prerequisites use `gate_require_command`, `gate_require_path`, or `gate_require_env`. Missing tooling/context is ERROR, never a green skip.

`./gates/run --validate` verifies executability, filename/ID identity, required metadata, suite syntax and suite references. The runner avoids Bash 4-only features so it works with macOS Bash 3.2.

## Suites

Suite files contain Gate IDs only: no commands, repair prose, changed-file rules, secrets, or setup. They model future cutover surfaces; existing hooks/workflows still route most checks themselves and may invoke individual Gates. Manually running a suite does not mean CI consumes it.

## Rollout boundary

Legacy checks have not been wholesale cut over to Gate suites. Existing routers remain authoritative until parity is proven. `instruction-contract` is live in pre-commit and Quality Gate; `gate-runtime-contract` and `agent-workflow-telemetry` are also called directly from Quality Gate. Consult `.githooks/` and `.github/workflows/` for actual enforcement.
