---
name: nession-acceptance
description: Use when executing, reviewing, or integrating stage-specific Acceptance for a Nession Requirement and updating criterion evidence.
---

# Nession Acceptance

Acceptance is the executable phase that proves Requirement Success Criteria. It does not replace the deterministic Requirement Acceptance Gate.

Issue structure belongs to `nession-writing-requirements`; Gate semantics belong to `nession-gates`; Agent execution telemetry belongs to `nession-agent-workflow-metrics`.

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

## Execute through the trusted workflow

Acceptance execution is routed through `.github/workflows/acceptance.yml`.

Manual execution uses **Actions -> Acceptance -> Run workflow** (`workflow_dispatch`) with:

- `issue_number`;
- explicit `stage` (`pre-merge`, `staging`, or `post-merge`);
- exact `target_ref`;
- optional `deployment`;
- optional deterministic result or model provider.

CI/CD callers invoke the same workflow through `workflow_call`. Never infer Acceptance stage from a branch name.

### Trust boundary

The workflow intentionally separates **verification** from **Issue mutation**:

- the Acceptance harness/updater is checked out from trusted `main`;
- target code is a separate read-only verification workspace;
- the Acceptance Agent/execute job has read-only repository/Issue authority and must never edit the Issue, PR, repository, Success Criteria, IDs, wording, or stages;
- when deterministic evidence is already available, supply it and skip the model;
- the structured Acceptance Result is normalized/frozen before mutation;
- **only the deterministic updater job has `issues: write`** and may project the frozen result into the Acceptance Report/check boxes.

A Requirement-level `Pass` / `Pending` / `Fail` / `N/A` is acceptance data; it must not be conflated with workflow infrastructure success/failure.

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

When acceptance tooling changes, run its self-tests and Gate suite. Any model-backed Acceptance invocation must also emit the canonical Agent Workflow Telemetry artifact; deterministic/no-criteria Acceptance does not invent an Agent run.

When a criterion depends on deployment/runtime state, prove the exact revision/environment requested rather than an adjacent successful run.
