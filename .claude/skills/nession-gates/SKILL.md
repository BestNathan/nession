---
name: nession-gates
description: Use when designing, adding, changing, running, routing, reviewing, or repairing Nession repository Gates; when a hook/CI/just check fails; when deciding whether a new invariant should block commit/push/merge/release/closure; or when applying Gate-first quality design. Treat Gate IDs and gates/ as the canonical repository quality interface and never bypass a failing Gate.
---

# Nession Gates

Nession uses **Gate-first repository engineering**.

A Gate is not “a CI step” and not “a command we happen to run”. A Gate is an
**executable repository invariant** with a stable ID, explicit ownership, deterministic
result semantics, and an actionable repair path.

The core question is:

> **What must remain true for this change to be acceptable, and which Gate proves it?**

Only after that question is answered should hooks, `just`, CI, release, or acceptance
decide **when** to run the Gate.

---

# 1. Iron laws

## 1.1 Gate before execution surface

Never define a repository invariant directly in a hook or workflow when it belongs to a
reusable Gate.

```text
invariant
  ↓
stable Gate ID
  ↓
gates/checks/<gate-id>.sh
  ↓
domain implementation
  ↓
gates/run
  ↓
hook / just / CI / release / acceptance router
```

Routers decide **when/why**. Gates define **what must be true**.

## 1.2 Gate ID is repository API

A Gate ID is stable and maps exactly to one executable:

```text
protocol-integrity
  -> gates/checks/protocol-integrity.sh
  -> GATE_ID=protocol-integrity
```

Renaming an ID is an API migration. Audit suites, hooks, workflows, documentation, and
agent instructions before changing it. Never reuse an old ID for a different invariant.

## 1.3 One invariant, one owner

A Gate may wrap Rust, Node, npm, Playwright, shell, or an existing validator. Do not
reimplement domain rules in the wrapper merely to make them “look like Gates”.

Examples:

- protocol semantics stay in the protocol validator;
- design rules stay in the canonical design gate;
- coverage thresholds stay in the coverage owner;
- acceptance semantics stay in the requirement-acceptance validator.

The Gate is the stable repository-facing contract around that owner.

## 1.4 Fail closed

A Gate has three semantic outcomes:

- **PASS / 0** — the invariant was proven true;
- **FAIL / 1** — the invariant was proven false;
- **ERROR / 2** — the invariant could not be proven.

Missing tools, missing context, parser crashes, invalid configuration, and unavailable
required state are **ERROR**, never PASS-by-skip.

## 1.5 Green is quiet; red is complete

A passing Gate is one concise line.

A failed/error Gate must expose enough information to repair it without reverse
engineering workflow YAML:

- Gate ID / name;
- reason;
- repair;
- exact command;
- owner;
- complete underlying stdout/stderr.

## 1.6 Never bypass a Gate

Forbidden responses to a failing Gate:

- `|| true`;
- changing a failing exit to 0;
- deleting the Gate from a suite/router only to land the current change;
- disabling a test/lint/rule instead of fixing the violation;
- turning a missing dependency into “skip/pass”;
- duplicating a weaker version of the rule in CI;
- editing failure/repair text to hide the actual violation.

A legitimate exception is a repository decision, not an inline escape hatch. It needs
explicit scope, owner, reason, and follow-up.

---

# 2. Start every change Gate-first

Before modifying code, discover the quality contract.

```bash
./gates/run --list
./gates/run --list-suites
./gates/run --validate
```

For relevant candidate Gates:

```bash
./gates/run --describe <gate-id>
```

Then answer:

1. Which existing invariants can this change violate?
2. Which Gate IDs prove those invariants?
3. Does the change modify a Gate, its rule owner, or its routing?
4. Does the change create a genuinely new blocking invariant?
5. What is the narrowest Gate to run while iterating?
6. What broader suite should run before handoff?

**Do not infer Gate semantics from a workflow step when the Gate already exists.**
Read the Gate's self-description and canonical owner.

### Rollout-awareness

Always read `gates/README.md` before reasoning about enforcement topology.

The Gate catalog can be canonical for **design/discovery** while some existing hooks,
`just` recipes, or workflows are still authoritative routers during migration. Do not
claim a suite is currently enforced merely because its file exists.

---

# 3. Normal development workflow

## During implementation

Run the narrow Gate closest to the change:

```bash
./gates/run protocol-integrity
./gates/run web-typecheck web-eslint
./gates/run rust-format rust-clippy
```

Prefer Gate IDs over reconstructing their underlying command. The Gate carries the
repository's failure semantics and repair contract.

## Before handoff / PR

Run the appropriate broader selection:

```bash
./gates/run --suite pre-commit
./gates/run --suite pre-push
./gates/run --suite quality
```

