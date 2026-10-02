# Repository gates

> **Rollout state: contract only — not cut over.**
>
> The files introduced by #1242 define the future gate interface. Existing Git
> hooks, \`justfile\` recipes, GitHub Actions workflows, release checks, and issue
> guards remain authoritative until a later migration explicitly switches each
> consumer. Do not delete or bypass an existing check because a candidate gate
> entrypoint exists.

## Model

A repository gate is a blocking invariant with one stable executable interface:

\`\`\`
router / execution surface
        |
        v
gates/<gate-id>.sh       stable interface + diagnostics
        |
        v
domain implementation    cargo / node / npm / existing scripts
\`\`\`

Routers own **when** a gate runs. A gate owns **what success means** and **how a
failure is repaired**. Domain-specific rule engines can stay in their current
language/location.

## Contract

Every production \`gates/<gate-id>.sh\` must:

- use \`#!/usr/bin/env bash\` and \`set -euo pipefail\`;
- source \`gates/lib/common.sh\`;
- declare \`GATE_ID\`, \`GATE_NAME\`, \`GATE_COMMAND\`, \`GATE_SUCCESS\`,
  \`GATE_FAILURE\`, \`GATE_REPAIR\`, and \`GATE_OWNER\`;
- implement a \`gate_check\` function;
- finish with \`gate_main "$@"\`;
- treat \`GATE_COMMAND\` as printable metadata only — never \`eval\` it;
- return 0 when the invariant is proven, 1 when the invariant is false, and 2+
  when the gate cannot evaluate the invariant;
- never mutate source files during a normal check;
- remain runnable from any caller CWD. \`gate_main\` runs \`gate_check\` from the
  repository root;
- use \`gate_invariant_failure\` for a more specific violation reason and
  \`gate_runtime_error\` for missing/broken tooling;
- preflight required tools/paths with \`gate_require_command\` /
  \`gate_require_path\` when that distinction matters.

Template:

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/lib/common.sh"

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

## Standard output and exit semantics

Start:

\`\`\`text
[GATE] protocol-integrity
name: Protocol integrity
command: node scripts/protocol-gate.mjs
owner: crates/nession-protocol + protocol consumers
\`\`\`

Success returns **0**:

\`\`\`text
[PASS] protocol-integrity
success: all referenced protocol wires have valid producers/consumers
\`\`\`

Invariant failure returns **1**:

\`\`\`text
[FAIL] protocol-integrity
reason: <specific violation, or GATE_FAILURE>
repair: <specific repair, or GATE_REPAIR>
command: node scripts/protocol-gate.mjs
\`\`\`

Tooling/environment/contract failure returns **2**:

\`\`\`text
[ERROR] protocol-integrity
reason: <why the invariant could not be evaluated>
repair: <how to restore the gate environment>
command: node scripts/protocol-gate.mjs
\`\`\`

Both FAIL and ERROR are blocking. Missing tools/configuration must never become
a successful skip.

Every gate also supports \`--describe\`. It prints metadata without running the
check so humans and agents can discover the exact command, owner and repair
path without reading workflow YAML.

## Rule ownership

A gate entrypoint is not permission to copy a rule.

- Existing Node/Rust/Python/shell validators remain the domain rule owner when
  that is already the clearest location.
- \`gates/<id>.sh\` owns repository-facing metadata and execution semantics.
- Hooks/workflows/just recipes may route/profile gates but may not reproduce
  gate-specific rule lists or repair logic.
- A composite runner may call gates; it is never a second rule engine.
- If two checks have materially different failure meanings or repair paths,
  prefer two gate IDs over one vague aggregate gate.
- Cost profiles are allowed only when they are profiles of the same invariant;
  they must not silently redefine success.

## Self-tests

Custom detection logic must have deterministic known-pass and known-fail
fixtures. The shared runtime is covered by:

\`\`\`bash
bash gates/lib/common-selftest.sh
\`\`\`

The runtime self-test verifies:

- PASS / FAIL / ERROR exit semantics;
- actionable reason/repair output;
- invalid contract rejection;
- \`--describe\` does not execute the gate;
- execution is independent of caller CWD.

A migrated domain gate must continue to run the domain validator's existing
self-test (or add one if it has custom detection logic).

## Rollout plan

#1242 is intentionally split into three phases.

1. **Contract (this phase)** — land this runtime, documentation and baseline
   inventory. No execution surface changes.
2. **Parallel adapters** — add real \`gates/<id>.sh\` adapters one by one, prove
   parity against the current commands/self-tests, and keep the old consumers
   unchanged. A candidate gate is not authoritative merely because the file
   exists.
3. **Cutover** — switch hooks, \`justfile\`, CI, release/closure workflows and
   skills to route through proven gate entrypoints. Remove shadow rule prose
   only after parity is demonstrated.

A cutover PR must name exactly which old invocation is replaced, show the
equivalent gate invocation, and preserve the same or stronger blocking behavior.
