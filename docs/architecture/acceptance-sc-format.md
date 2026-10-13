# SC Acceptance format — canonical authoring v2

An SC has exactly one **observable criterion**, one **proof plan**, and one **trusted result projection**. Avoid treating historical `Stage` as a separate human-authored policy dimension. The executable source is `scripts/acceptance-plan.mjs` and its consumers (`issue-contract`, `requirement-acceptance`, `acceptance-executor`); this document is the authoring contract.

## Author once, project later

1. `Success Criteria`: stable `SC-xx` checklist plus observable outcome. Only the trusted projector checks it upon authenticated `Pass` or justified `N/A`.
2. `Acceptance Plan`: the per-SC **source of truth** for `when`, target selector and `method`. New Requirements should always include it and cover every SC.
3. `Acceptance Report`: the result/evidence projection **without a duplicate Stage field**. It must have a row for every SC; the trusted evaluator writes actual results.

Example:

````markdown
### Success Criteria

- [ ] SC-01 An untrusted PR cannot modify a trusted Acceptance result
- [ ] SC-02 Reconnecting to a running terminal retains ordered output

## Acceptance Plan

```yaml
acceptance:
  SC-01:
    when: pr
    method: agent
  SC-02:
    when: merged
    branch: staging
    method: case
```

## Acceptance Report

| Criterion | Result | Evidence |
|---|---|---|
| SC-01 | Pending | Awaiting exact PR SHA static/security evidence |
| SC-02 | Pending | Awaiting merged staging SHA source-aligned Case |
````

## Exact dimensions

| Field | Values | Interpretation |
|---|---|---|
| `when` | `pr`, `merged`, `deployed` | PR head SHA, merged SHA, or authenticated deployment revision |
| `branch` | `staging`, `main` | Required only when `when: merged` |
| `environment` | e.g. `production` | Required only when `when: deployed`; main SHA alone is insufficient |
| `method` | `agent`, `case` | Read-only source/CI analysis vs executable full-stack source Case |
| `Result` | `Pending`, `Pass`, `Fail`, `N/A` | Evaluated outcome, not GitHub workflow success/failure |

Existing runner compatibility needs a stage. It is **derived**, never copied into the new Report: `pr → pre-merge`, `merged/staging → staging`, `merged/main → post-merge`, `deployed/environment → post-merge` **for compatibility bookkeeping only**. A deployed SC is not executed on a plain main push. Real rollout must be bound to an independently verified environment/revision/digest before proving it.

## Compatibility and security

- Pre-v2 four-column `Criterion | Stage | Result | Evidence` Reports stay readable; when a Plan also exists, any explicit Stage disagreement fails validation.
- Pre-v2 three-column Reports **without** an Acceptance Plan preserve their historic `staging` meaning. Do not retroactively invent a plan/method or overwrite historical acceptance evidence.
- A new three-column Report **with** a Plan inherits its effective stage from that Plan. All validators, Agent/Case selectors, contract digest computation and Issue projector must agree.
- Changing report presentation alone cannot invalidate stable SC contract digest or grant an additional proof method. The digest includes SC text, effective stage and explicit Plan, not the Markdown table layout.
- Case Coverage is required only for `method: case`; `method: agent` must not impersonate a runtime Case. Source Run, SHA, attempt, contract digest and trusted writer remain mandatory.
- Do not automatically rewrite existing Issues or orphan Run Records. Historical evidence and `Stage` syntax must remain immutable/readable; migration is opt-in by authorship.

## Validation and ownership

Use `node scripts/acceptance-plan.mjs self-test`, `node scripts/issue-contract.mjs self-test`, `node scripts/requirement-acceptance.mjs self-test`, and `node scripts/acceptance-executor.mjs self-test` or the owning Gates. New negative fixtures must cover invalid method/target, Stage mismatch, stale/forged results and missing Case. `nession-writing-requirements` owns authoring instructions; `nession-acceptance` owns execution/projection; `nession-gates` owns blocking verification.
