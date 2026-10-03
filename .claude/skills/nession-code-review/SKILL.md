---
name: nession-code-review
description: Use when reviewing a Nession PR/implementation or auditing protocol, runtime, concurrency, reconnect/lifecycle, ownership, tests, or architecture correctness. Review first; implementation fixes belong to nession-development.
---

# Nession Code Review

Review Nession changes against **invariants and owners**, not style preference.

Read the nearest scoped `AGENTS.md` and relevant canonical docs before judging a subsystem.

## 1. Establish the baseline

For a PR, identify base/head and changed files. For post-implementation review, identify the exact branch/commit/worktree.

Do not review a stale snapshot while claiming conclusions about newer code.

## 2. Reconstruct the invariant

Before line comments, answer:

- What state/resource is owned?
- Who may mutate it?
- What ordering/boundedness/lifecycle must hold?
- Which protocol/Gate/test proves it?
- What user-visible failure occurs if it breaks?

Then trace producer -> transport/queue -> consumer -> state mutation -> response/cleanup.

## 3. Ownership review

Look for:

- two writers for one authoritative state;
- transport/adapters making domain decisions;
- caches/projections without invalidation;
- compatibility aliases restoring a retired owner;
- fixes applied at consumers instead of the invalid-state producer.

One responsibility should have one owner.

## 4. Concurrency and backpressure

For asynchronous/runtime changes check:

- task creation has a global/resource bound;
- queues are bounded where load is untrusted;
- ordering key matches the real resource scope;
- multi-resource operations do not bypass per-key serialization;
- locks are not held across unrelated await points;
- cancellation/shutdown settles pending work;
- single-writer assumptions are actually enforced.

“Per-key bounded” does not imply globally bounded. “FIFO for key” does not prove the chosen key is correct.

## 5. Lifecycle / reconnect

Distinguish identity from current authority.

Review:

- generation/session ownership;
- stale connection cleanup;
- same-socket re-registration;
- replacement connection races;
- pending request semantics during disconnect/reconnect;
- ABA-style reuse of identifiers/ownership.

A green reconnect happy path is not sufficient if stale actors can still mutate current state.

## 6. Protocol

For protocol changes read `crates/nession-protocol/AGENTS.md` and `docs/architecture/protocol.md`.

Check contract ownership, versioning, producer/consumer direction, correlation, routing completeness, codegen, and protocol Gates.

Do not invent review rules that contradict the protocol validator.

## 7. tmux / terminal

For agent tmux changes read `crates/nession-agent/AGENTS.md`.

Pay special attention to socket ownership, process cleanup, terminal ordering/loss semantics, attach/replay, multi-client ownership, and full-screen/TUI behavior.

## 8. Tests as proof

Ask what claim each test proves.

Strong regression proof includes:

- the original bad condition;
- negative/edge half of the invariant;
- deterministic synchronization for races;
- scope matching the production resource;
- a known-valid counterexample for custom static detectors.

Do not accept implementation-mirroring tests that cannot fail when the real invariant breaks.

## 9. Gate evidence

Map affected invariants to Gate IDs.

```bash
./gates/run --describe <id>
```

A green unrelated CI job is not proof. If the PR changes a Gate/checker, inspect its deterministic self-test.

## 10. Severity

Use repository impact, not aesthetic preference:

- **P0** — safety/data/correctness invariant violation with severe immediate impact.
- **P1** — concurrency, boundedness, resource/lifecycle, protocol correctness, or likely production failure.
- **P2** — maintainability/observability/incomplete hardening with concrete future failure risk.

Avoid severity inflation for naming/style unless it hides a correctness problem.

## 11. Evidence discipline

Separate:

**Verified fact**
- exact code path;
- reproducer/test;
- Gate output;
- protocol/owner contract.

**Hypothesis**
- plausible race or failure mode not yet reproduced.

Do not present a hypothesis as a confirmed bug.

## 12. Compare against the issue

Review implementation against the Requirement/Bug's current Success Criteria, not only the PR description.

Identify:

- implemented criteria;
- missing criteria;
- accidental scope growth;
- stale acceptance evidence;
- follow-ups that belong in separate issues.

## 13. Output format

Lead with findings, highest severity first.

For each finding include:

1. severity + concise invariant violation;
2. exact location/path;
3. why it is wrong;
4. concrete failure scenario;
5. repair direction;
6. missing/needed proof.

Then summarize what is already correct and any issue/acceptance actions.

## Stop conditions

Stop claiming completion when:

- base/head is ambiguous;
- a required owner/scoped instruction was not read;
- evidence only proves a helper, not the user/runtime boundary;
- a race claim has no feasible ordering argument/reproducer;
- a Gate failure remains unexplained.

Review is read-only unless the user also asks for fixes; hand implementation to `nession-development`.
