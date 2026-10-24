# Staging Acceptance Migration — Measurement and Rollback Report

Status: evidence report for #2323 SC-09 (2026-10-25 UTC). It measures the implemented fast-gate, deployment-identity and Main-qualification flow and records the observed fail-closed negatives. It is not a claim that remote deployed-environment Full coverage exists; that boundary is #1616 / SC-11.

## Sources

Measurements come from GitHub Actions run metadata for PRs #2382–#2414 (the migration slices) and their workflow runs, plus the deployment identity runs:

| Run | Purpose |
| --- | --- |
| `40126390290` | `Release / Staging` push build with per-registry provenance |
| `40128818089` | trusted dispatch staging build after the workflow-only sync |
| `40130608489` / `40131539771` | `Deploy / Identity` staging / staging-01 successes |
| `40130667135` / `40131596062` | `Deploy / Identity Ingest` successes |
| `40136487398` | `E2E / Staging Lanes` admission (both lanes ADMIT) |
| `40126520270` | scheduled Main Full (full job success) |

## 1. Fast gate on the new flow

Successful runs whose head branch belongs to the migration PRs:

| Check | n | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| `CI / Quality Gate` | 33 | 4.9 min | 5.9 min | 6.0 min |
| `E2E / Tests` (selected) | 25 | 3.8 min | 9.3 min | 24.4 min |
| `Acceptance / Case Smoke` | 26 | 3.3 min | 3.8 min | 14.9 min |

PR open → merge for the migration slices: **n=28, p50 5.8 min, mean 7.2 min, max 45.5 min**. The immediately preceding same-day PRs (#2340–#2381) measure **n=30, p50 9.2 min, mean 35.6 min, max 376.6 min**. This is an observational comparison, not a controlled A/B: the later slices are CI/infra changes with small diffs, and merge timing also reflects when the implementing agent finished each slice.

## 2. Deployment identity and scheduling

- `Deploy / Identity` success runs complete in **0.7 min** (two observed successes); fail-closed runs finish in **0.4–1.5 min**, so an untrusted deployment never delays a decision.
- `Deploy / Identity Ingest` completes in **0.3–0.4 min** and appends the immutable record + index through the shared CAS writer.
- `E2E / Staging Lanes` completes in **0.3 min**; its artifact persists per-lane `admitted_at` for the next due decision.

Admission receipt (`40136487398`) against pinned Main `e1d8a8aa`:

| Lane | Decision | Deployed SHA | Ahead | Behind | Next due |
| --- | --- | --- | --- | --- | --- |
| staging | ADMIT | `10b8bb78` | 8 | 47 | +2 h |
| staging-01 | ADMIT | `10b8bb78` | 8 | 47 | +2 h |

The lanes are diverged (`behind > 0`) and remain eligible because they contain work not yet in Main.

## 3. Main qualification latency

Successful `E2E / Full Regression` runs: **p50 13.9 min**. Push-triggered exact-Main runs observed 12.3–24.1 min; the scheduled run `40126520270` took 13.9 min. The scheduled tick before it (`40116583608`) admitted but skipped `full` as not due, so the 12-hour cadence gate is not firing hourly.

## 4. Observed fail-closed negatives

These are real runs or their fixtures; none produced a fabricated Pass:

- Stale provenance (`295803f`) against a newer GitOps overlay (`e35917c`) → rejected.
- GHCR index digest vs ACR index digest after the mirror rebuild → rejected until provenance recorded both (`agent workload imageID does not match the immutable provenance digest`, run `40127615260`).
- Missing provenance artifact on a pre-producer build → `no artifact matches...`, fail closed (run `40118354470`).
- No trusted `Release / Staging` run for the deployed dispatch build → `found 0` (run `40129910419`); fixed by accepting the trusted dispatch event.
- Shell quoting in the jq comment → step failed before any decision (run `40130241095`).
- Mirrored pod status image (`crpi-…`) vs GHCR Deployment spec → `no ready pod reports the agent deployment image` (run `40130611185`); fixed by role-tag matching.
- Unattested lane → `INDETERMINATE`, never a skip; duplicate lanes, invalid timestamps and ambiguous newest executions are rejected by policy fixtures.
- Equal/behind lane → `SKIPPED_NOT_AHEAD`; diverged-ahead lane stays eligible (`stagingLaneAdmission` fixtures).
- Deployed Case projection with a missing, cross-environment or digest-mismatched attestation → rejected (`verifyDeployedProof` fixtures).

## 5. Rollback runbook

### Bad Main integration

1. Do **not** rewrite the Main history or force-push.
2. Open a revert PR for the offending merge commit (`git revert -m 1 <merge-sha>`) and merge it with `--merge`. The revert is a new Main SHA, not a restoration of the old tip.
3. The exact-Main Full Regression triggers for the revert SHA. Release readiness remains blocked until that SHA has an authenticated Pass; never reuse the prior SHA's receipt.
4. Open a regression/repair incident and reference the bad merge SHA. Do not reopen completed feature Issues; their Staging `Development Complete` evidence remains valid for its exact environment/revision.
5. If the batch promotion itself was wrong (unaccepted or superseded lane content), repair the batch manifest and re-promote; do not attempt to mutate existing `acceptance-results` records.

### Bad staging lane deployment

1. Roll back the GitOps desired state with a `git revert` of the `deploy(<env>): <ref>` commit on the `gitops` branch; ArgoCD resyncs to the previous revision.
2. Re-run `Deploy / Identity` for the lane and record the new attestation. Earlier receipts stay in the append-only Store as historical evidence for their exact SHA/digests.
3. If only one lane is affected, keep the other lane's receipts; lane identity is part of every record.

### Bad provenance or attestation

1. Never edit or force-push `acceptance-results`; a divergent replay fails closed.
2. Fix the producer (build/mirror) and produce a new receipt through a new trusted run. Do not patch digests into a stored record.
3. If a stale attestation could be selected, rely on `selectDeploymentBinding`/`latestDeploymentBinding`: they compare exact environment + SHA and reject ambiguous ties.

### Release blocked by a missing/failed Full

1. Release remains blocked; do not lower the gate or publish images.
2. Diagnose the Full failure at its exact SHA; fix and land a new Main merge, then wait for that SHA's Full.
3. Production approval remains required; a green periodic run for an older Main SHA never qualifies a newer one.

## 6. Limitations

- No controlled before/after benchmark: samples are migration slices, not a randomized user population.
- The admitted lane run is the `full-stack-local` suite at the deployed revision, not a remote deployed-environment Full; partial remote coverage must be labeled Partial/Remote, never Full Pass (SC-11 / #1616).
- The #2327 error-fingerprint dedup integration is not exercised here.
- GitHub Actions schedule delivery is not real-time; the admission receipt, not the cron tick, owns due decisions.
