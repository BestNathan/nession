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
