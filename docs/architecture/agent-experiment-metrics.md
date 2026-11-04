# Agent experiment analysis (read-only)

Parent #1664, delivery #1737. This tool consumes existing trusted Agent Metrics and separately authenticated Issue/Review/SC evidence. It does not publish another Metrics store, close Issues, or grant authority to Agent output.

## Pinned source workflow

First, use a trusted job to check out the metrics orphan branch at a specific Git commit, with a clean raw/ directory. Obtain a proof snapshot from existing trusted Issue/Acceptance/Checkpoint owners and its independently verified SHA-256 digest via a trusted channel. A hash computed by an untrusted source and supplied by that same source is NOT authentication.

Run the local analyzer with five positional values: generate, METRICS_CHECKOUT, METRICS_COMMIT_SHA, TRUSTED_ISSUE_EVIDENCE_JSON, EVIDENCE_SHA256, OUTPUT_DIR.

Command: node scripts/agent-experiment-report.mjs generate /trusted/metrics METRICS_COMMIT_SHA /trusted/evidence.json EVIDENCE_SHA256 /tmp/agent-report

Outputs: report.json, report.md, lineage.json. Output directory must be empty. Re-running at the same source/digest produces byte-identical results. No secrets, native conversations or model output are copied to the report.

## Trusted evidence schema

JSON object keys: schema_version=1, kind=trusted_agent_evidence_snapshot, repository=BestNathan/nession, reviews=[], acceptances=[], checkpoints=[].

Each Review entry requires issue, pr, agent_id, sha, outcome (approved or changes_requested), run_id, attempt and ordinal (first Review ordinal 1). Each SC entry requires issue, sc (SC-01 etc), sha, outcome (Pass, Fail, Pending), run_id and attempt. Each checkpoint entry requires issue, agent_id, sha, recovered (boolean), run_id and attempt.

Proof records must be independently verified by the canonical owner before export. Their exact Issue + GitHub Run/Attempt + target SHA must match a trusted canonical Agent run. Duplicate and unmatched evidence is rejected. An exporter is responsible for authorization; the file or its digest does not authenticate itself.

## Measurement semantics

- Groups: Issue / Role / Agent ID / Provider / model / effective Harness digest. Qwen running under Claude Code is provider=claude-code.
- Observed zero differs from unobserved. Partial or unobserved trace coverage produces null aggregate Tool, Skill, MCP counts, with explicit observed and total denominators.
- Turns and model usage events are not automatically request counts.
- USD aggregation requires a complete homogeneous charged or estimated cost basis. Mixed/unknown returns null; cost absent does not mean zero cost.
- First-pass Review counts approved first decisions divided by evidenced first Reviews per PR, without assuming unseen Reviews did not happen. Missing proof returns null.
- Accepted-SC costs/tokens are attributed only to a unique matching Run and exact SHA. This is not total causal workflow cost unless the trusted proof exporter supplies full attribution.
- Checkpoint recovery counts only authenticated observed recovery attempts. Synthetic Qwen file edits are not recovery proof.
- Developer vs Acceptor runs have different tasks; their Token totals do not establish comparative model effectiveness. A valid A/B experiment needs matched tasks, policy, Harness, evidence and cost basis.

Gate: ./gates/run agent-workflow-telemetry
Self-test: node scripts/agent-experiment-report.mjs self-test

## Observed per-Agent execution outcome semantics (#2720)

`agent_workflow_run` is the canonical source. The metrics generator reports
one execution per unique repository / workflow / GitHub Run / Run Attempt /
unique execution name; a rerun Attempt counts independently, and multiple model
requests/retries within that execution do not. Duplicate source identities
must be rejected before aggregating. Workflow-only contract checks that never
invoked an Agent do not generate execution records.

For public per-Agent analytics, the source must attest both `agent.role`
(developer/reviewer/acceptor/auditor) and `agent.id`. Missing identities
are **unattributed**, not assigned by Workflow, provider, actor or Issue.
`result.status` is mapped to these execution outcomes:
- **success:** `success`, `succeeded`, `completed`, `repaired`, `passed`
- **failure:** `error`, `agent-error`, `contract-fail`, `failed`,
  `failure`, `invalid-result`, or `agent.status=error`
- **cancelled:** `cancelled`, `canceled`
- **timed_out:** `timed_out`, `timeout`, `timed-out`
- **unknown:** all other, missing, pending or unrecognized results.

An Agent execution marked `completed` may still carry failed/pending
Acceptance SCs: execution success is **not** Review approval, SC Pass, or
GitHub workflow success. Per-Agent outcome totals cover each observed 7/30-day
window. Success rate is `success/(success+failure)` only when denominator is
positive; cancelled/timed-out/unknown are separate buckets. Historical and
partial source coverage stays explicitly unavailable or truncated.

The Pages producer publishes only a capped per-Agent recent Run/Attempt sample
with canonical GitHub Actions links, workflow, observed Issue, provider, time,
and optional duration. The aggregate totals need not equal the sample size.
A pinned read-only `metrics` checkout and a bounded allowlisted Pages
projection preserve data lineage without a second ingestion service, browser
credentials or raw Agent records.
