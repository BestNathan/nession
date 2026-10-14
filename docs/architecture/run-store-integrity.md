# Run Store Git history integrity — incremental audit contract (v1)

**Owner:** [#1690](https://github.com/BestNathan/nession/issues/1690) · **Validator:** `scripts/run-store-integrity.mjs` · **Gate:** `run-store-integrity`

## Scope and limitations

This is a **read-only, caller-anchored Git ancestry / tree-delta verifier** and a staged-change preflight for existing orphan Run Stores. It does not administer GitHub Rulesets, grant/refuse Git write credentials, create `agent-store`, or sign checkpoints. A green Gate verifies the detector using synthetic Git repositories, not production refs.

An orphan branch permits ordinary fast-forward commits that overwrite/delete historical blobs unless actual server-side updates are restricted. Signed commit labels, a non-force push, `git log`, or hashes read from the **same branch** do not establish append-only history. Require an independently controlled baseline SHA **outside** the store, audit all subsequent commits, and separately enforce the authorized GitHub App/Ruleset writer policy. An attacker who can change both baseline and ref can forge a clean audit.

## Supported stores

| Ref | Create-only | Explicitly mutable |
|---|---|---|
| `acceptance-results` | `runs/**`, `indexes/**`, `sources/**`, `README.md` | none |
| `task-results` | `runs/**`, `indexes/**`, `sources/**`, `README.md` | none |
| `metrics` | `raw/workflows/**`, `raw/events/**`, `README.md` | documented `metrics.json`, `agent-metrics.json`, `repo-metrics.json`, `agent-metrics-*.svg`, `repo-metrics-*.svg` projections |
| `agent-store` (future) | versioned `roles/<role>/<id>/issues/<issue>/checkpoints/*.json`, `runs/*.json`, `workflows/issues/<issue>/states/*.json`, `results/*.json` | exact `head.json` pointers only |

Unknown stores and paths, deletions, type changes and immutable modifications are errors. Renames are treated as delete + add (thus fail when deleting a protected historical record). A pointer change allowed by this classifier is **not** a completed CAS check: the specialized Store writer and separately anchored ref must validate expected-old head version and recorded bytes. This validator is deliberately **not** a second source of truth for Acceptance schema, Task record contents or Metrics aggregation.

## Auditing a bounded, externally anchored ref

An independently trusted operator or protected checker supplies `BASE`, the last accepted commit from an externally governed anchor, and the separately resolved `TIP`.

```bash
node scripts/run-store-integrity.mjs anchored metrics \
  /absolute/path/to/checked-out-metrics-store "$BASE" "$TIP"
```

This checks checkout HEAD equals `TIP`; `BASE` exists, is a real commit and ancestor of `TIP`; every intervening commit is linear; and each actual Git tree delta conforms to the store policy. An unrelated/replaced history, merge commit, overwritten record, deleted index or unexpected file fails closed. It will not attest the historical record state **at or before** `BASE`; migration requires an explicitly labeled *untrusted prior history / validated baseline*, never retroactive authenticity.

For a trusted writer **before** its non-force push:

```bash
git -C /absolute/path/to/store add -- runs indexes sources
node scripts/run-store-integrity.mjs staged acceptance-results /absolute/path/to/store
```

This catches unsafe staged changes in that writer. It cannot stop another user/PAT or changed workflow from pushing; only server-side Rulesets / a dedicated limited writer identity can do that.

## Rollout and missing prerequisites

1. Capture a **read-only** copy and external baseline of each existing ref; record that it is a migration baseline, not retrospectively signed Run Records.
2. Provision independent checkpoint/attestation authority, GitHub App writer and server-side ref Rulesets via parent #1690. Run actual negative tests against disposable refs/repositories first.
3. Only after trusted anchor provisioning, install the audit as scheduled read-only monitoring with immutable post-commit receipts, alarms and incident runbook. Do not obtain an anchor from a caller-controlled `workflow_dispatch` input, the audited branch, or an unprotected repository variable.
4. Do not provision or write `agent-store` until its encryption key boundaries and shared write rules are in place.

**Deterministic regression suite:** `./gates/run run-store-integrity` (includes fast-forward malicious commit, index repoint, history rewrite and projection/CAS fixtures). The Gate does not contact GitHub or write any production ref.

## Opt-in production read-only audit workflow

`.github/workflows/ci-run-store-integrity-audit.yml` runs under `CI / Run Store Integrity Audit` (scheduled daily and manually dispatchable). **It does not enable itself or create/modify refs.** The job is skipped until the repository variable `RUN_STORE_AUDIT_ENABLED` is exactly `true`.

Before opting in:

1. Independently review each live orphan ref's migration baseline and validate a read-only backup. Record SHA-1 commit IDs for `acceptance-results`, `task-results` and `metrics` **outside all of those Git branches**. Historical records before the baseline are not retrospectively attested.
2. Provision the secret `RUN_STORE_AUDIT_ANCHORS_JSON` (exact three-key JSON object of 40-character commit SHAs) under an authority separate from the untrusted Agent / producer and ordinary ingestion tokens. For example, `{"acceptance-results":"<40 hex SHA>","task-results":"<40 hex SHA>","metrics":"<40 hex SHA>"}`. Do not pass the manifest as a `workflow_dispatch` input, log the secret, or derive it from a newly observed ref during a check.
3. Grant only `contents: read` to the audit job. Protect the `main` workflow source and the secret's modification permissions. Set `RUN_STORE_AUDIT_ENABLED=true` only after the independent baseline is verified. Review the first scheduled/manual run and triage failures without rewriting any store.
4. Preserve accepted ref checkpoints under a truly independent, access-controlled/WORM or signed external authority when implementing #1690's stronger SC-08. **A GitHub repository secret alone is not WORM or administrator-proof** and does not by itself satisfy independent anchoring, server-side write restrictions, or recovery proof.

The runner checks its actual Git checkout against the event SHA, reads GitHub's current ref API for each fixed store, fetches only that ref into its **local tracking ref**, compares observed and fetched tips, checks the externally supplied baseline and intervening commit ancestry and all Git path/mode changes, and prints non-sensitive commit/count observations. Missing secret, unexpected repository/ref, GitHub 404, ref rewrite, malicious fast-forward overwrite/deletion, unclassified paths or executable/symlink blobs cause a failed job rather than an automatic repair or false Pass.

It does not audit the **non-existent** `agent-store` ref; add that only after a separately authorized provisioning/migration baseline. This opt-in workflow is a real production audit *path*, but while anchors and ref Rulesets remain unprovisioned, #1690's live authorization/independent anchor/alert acceptance criteria remain Pending. GitHub Actions failures are visible but not yet an independent durable alarm channel.

Gate: `./gates/run run-store-integrity` includes a disposable Git remote plus mocked ref API, a legitimate three-ref append, forged API tip, illegal fast-forward edit, and rewritten-ancestry tests.
