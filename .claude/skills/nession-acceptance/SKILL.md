---
name: nession-acceptance
description: Use when executing, reviewing, or integrating stage-specific acceptance for a Nession Requirement Issue.
---

# Nession Acceptance

Acceptance is an executable phase of the Requirement lifecycle. It does not replace the deterministic Requirement Acceptance gate.

## Lifecycle

```text
Issue Audit
  -> implementation
  -> stage-specific Acceptance
  -> deterministic Issue updater
  -> Requirement Acceptance gate / close guard
  -> closure
```

The canonical Requirement contract remains the Success Criteria + Acceptance Report parsed by `scripts/requirement-acceptance.mjs`.

## Run it

Manual runs use **Actions -> Acceptance -> Run workflow** with:

- `issue_number`: the Requirement Issue;
- `stage`: `pre-merge`, `staging`, or `post-merge`;
- `target_ref`: the exact commit/ref being verified;
- optional `deployment`: environment/deployment identity;
- optional `deterministic_result_json`: structured evidence from a deterministic caller;
- `provider`: Cursor by default, DeepSeek as the alternate Acceptance Agent provider.

CI/CD callers should invoke `.github/workflows/acceptance.yml` through `workflow_call` and pass the intended stage explicitly. Do not infer the stage from a branch name.

## Contract boundaries

1. Only criteria whose Acceptance Report stage matches the requested stage are evaluated.
2. The Acceptance Agent is read-only. It must never edit the Issue, repository, PR, Success Criteria wording/IDs/stages, or substitute criteria.
3. Prefer a deterministic caller result when tests/workflows already prove the criteria. Supplying `deterministic_result_json` skips the model.
4. The trusted executor validates a complete structured result before any Issue mutation.
5. Only the deterministic updater job has `issues: write`.
6. `Pass` and justified `N/A` project to `[x]`; `Pending` and `Fail` project to `[ ]`.
7. Requirement-level `Fail` or `Pending` is valid acceptance data and must not be turned into a workflow infrastructure failure.
8. The updater preserves SC wording, IDs, stages, and unrelated Issue Markdown. Unknown, duplicate, missing, or wrong-stage IDs are rejected.
9. Evidence written by the updater includes the Actions run id and target ref (plus deployment when supplied).
10. Re-runs replace the matching report row; they do not append rows. A stale run is rejected when a newer automated run is already recorded.
11. The existing `scripts/requirement-acceptance.mjs` merge/closure validator remains the final deterministic gate.

## Structured result

Before mutation, Acceptance freezes this repository-owned shape:

```json
{
  "schema_version": 1,
  "issue": 1360,
  "stage": "staging",
  "contract_sha256": "...",
  "run_id": 123456,
  "target_ref": "abc123",
  "deployment": "staging",
  "source": "agent-cursor",
  "criteria": [
    {
      "criterion": "SC-01",
      "result": "Pass",
      "evidence": [
        { "type": "workflow", "value": "run 123456" }
      ],
      "summary": "Verified."
    }
  ]
}
```

Valid results are `Pass`, `Pending`, `Fail`, and `N/A`.

## Verification

For tooling changes run:

```bash
node scripts/requirement-acceptance.mjs self-test
node scripts/acceptance-executor.mjs self-test
node scripts/acceptance-agent.mjs self-test
```

The executor self-test includes both required end-to-end fixtures:

- Pending -> structured Pass -> deterministic update -> checkbox/report synchronized -> existing merge gate passes.
- Pending -> structured Fail -> deterministic update -> checkbox remains unchecked -> existing closure gate rejects acceptance.

A successful Acceptance workflow only means the acceptance infrastructure executed and wrote a valid result. Whether the Requirement is merge-ready or closable remains a separate deterministic gate decision.


## Source-aligned Acceptance Cases

Use a source-aligned Case when one Success Criterion needs executable evidence tied to an exact product SHA. The canonical shape is `e2e/acceptance/cases/<issue>/<SC>/`: **one Case per Issue/SC**, one independently reported result, optional multiple verifier steps.

Choose the Case stage from the Issue Acceptance Report. Use `browser` for UI/browser-observable behavior, `protocol` for wire/WebSocket behavior, and `runtime` for orchestration/process/config/file evidence. All verifier types may share the same `full-stack-local` Runtime Harness; protocol/runtime verification must not launch Playwright unless a browser verifier is declared.

A Case Pass requires concrete evidence from every declared verifier. Skip/absence is Pending. Results pin exact target SHA, Case revision/tree SHA and SC contract digest. Compact immutable records are ingested into the append-only `acceptance-results` orphan branch; large traces/screenshots/logs remain workflow artifacts.

Automatic Case execution maps staging push → `staging` and main push → `post-merge` using exact SHA Requirement association discovery. Manual replay must select Issue, SC, exact 40-character SHA, stage and runtime profile.

Security boundary: target Case code is read-only (`contents: read`, `issues: read`). It must never mutate an Issue, push result branches, or receive production secrets. Only trusted `main` ingestion/updater code may write `acceptance-results` and project an eligible result into the Issue, after current-SHA, association and contract-digest checks.

For the full creation, stage selection, verifier choice, evidence quality, archive/promotion and future remote-profile rules, read `docs/architecture/acceptance-cases.md`.
