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
