---
name: nession-gates
description: Use when designing, adding, changing, running, routing, reviewing, or repairing Nession repository Gates, or when a hook/CI quality invariant fails.
---

# Nession Gates

Nession uses **Gate-first repository engineering**.

A Gate is an executable repository invariant with a stable ID, deterministic result semantics, one owner, and an actionable repair path.

Live runtime/catalog details are owned by `gates/README.md`, `gates/checks/`, and `gates/suites/`.

## 1. Core laws

### Gate before router

Define the invariant once, then let hooks/`just`/CI/release/acceptance decide when to run it.

```text
invariant -> stable Gate ID -> checks/<id>.sh -> owner
                              ↓
                           gates/run
                              ↓
                         router/suite
```

### Gate ID is API

`<id>` maps to `gates/checks/<id>.sh`, whose `GATE_ID` must match.

Renaming/removing an ID is a repository API migration.

### One rule owner

Thin Gate adapters call the canonical validator/compiler/test. Do not port domain rule logic into the wrapper.

### Fail closed

- PASS / 0 — invariant proven true.
- FAIL / 1 — invariant proven false.
- ERROR / 2 — invariant could not be proven.

Missing tooling/context is ERROR, never a green skip.

### Never bypass

Forbidden:

- `|| true`;
- converting failure to 0;
- deleting a Gate/suite entry merely to land a change;
- weakening lint/test/coverage/design/protocol rules;
- turning missing prerequisites into skip/pass;
- duplicating a weaker CI rule.

## 2. Start Gate-first

```bash
./gates/run --list
./gates/run --list-suites
./gates/run --validate
./gates/run --describe <gate-id>
```

Before a change ask:

1. Which invariant can this change violate?
2. Which Gate proves it?
3. Does this change the Gate, its rule owner, or only routing?
4. Is a new blocking invariant actually needed?

Read `gates/README.md` for current rollout/enforcement topology.

## 3. Normal use

Run narrow Gates while iterating:

```bash
./gates/run protocol-integrity
./gates/run web-eslint web-typecheck
```

Use the appropriate suite/current authoritative router before handoff.

The runner intentionally aggregates the selected set instead of hiding later failures behind fail-fast.

## 4. Read failures by semantic state

### FAIL
The invariant was evaluated and is false. Read reason, repair, owner, and full output; fix the owner/violating consumer; rerun the same Gate ID.

### ERROR
The Gate could not prove correctness. Restore required tooling/context or fix the Gate runtime/config. Do not reinterpret ERROR as not-applicable.

## 5. Should this be a Gate?

Create a Gate when the condition is:

- a concrete repository invariant;
- deterministic enough for enforcement;
- expected to block an explicit quality boundary;
- able to name an owner and repair;
- useful as a stable reusable repository interface.

Usually not Gates: installation, artifact upload, deployment operation itself, metrics publication, exploratory/probabilistic diagnostics.

## 6. Authoring

1. State the invariant in one sentence.
2. Search existing Gate/owner first.
3. Choose a stable kebab-case ID describing the invariant, not the tool.
4. Add `gates/checks/<id>.sh` as a thin adapter.
5. Preserve the domain owner.
6. Add deterministic self-test for custom detection logic.
7. Run:
   ```bash
   bash -n gates/checks/<id>.sh
   ./gates/run --describe <id>
   ./gates/run --validate
   ./gates/run <id>
   ```

The adapter contract fields and helper APIs are documented in `gates/README.md` and existing checks. Copy the shape of a nearby Gate, not a stale prose snippet.

## 7. Suites

A suite is an ordered list of Gate IDs.

Suite files contain no commands, environment setup, repair prose, changed-file globs, secrets, or inline shell.

Changed-file selection belongs to routers, which pass the selected IDs to `gates/run`.

## 8. Router review

Hooks/`just`/workflows should become boring:

1. prepare required environment;
2. choose suite/IDs;
3. invoke `gates/run`.

A router that reimplements the invariant or copies repair text is a second owner.

## 9. Gate changes are quality-system changes

Review carefully when changing:

- PASS/FAIL/ERROR semantics;
- ID;
- canonical owner;
- suite membership;
- routing frequency;
- self-test behavior;
- required context.

Removing a Gate requires evidence that the invariant is obsolete or fully subsumed by another canonical Gate.

## 10. Review relationship

Code review maps affected invariants to Gate evidence. A green unrelated job is insufficient.

Requirement Acceptance is layered:

```text
Requirement criteria -> Acceptance evidence -> acceptance validator -> Gate -> merge/closure router
```

Do not collapse those owners.

## Gate runtime changes

At minimum:

```bash
bash gates/lib/common-selftest.sh
bash gates/run-selftest.sh
./gates/run --validate
./gates/run gate-runtime-contract
```

If this Skill and `gates/README.md` disagree about mechanics, fix the stale instruction rather than creating another rule source.