Use the suite that matches the actual execution stage and current repository rollout.
Changed-file routing may select explicit IDs instead of running a whole suite; that is a
router optimization, not a new invariant definition.

## When Gate infrastructure itself changes

At minimum:

```bash
bash gates/lib/common-selftest.sh
bash gates/run-selftest.sh
./gates/run --validate
./gates/run gate-runtime-contract
```

Also run the self-test of any custom validator whose Gate or rule owner changed.

---

# 4. Reading a failure

Do not start by reading CI YAML. Start with the Gate result.

## FAIL

`FAIL` means the invariant was evaluated and is false.

Process:

1. read `reason`;
2. read `repair`;
3. inspect `owner`;
4. use the full `output` to locate the concrete violation;
5. fix the canonical owner or violating consumer;
6. rerun the **same Gate ID**;
7. after it passes, run the related broader suite.

## ERROR

`ERROR` means the Gate could not prove correctness.

Typical causes:

- required command unavailable;
- required dependency directory missing;
- missing GitHub event/token/context;
- validator crash;
- malformed Gate contract;
- suite references an unknown ID.

Fix the execution environment or Gate implementation first. Do not treat ERROR as “not
applicable” unless the Gate contract itself is explicitly redesigned and reviewed.

## Multiple failures

Fix shared root causes rather than independently silencing each Gate. After a shared fix,
rerun all previously failing IDs together:

```bash
./gates/run gate-a gate-b gate-c
```

The runner intentionally executes the complete selected set so one invocation gives the
whole state.

---

# 5. Is this a Gate?

Create a Gate when **all** are true:

1. there is a concrete repository invariant;
2. violating it should block commit, push, merge, release, closure, or another explicit
   quality boundary;
3. the result is deterministic enough to be enforcement;
4. failure can name an owner and actionable repair;
5. the invariant should be reusable across more than one execution context, or benefits
   from a stable repository API.

Typical Gates:

- formatting/lint/type correctness;
- deterministic tests/coverage thresholds;
- protocol integrity;
- generated-code drift;
- repository-specific isolation rules;
- requirement acceptance;
- release version consistency.

Do **not** make something a Gate merely because a command can fail.

Usually not Gates:

- dependency installation;
- Docker build/push as an operation;
- artifact upload;
- deployment itself;
- metrics collection/publication;
- exploratory diagnostics;
- flaky/probabilistic stress probes;
- one-off migration scripts.

A deployed-environment invariant may still be a Gate if the environment state is what is
being proven. In that case its required context must fail clearly as ERROR when absent.

---

# 6. Authoring a Gate

## Step 1 — state the invariant

Write one sentence before writing shell:

> “All referenced protocol wires have a valid producer/consumer.”

If the sentence contains unrelated clauses with different owners/repairs, split it.

## Step 2 — search the catalog

```bash
./gates/run --list
grep -R "<concept>" gates/checks scripts design/scripts .github/workflows
```

Prefer extending/correcting the canonical Gate over adding a shadow Gate.

## Step 3 — choose a stable ID

Use kebab-case and describe the invariant, not the tool.

Good:

- `protocol-integrity`
- `web-typecheck`
- `tmux-socket-isolation`
- `release-version-consistency`

Bad:

- `check`
- `quality`
- `run-node-script`
- `misc-tests`

Independently routable enforcement levels with meaningfully different execution
requirements may have explicit IDs, such as `design-system-fast`,
`design-system-full`, and `design-system-browser`.

Do not build a hidden profile/workflow DSL inside one generic Gate.

## Step 4 — create the thin adapter

Path:

```text
gates/checks/<gate-id>.sh
```

Template:

```bash
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
GATE_OWNER="scripts/protocol-gate.mjs + protocol consumers"

gate_check() {
  gate_require_command node "Install Node.js and rerun the Gate." || return $?
  gate_run_invariant node scripts/protocol-gate.mjs
}

gate_main "$@"
```

`GATE_COMMAND` is printable metadata. Never `eval` it.

Use:

- `gate_require_command` for tools;
- `gate_require_path` for required files/directories;
- `gate_require_env` for required context;
- `gate_run_invariant` for a normal command whose non-zero means the invariant is false;
- `gate_runtime_error` when the check itself cannot be evaluated;
- `gate_invariant_failure` when custom wrapper logic proves the invariant false.

## Step 5 — preserve the real rule owner

If an existing validator already owns the logic, call it. Do not port it into shell unless
the domain owner is intentionally being redesigned.

## Step 6 — add deterministic self-test when needed

Custom detection logic must prove both:

- a known-pass fixture passes;
- a known-violation fixture fails.

If the Gate is only a thin wrapper over an upstream compiler/linter/test runner, do not
invent artificial tests for the upstream tool. Test any Nession-specific wrapper behavior
you add.

