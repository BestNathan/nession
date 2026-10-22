# Run Store integrity audit — activation and incident runbook

**Owners:** [#1690](https://github.com/BestNathan/nession/issues/1690) and [#1742](https://github.com/BestNathan/nession/issues/1742). This procedure covers the optional **read-only** `CI / Run Store Integrity Audit`; it does not authorize a writer or attest historical content.

## Before activation (do not skip)

1. Confirm that **main** remains the trusted workflow source. Review production GitHub Rulesets for each of `acceptance-results`, `task-results` and `metrics`. Record whether ordinary fast-forward edits, force-push, deletion and unauthorized writer identities are actually blocked. If they are not, document the limitation under #1690; a successful audit is **not** a substitute for server-side authorization.
2. From an independently controlled, read-only backup, identify and manually review each orphan ref's **migration baseline** commit and manifest. Capture the baseline outside all three orphan branches. This does **not** retroactively authenticate data preceding those commits.
3. Under separately administered secret access, provision `RUN_STORE_AUDIT_ANCHORS_JSON` as an exact JSON object with three 40-hex SHA-1 commit IDs: `acceptance-results`, `task-results` and `metrics`. These values must come from the independently reviewed baseline, **never** from live ref tips or a `workflow_dispatch` input. Keep an independent signed/WORM checkpoint under a different authority when available. A repository secret alone is **not WORM**, and GitHub admins may change it.
4. Only once the anchors are verified, set repository variable `RUN_STORE_AUDIT_ENABLED=true`. For a **safe manual trigger**, use the authenticated default-branch `repository_dispatch` event `nession-run-store-integrity-audit` via `gh api -X POST repos/BestNathan/nession/dispatches -f event_type=nession-run-store-integrity-audit`, then review its run ID, attempt, exact main SHA and failure/success evidence. **Never use `workflow_dispatch` for this secret-bearing workflow:** it can execute a modified workflow from an arbitrary branch and leak the anchor secret. Scheduled executions use the same default-branch read boundary. Do not enable with unverified anchors merely to obtain a green check.

## What a green or red run means

A successful `./gates/run run-store-integrity` is **offline fixture evidence only**. A real successful job proves that the fetched branch tips matched the GitHub REST API tips at observation time and that all Git history *after the supplied baseline* followed the path/ancestry classifier. It does **not** prove the writers were authorized, that a baseline is independently immutable, or that a deleted/ref-replaced store is safe. GitHub Actions logs are not an independent durable alert channel, and the workflow does not perform automatic repair.

On failure, **do not update the baseline, force-push, re-root, replay, or mark Success Criteria Pass**. Preserve the failed workflow URL/run ID/attempt/main SHA, separately observe the three ref tips and their parent chains, and snapshot the suspect Git objects to read-only backup. Compare them against the independent checkpoint. Identify the first invalid commit/delta and confirm its actual actor and writer provenance using repository audit logs. Escalate the alarm outside the repository; preserve source artifacts within their declared retention windows. Restore only after separately approved incident review using a new reviewed authorized writer/checkpoint, without hiding the incident by replacing old evidence.

## Rotation, recovery and rollout boundaries

Rehearse a **read-only restore drill** on an isolated clone before production activation. Rotate anchors and writer credentials only under independent review with documented old/new signed checkpoint, verified ancestry and no silent history rewrite. Observe real Acceptance Case/Scenario/Test, Task and Metrics ingestion after restrictions are rolled out. Existing `agent-store` is **not** an audited production ref and must not be provisioned with plaintext session data.

**Pending under #1690:** server-enforced Ruleset/App writer isolation, real negative writer attempts, independently administered WORM/signed checkpoint, external durable alarm delivery and proven read-only recovery. Keep those SCs Pending until independently authenticated live evidence exists.
