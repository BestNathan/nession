---
name: nession-acceptance
description: Use when executing, reviewing, or integrating stage-specific Acceptance for a Nession Requirement and updating criterion evidence.
---

# Nession Acceptance

Acceptance is the executable phase that proves Requirement Success Criteria. It does not replace the deterministic Requirement Acceptance Gate.

Issue structure belongs to `nession-writing-requirements`; Gate semantics belong to `nession-gates`.

## Lifecycle

```text
Requirement Success Criteria
  -> implementation
  -> stage-specific Acceptance
  -> evidence/update
  -> deterministic requirement-acceptance Gate
  -> merge/final closure
```

## Run the correct stage

Read the Requirement's current `Success Criteria` and `Acceptance Report`.

Evaluate only criteria whose declared stage matches the environment/boundary being accepted:

- `pre-merge`
- `staging`
- `post-merge`

Do not mark a criterion Pass because implementation exists; execute/observe the criterion's actual proof.

## Evidence

Evidence must be concrete enough for another reviewer/validator to understand what was proven.

Prefer:

- exact Gate/test result;
- observed UI/runtime behavior;
- deployed revision + runtime observation;
- linked artifact/log/screenshot when relevant.

Avoid “looks good”, “implemented”, or a commit hash with no behavioral proof.

## Results

- `Pass` — criterion proven.
- `Fail` — criterion disproven; record the failure and repair direction.
- `Pending` — proof is not available at this stage yet.
- `N/A` — criterion legitimately does not apply, with justification.

Do not use Pending/N/A to bypass a reachable required proof.

## Contract boundaries

- The Requirement Skill owns criterion wording and report structure.
- Acceptance owns executing/interpreting stage evidence.
- `scripts/requirement-acceptance.mjs` owns deterministic merge/closure eligibility.
- Workflows route the validator; they do not duplicate its rules.

## Verification

When acceptance tooling changes, run its self-tests and Gate suite.

When a criterion depends on deployment/runtime state, prove the exact revision/environment requested rather than an adjacent successful run.
