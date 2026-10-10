# Repository Gates

> **Parallel implementation only — no existing execution surface has been switched.**

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

Legacy repository checks have not been wholesale cut over to Gate suites yet; existing mechanisms remain authoritative for those checks until parity is proven. New deterministic invariants may adopt `gates/run` directly. `instruction-contract` is the first such live Gate: instruction changes run it in pre-commit and Quality Gate while the broader legacy migration remains incremental.
