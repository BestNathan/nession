---
name: nession-writing-requirements
description: Use when creating/updating Nession Requirement or Bug GitHub issues, documenting user requests, maintaining Success Criteria/Acceptance Report structure, labels, or conversation history.
---

# Nession Writing Requirements

This Skill owns **issue structure and requirement capture**. It does not own implementation, Gate semantics, or execution of acceptance.

- implementation -> `nession-development`
- acceptance execution -> `nession-acceptance`
- Gate semantics -> `nession-gates`

The executable structural owner is `scripts/issue-contract.mjs`.

## 1. Classify first

Choose exactly one kind:

- **Requirement** — requested product/engineering behavior/change.
- **Bug** — observed behavior contradicts the intended/current contract.

Use one or more area labels appropriate to the affected owner.

Before creating a new issue, search for an existing issue that already owns the same problem.

## 2. Requirement format

Title:

```text
Requirement: <concise outcome>
```

Body must contain:

```markdown
## Requirements: <Topic>

<problem, desired behavior, constraints, design decisions>

### Success Criteria

- [ ] SC-01 <observable criterion>
- [ ] SC-02 <observable criterion>

## Acceptance Report

| Criterion | Stage | Result | Evidence |
|---|---|---|---|
| SC-01 | pre-merge | Pending | implementation pending |
| SC-02 | staging | Pending | implementation pending |

## Product alignment

- [ ] Does this move Nession toward VISION.md?
- [ ] Does it obey PRINCIPLE.md?
- [ ] Were relevant docs/design/* sources checked?
- [ ] Is any deviation explicit?

---
**Status:** Draft | In Discussion | Approved
```

Every Success Criterion has a stable `SC-xx` ID and exactly one Acceptance Report row.

Stages are `pre-merge`, `staging`, or `post-merge`.

Results are `Pending`, `Pass`, `Fail`, or justified `N/A`.

## 3. Good Success Criteria

A criterion states an externally verifiable outcome, not an implementation todo.

Good:

- exact behavior/state transition;
- compatibility or non-regression boundary;
- measurable UI/interaction result;
- deterministic validation evidence.

Bad:

- “code looks clean”;
- “refactor completed” without behavior;
- duplicating the implementation plan as checkboxes;
- ambiguous “works correctly”.

Use `post-merge` only when the criterion genuinely cannot be proven before merge/deploy/observation.

## 4. Bug format

Title:

```text
Bug: <observed failure>
```

Required sections:

```markdown
## Description
## Reproduction
## Root Cause
## Impact
## Fix Direction
## Location
```

If root cause is not verified, use `## Investigation Status` instead of `## Root Cause`. Never include both.

A Bug issue should distinguish verified facts from hypotheses.

## 5. Product alignment

For user-facing Requirements, read `VISION.md`, `PRINCIPLE.md`, and relevant `docs/design/*` before finalizing.

Do not use current implementation limitations as product requirements unless the constraint is intentional.

## 6. Conversation history

When requirements evolve, preserve meaningful decisions in an issue comment rather than repeatedly bloating the canonical body.

Recommended comment:

```markdown
## Conversation History

### YYYY-MM-DD — Initial Request
**User:** ...

**Agent:** ...

### YYYY-MM-DD — Decision
...
```

The issue body should remain the current canonical requirement, not a chronological transcript.

## 7. Changes after creation

When the user changes a requirement:

1. update the canonical issue body;
2. update/add affected SC rows;
3. preserve already-valid acceptance evidence only when the criterion meaning did not change;
4. add a conversation-history comment describing the decision;
5. keep Status accurate.

If criterion meaning changes materially, old evidence must not silently count as proof.

## 8. Acceptance relationship

This Skill defines criteria and report structure.

`nession-acceptance` executes stage-specific acceptance and updates evidence. The deterministic requirement-acceptance validator decides merge/closure eligibility.

Do not duplicate validator semantics here beyond the public table vocabulary.

## 9. Validate

Before considering an issue well-formed, run/use the canonical issue contract validator where applicable:

```bash
node scripts/issue-contract.mjs self-test
```

For an existing issue, use the repository's issue-audit workflow/tooling.

## Stop conditions

Do not finalize when:

- kind is unclear;
- there is no area owner;
- Success Criteria are implementation tasks instead of outcomes;
- Acceptance rows do not match SC IDs;
- a Bug root cause is stated as fact without evidence;
- product-facing behavior conflicts with Vision/Principles without an explicit decision.
