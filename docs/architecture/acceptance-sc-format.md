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


## Issue lifecycle states

The canonical lifecycle ordering is executable in `scripts/acceptance-lifecycle.mjs` (Gate `acceptance-lifecycle-selftest`). It never skips a state:

1. **Development Complete** — every applicable SC passed in one eligible Staging lane at the exact tested revision. An ordinary Issue may close here; Main promotion and Full Regression are **not** prerequisites.
2. **Main Promoted** — a batch promotion merge explicitly includes the accepted source SHA. A Main merge without the Staging proof is not Main Promoted.
3. **Regression Qualified** — Full Regression passed for the exact promoted Main merge SHA. A green run for any other SHA never qualifies a newer Main.
4. **Released** — the release admitted the same SHA with the required approvals.

A failure after Development Complete opens a Main/integration incident and blocks release; it does not retroactively invalidate the Issue's Staging proof or reopen completed feature Issues.

Executable consequence: `scripts/requirement-acceptance.mjs` requires `Pass`/`N/A` at closure only for `pr` and `merged/staging` criteria. A `merged/main` or `deployed` criterion is release qualification — its truthful `Pending`/`Fail` row blocks release, but it does not reopen or block the Issue at Development Complete. `scripts/acceptance-lifecycle.mjs` (Gate `acceptance-lifecycle-selftest`) owns the state ordering. Test and docs-only promotions that cannot affect runtime use an explicit authenticated `Not Required`, never a fabricated Full Pass.

## Minimize proof latency without weakening trust

**Pick the earliest safe proof boundary per SC; runtime topology is not a
requirement.** In particular, a Developer Worker that currently runs only
on `main` does **not** imply that functional correctness requires
`when: merged, branch: main`.

| Kind of invariant | Preferred boundary | What counts as proof |
| --- | --- | --- |
| Model/Registry binding, malformed configuration rejection, CLI/version/Harness mismatch | PR head | deterministic negative and regression cases pinned to that head |
| Real isolated Qwen Developer edit, checkpoint persistence and replay, multiple Jobs/Runs, tamper tests | staging merge | authenticated staging Runner with provider credentials scoped to staging, exact SHA/Run/Attempt, ciphertext and Store CAS observations |
| The final trusted main Dispatcher/Outbox receipt and downstream integration | main merge | narrow real main Run, signed Store receipt and Publisher→Reviewer handoff; no generic full-suite rerun |
| Live production behavior | deployed artifact/revision | actual authenticated release and remote observation; **not** a main push |

Only select `method: agent` for read-only inspection of concrete existing
code, CI and authenticated receipts. A generated summary is not a substitute
for an executed runtime assertion: use `method: case` and its required
source-aligned Case for a real behavioral verifier.

### When staging integration infrastructure is missing

A staging proof must not borrow the privileged `main` Worker to sidestep the
stage contract. Establish a trusted main-owned, isolated staging executor,
with limited staging Environment credentials, distinct State/Store namespace,
no untrusted PR code with secrets, an immutable input SHA and authenticated
Run/Artifact/CAS receipts; the existing trusted ingest/projector remains
the sole result writer. Until verified, keep the staging SC `Pending` and
make this missing lane an explicit prerequisite. Never convert that
`Pending` to `N/A`, model opinion, or an unrelated passing `main` canary.

For exceptional `merged/main` SCs the Issue's Requirements prose must
identify the **main-only invariant**, why PR or staging cannot prove it,
the exact minimal expected evidence and how missing or negative evidence
blocks completion. `when: merged` is not a requirement for Full E2E, and
it does not imply successful production deployment.

A proof plan migration must preserve each meaningful SC ID, the original
Run/Attempt/SHA evidence and failures, and record why prior evidence is
not yet interchangeable. Changing the plan modifies the SC contract
digest; historical evidence stays historical and must not be silently
retargeted to a different branch/stage.

## Risk-based verification tiers and Full E2E

Nession classifies issue verification scope using one label: `verification:scoped` (L1), `verification:integration` (L2), or `verification:full` (L3). Labels are mutually exclusive; legacy unlabelled issues default to L1 until a trusted reassessment. The read-only assessment helper and negative fixtures live in `scripts/verification-tier-policy.mjs`.

| Tier | Mandatory work | When Full Regression becomes a gate |
| --- | --- | --- |
| L1 | Impacted Quality, selected E2E IDs, issue-specific SC evidence | Never automatically |
| L2 | L1 plus named cross-component/route integration Cases | Never automatically |
| L3 | L2, with full-system verification only at an explicit critical milestone | At the milestone on its pinned exact SHA |

Proof **stage** (`when: pr / merged / deployed`) and verification **scope** (L1/L2/L3) are independent. Routine `when: merged` may require selected E2E at the real merged SHA, not a Full E2E run. Major parent requirements may have L3 final acceptance while child PRs close from L1/L2 evidence. Any Full Regression triggered by Audit, scheduled, release or manual operation is a distinct SHA-bound record; an absent unrequested run is not a failure and not a Pass.

Author SCs as observable behaviors rather than repetitive infrastructure checklists. Never add generic post-merge "every suite green" acceptance to a new ordinary Issue. Only a deliberate L3 integration or release criterion may make full-regression evidence a blocking dependency; declare its target, milestone and source, and preserve exact-SHA trust. Do not loosen real failed relevant Cases, compatibility/security guards, or previous SC evidence to make an Issue close.

## Compatibility and security

- Pre-v2 four-column `Criterion | Stage | Result | Evidence` Reports stay readable; when a Plan also exists, any explicit Stage disagreement fails validation.
- Pre-v2 three-column Reports **without** an Acceptance Plan preserve their historic `staging` meaning. Do not retroactively invent a plan/method or overwrite historical acceptance evidence.
- A new three-column Report **with** a Plan inherits its effective stage from that Plan. All validators, Agent/Case selectors, contract digest computation and Issue projector must agree.
- Changing report presentation alone cannot invalidate stable SC contract digest or grant an additional proof method. The digest includes SC text, effective stage and explicit Plan, not the Markdown table layout.
- Case Coverage is required only for `method: case`; `method: agent` must not impersonate a runtime Case. Source Run, SHA, attempt, contract digest and trusted writer remain mandatory.
- Do not automatically rewrite existing Issues or orphan Run Records. Historical evidence and `Stage` syntax must remain immutable/readable; migration is opt-in by authorship.

## Validation and ownership

Use `node scripts/acceptance-plan.mjs self-test`, `node scripts/issue-contract.mjs self-test`, `node scripts/requirement-acceptance.mjs self-test`, and `node scripts/acceptance-executor.mjs self-test` or the owning Gates. New negative fixtures must cover invalid method/target, Stage mismatch, stale/forged results and missing Case. `nession-writing-requirements` owns authoring instructions; `nession-acceptance` owns execution/projection; `nession-gates` owns blocking verification.
