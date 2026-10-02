# Repository gates

> **Rollout state: runtime contract only — not cut over.**
>
> #1242 defines the future repository Gate system. Existing hooks, \`justfile\`,
> GitHub Actions, release checks, and issue guards remain authoritative until a
> later migration explicitly switches them.

## Directory model

\`\`\`text
gates/
├── run                 # the only multi-gate runner
├── run-selftest.sh
├── checks/             # one stable Gate ID per executable
│   └── <gate-id>.sh
├── suites/             # configuration: ordered sets of Gate IDs
│   └── <suite>.gates
└── lib/                # shared runtime mechanics, never domain rules
    ├── common.sh
    └── common-selftest.sh
\`\`\`

The root \`gates/\` directory is the Gate system. Concrete gates do **not** live
flat in that directory.

## Core model

- **Gate ID** is the stable API, for example \`protocol-integrity\`.
- **Gate** is one blocking invariant at \`gates/checks/<gate-id>.sh\`.
- **Suite** is an ordered set of Gate IDs stored in
  \`gates/suites/<suite>.gates\`.
- **Runner** is \`gates/run\`; it resolves IDs, executes every selected Gate,
  aggregates status, and owns multi-gate presentation.
- **Router** decides *when/why* a suite or list runs. Hooks/workflows are routers,
  not rule owners.

## Runner interface

\`\`\`bash
./gates/run protocol-integrity test-isolation tmux-socket-isolation
./gates/run --suite pre-commit
./gates/run --list
./gates/run --describe protocol-integrity
\`\`\`

The runner validates IDs before execution, removes duplicate IDs while preserving
first occurrence order, and does **not** fail fast by default.

Exit status:

- \`0\`: every selected Gate passed;
- \`1\`: at least one invariant failed and there were no runtime errors;
- \`2\`: at least one Gate could not evaluate its invariant, or runner/config
  validation failed.

## Output model: like a test runner

Successful Gate output is buffered and discarded. Green output is one line:

\`\`\`text
✓ protocol-integrity
\`\`\`

A suite stays compact:

\`\`\`text
✓ rust-format
✓ rust-clippy
✗ protocol-integrity
✓ test-isolation

4 gates: 3 passed, 1 failed, 0 errors
\`\`\`

Only failed/error Gates expand their complete diagnostics after the summary:

\`\`\`text
Failures
========

--- protocol-integrity ---
[FAIL] protocol-integrity
name: Protocol integrity
reason: agent.env.resource is referenced but no runtime answers it
repair: add/fix the canonical protocol handler or remove the stale call site
command: node scripts/protocol-gate.mjs
owner: crates/nession-protocol + protocol consumers
output:
  <complete underlying stdout/stderr>
\`\`\`

## Gate contract

Every \`gates/checks/<gate-id>.sh\` declares:

- \`GATE_ID\`
- \`GATE_NAME\`
- \`GATE_COMMAND\`
- \`GATE_SUCCESS\`
- \`GATE_FAILURE\`
- \`GATE_REPAIR\`
- \`GATE_OWNER\`
- \`gate_check\`

The filename must equal the stable Gate ID.

Template:

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID="protocol-integrity"
GATE_NAME="Protocol integrity"
GATE_COMMAND="node scripts/protocol-gate.mjs"
GATE_SUCCESS="all referenced protocol wires have valid producers/consumers"
GATE_FAILURE="a protocol wire/unit is inconsistent"
GATE_REPAIR="fix the canonical protocol owner/call site; do not suppress the finding"
GATE_OWNER="crates/nession-protocol + protocol consumers"

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  node scripts/protocol-gate.mjs
}

gate_main "$@"
\`\`\`

The contract returns 0 for PASS, 1 for invariant FAIL, and 2+ when correctness
cannot be evaluated. Missing tools/configuration never become a green skip.
\`--describe\` prints metadata without executing the Gate.

## Suite configuration

\`gates/suites/<suite>.gates\` contains Gate IDs only, one per line. Blank lines
and \`#\` comments are allowed.

\`\`\`text
dev-workspace
rust-format
rust-clippy
test-isolation
tmux-socket-isolation
protocol-integrity
\`\`\`

Suite files contain no commands, metadata, repair text, or changed-file routing.
They are composition only, not a new workflow DSL.

## Ownership boundaries

- \`checks/\`: stable Gate interfaces.
- \`suites/\`: stable ID composition.
- \`lib/\`: shared execution/diagnostic mechanics.
- \`run\`: validation, execution, aggregation, presentation.
- hooks/workflows: routing only.
- domain validators: domain rule implementation where appropriate.

## Self-tests

\`\`\`bash
bash gates/lib/common-selftest.sh
bash gates/run-selftest.sh
\`\`\`

These cover compact PASS, detailed FAIL/ERROR, output buffering, stable ID
validation, suite parsing/order, duplicate removal, aggregation, discovery, and
non-repo caller CWD.

## Rollout

1. **Runtime contract** — land \`run\`, \`checks/\`, \`suites/\`, \`lib/\`,
   self-tests, docs, and inventory. No consumer changes.
2. **Parallel adapters** — add real \`gates/checks/<id>.sh\` adapters and prove
   parity with current commands/self-tests. Current consumers remain authoritative.
3. **Suite declaration** — add production suites only when their Gate IDs exist.
4. **Cutover** — switch hooks/just/CI/release/closure to \`gates/run\` and then
   remove duplicate orchestration/repair prose.