## Step 7 — validate the contract

```bash
bash -n gates/checks/<gate-id>.sh
./gates/run --describe <gate-id>
./gates/run --validate
./gates/run <gate-id>
```

For a custom validator, also prove a known violation produces FAIL and useful repair
output.

---

# 7. Suites are composition, not policy language

A suite lives at:

```text
gates/suites/<suite-name>.gates
```

It contains Gate IDs only:

```text
rust-format
rust-clippy
protocol-integrity
web-typecheck
```

Allowed:

- one ID per line;
- blank lines;
- comments.

Not allowed:

- commands;
- environment setup;
- repair text;
- changed-file globs;
- conditions;
- secrets;
- inline shell;
- duplicated Gate metadata.

If changed files determine which Gates should run, that logic belongs to the router,
which then calls:

```bash
./gates/run gate-a gate-c gate-f
```

---

# 8. Routers are intentionally boring

Hooks, `just`, GitHub Actions, release flows, and acceptance flows should eventually do
only two things:

1. choose a suite or Gate IDs;
2. invoke `gates/run`.

They may prepare required environment/tooling, but must not become a second definition of
the invariant.

When reviewing a router, ask:

- Is it selecting Gates, or reimplementing them?
- Does it duplicate failure/repair prose?
- Does it weaken exit behavior?
- Can a Gate change without updating the router's copy of the rule?

Any “yes” after migration is a design smell.

---

# 9. Gate changes are quality-system changes

Changing a Gate is not ordinary script cleanup.

Treat these as contract changes:

- changing what causes PASS/FAIL/ERROR;
- changing Gate ID;
- changing the canonical owner;
- changing suite membership;
- changing a router so a Gate runs less often;
- changing a deterministic self-test;
- changing required context from blocking to optional.

Review the invariant first, then implementation.

A Gate removal requires evidence that:

1. the invariant is obsolete, **or**
2. another canonical Gate fully subsumes it.

Delete/update every suite/router/reference in the same migration. Never leave a shadow
implementation.

---

# 10. Gate-first code review

When reviewing Nession changes:

1. identify affected invariants before inspecting style;
2. map each invariant to Gate IDs;
3. verify the PR ran/proved the relevant Gate or equivalent current authoritative router;
4. if the PR changes a Gate/rule owner, inspect its deterministic self-test;
5. treat a green unrelated CI job as insufficient proof;
6. reject bypasses, weakened routing, silent skips, and duplicate rule ownership.

A test proves behavior. A Gate proves the repository quality boundary that behavior must
satisfy.

---

# 11. Requirement / Acceptance relationship

Requirement Success Criteria describe product/engineering outcomes.

Acceptance evaluates those criteria and writes evidence.

The requirement-acceptance Gate answers a narrower deterministic question:

> Does the issue state contain the acceptance evidence required for this merge/closure
> boundary?

Do not mix these layers:

```text
Requirement SCs
  ↓
Acceptance execution/evidence
  ↓
requirement-acceptance validator
  ↓
Gate result
  ↓
merge/closure router
```

Use `nession-writing-requirements` for requirement structure and
`nession-acceptance` for acceptance execution. Use this skill for Gate semantics and
routing.

---

# 12. Quick decision table

| Situation | Action |
|---|---|
| Existing Gate fails | Fix the reason, rerun the same Gate |
| Gate returns ERROR | Restore tooling/context or fix Gate runtime |
| Need to know what a Gate means | `./gates/run --describe <id>` |
| Need to discover Gates | `./gates/run --list` |
| Need to discover suites | `./gates/run --list-suites` |
| Gate/suite files changed | `./gates/run --validate` + `gate-runtime-contract` |
| New deterministic blocking invariant | Add one stable Gate ID |
| New diagnostic/telemetry | Keep it outside Gates |
| Need changed-file optimization | Put selection in router, not suite |
| Need multiple Gates | Use `gates/run <ids...>` or a suite |
| Want to ignore a failure “temporarily” | Stop; fix or make an explicit repository decision |

---

# 13. Relationships

```text
nession-development
  └─ develops code using Gate-first verification

nession-code-review
  └─ reviews affected invariants and Gate evidence

nession-cicd
  └─ routes Gates through workflows / release boundaries

nession-writing-requirements
  └─ defines Success Criteria

nession-acceptance
  └─ produces criterion evidence

nession-gates
  └─ owns repository invariant semantics, execution contract, composition, and anti-bypass rules
```

Durable Gate architecture and current rollout state live in `gates/README.md`.
The current mapped inventory lives in `docs/engineering/gates-inventory.md`.

If this skill and `gates/README.md` disagree about Gate mechanics, treat that as a
repository contract bug and fix both together.
