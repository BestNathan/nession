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


## Source-aligned Acceptance Cases

Use a source-aligned Case when one Success Criterion needs executable evidence tied to an exact product SHA. The canonical shape is `e2e/acceptance/cases/<issue>/<SC>/`: **one Case per Issue/SC**, one independently reported result, optional multiple verifier steps.

Choose the Case stage from the Issue Acceptance Report. Use `browser` for UI/browser-observable behavior, `protocol` for wire/WebSocket behavior, and `runtime` for orchestration/process/config/file evidence. All verifier types may share the same `full-stack-local` Runtime Harness; protocol/runtime verification must not launch Playwright unless a browser verifier is declared.

A Case Pass requires concrete evidence from every declared verifier. Skip/absence is Pending. Results pin exact target SHA, Case revision/tree SHA and SC contract digest. Compact immutable records are ingested into the append-only `acceptance-results` orphan branch; large traces/screenshots/logs remain workflow artifacts.

Automatic Case execution maps staging push → `staging` and main push → `post-merge` using exact SHA Requirement association discovery. Manual replay must select Issue, SC, exact 40-character SHA, stage and runtime profile.

Security boundary: target Case code is read-only (`contents: read`, `issues: read`). It must never mutate an Issue, push result branches, or receive production secrets. Only trusted `main` ingestion/updater code may write `acceptance-results` and project an eligible result into the Issue, after current-SHA, association and contract-digest checks.

For the full creation, stage selection, verifier choice, evidence quality, archive/promotion and future remote-profile rules, read `docs/architecture/acceptance-cases.md`.
