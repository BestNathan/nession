# Orphan Run Store security rollout — #1690

## Verified starting point (2026-10-15)

Three public orphan refs exist: acceptance-results, task-results and metrics. At the observed baseline all three have protected=false and the single repository main Ruleset (18303429) is disabled. The separately captured current Git tree observations are in scripts/run-store-migration-baseline.json. They are **migration observations**, NOT an external/WORM anchor or retroactive proof of past writes.

Writers: acceptance-results uses acceptance-case-ingest, e2e-scenario-ingest and e2e-test-ingest; task-results uses task-result-ingest; metrics uses metrics-agent-telemetry and metrics-repository. These six must all be migrated before the write restriction is enforced. Agent-store is not provisioned and must never contain private plaintext in a public branch.

## Stage A — read-only discovery, no privileged mutation

The canonical audit implementation is scripts/audit-live-run-stores.mjs. The Store / Governance Audit workflow now reuses it with separately labeled repository-main migration observations. It verifies live GitHub API head versus Git fetch, orphan ancestry from that baseline, each linear append and immutable path classification, forbidden ordinary fast-forward overwrite and deletion. Its read-only companion scripts/run-store-governance-live.mjs inspects GitHub Ruleset DETAILS, not merely the protected badge. The audited workflow has contents:read and actions:read and never writes an orphan ref, a Ruleset or an Issue.

The Ruleset policy requires, for EACH exact refs/heads/{store}, an active repository branch Ruleset containing creation, update, deletion, non_fast_forward and required_linear_history, with precisely ONE GitHub App Integration bypass matching RUN_STORE_WRITER_APP_ID in always mode. RepositoryRole, User, admin or unrelated App bypass does not pass. A config match is not a live writer-denial test.

Read-only governance history comparison can succeed while authorization is absent; that produces a FAILED audit with a retained report. GitHub Actions run failures and retention-limited artifacts are not an independently durable alert channel. They do not constitute Acceptance SC Pass.

## Stage B — minimal privileged App and Ruleset (administrator required)

GitHub Rulesets restrict ordinary fast-forward updates in addition to force pushes; see https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets and https://docs.github.com/en/rest/repos/rules.

1. Independently create/install a minimum-privilege GitHub App for this repository, granting only necessary Contents:write access. Record the App installation ID and set the nonsecret RUN_STORE_WRITER_APP_ID for observation. Never put the App private key in agent sandboxes, PR checkouts, untrusted producers, a public orphan store, git remote URLs or output logs.
2. Before changing any production Ruleset, stage the App writer on a DISPOSABLE ref or disposable repository. Real app append and exact idempotent replay must succeed. Divergent same-key append must fail. Two simultaneous approved writers must use expected-head CAS and bounded retry without force or history reset.
3. Prepare EVERY one of the six existing main-owned writer workflows to mint short-lived App tokens and push through their trusted job only. Preserve the existing serialization groups acceptance-results-ingest, task-results-ingest, metrics-writer. Do not introduce arbitrary-ref workflow_dispatch or run PR-supplied code with a privileged token. Keep the original GITHUB_TOKEN permissions as read-only wherever possible.
4. Activate the exact-ref Ruleset only AFTER all six trusted App writes are proven. Configure creation/update/deletion and force-push block, linear history and the reviewed App Integration as the only bypass. A Ruleset restricting all writers is an outage, not success.
5. Run the real denial matrix ON DISPOSABLE REFS: user PAT, unrelated GITHUB_TOKEN, untrusted-ref workflow and ref delete/rewrite/ordinary fast-forward overwrite must be denied. The approved App append must work. Capture exact actor, token source CLASS (never token), attempt ID, run URL, source/commit SHA and GitHub API HTTP status. Then verify actual Case/Scenario/Test/Task/Metrics ingestion after the change. Until these exist, SC-02/03/04/09 are not live proof.

Note: A bypass App can still write disallowed file paths unless its scripts enforce the immutable contract. Retain scripts/run-store-integrity.mjs staged validation for every publisher. Signed-looking Git author labels are not authentication.

## Stage C — external checkpoint and read-only recovery

The existing CI / Run Store Integrity Audit workflow stays disabled until an independently reviewed RUN_STORE_AUDIT_ANCHORS_JSON and RUN_STORE_AUDIT_ENABLED=true are provisioned. An Actions repository secret can be changed by an administrator; it is NOT WORM. Use separately controlled immutable/signed checkpoint storage, containing ref names, commit SHA, tree SHA, canonical path/blob digest, monotonic checkpoint number, signer and timestamp. A separately held private signing key is outside this repository's administrative boundary.

Rehearse a **read-only restore drill** into an isolated clone: verify head ancestry against the independent checkpoint, full Git tree and byte digests, representative legacy/new Run Record references, and record the first corrupt delta. Preserve the source and signature. Do not force-push, re-root, delete evidence, rewrite migration baselines or automatically mark SC Pass. A real incident requires independent alert delivery, a separately approved restore and key/authority rotation. GitHub Actions artifacts can expire and cannot be promised as permanent retention.

If GitHub repository plan, Ruleset API, or App-bypass permissions cannot enforce ONLY approved writers, keep enforcement Pending and use an independently controlled write ingress rather than inventing success. No Ruleset defeats repository/org administration authority.

## Proof and dependency boundary

- An unanchored baseline proves only ancestry since an observed Git commit **under continuing trust in this main repo**. Historical v1 records are not retroactively signed.
- The live audit is read-only, with policy failures surfaced as workflow failures and source-aligned artifacts. No second Issue Acceptance writer or orphan store is created.
- Immutable encrypted agent-store fixtures belong to the existing agent-checkpoint-store Gate. Production private checkpoint encryption, resume and agent-store provisioning remain #1664 responsibilities.
- Preserve SC-02/03/08/11 and any unsupported real producer/ingester evidence as Pending until independent real-world evidence exists.
