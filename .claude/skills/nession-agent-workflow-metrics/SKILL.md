---
name: nession-agent-workflow-metrics
description: Use when adding or changing a Nession workflow that invokes an AI/Agent runtime, or when working on Agent execution telemetry, metrics persistence, aggregation, or README Agent metrics.
---

# Nession Agent Workflow Metrics

Every workflow that actually invokes an AI/Agent runtime must emit canonical Agent Workflow Telemetry. This is a repository invariant, not optional observability.

Use this Skill together with `nession-cicd` for workflow changes and `nession-gates` when changing the executable telemetry contract.

## Canonical record

The canonical owner is `scripts/agent-workflow-telemetry.mjs`.

Each actual Agent invocation emits one immutable `agent_workflow_run` JSON record with an explicit `schema_version`.

Required metric families:

- execution rounds/turns;
- model request count when observable;
- total tool calls;
- per-tool call counts;
- input/output/cache-read/cache-write/reasoning/total tokens when observable;
- raw/charged/estimated cost when the provider exposes those concepts;
- Agent duration;
- workflow duration when available;
- provider/model/run identity;
- task/result identity.

Unknown is `null`, never a fabricated zero. In particular, a provider that does not expose tool events must write `execution.tools.observed=false` with null counts.

Do not persist prompts, tool arguments, tool results, repository content, or final model conversation text in the metrics store.

## Stable persistence layout

The `metrics` orphan branch is the durable file store.

Raw telemetry is append-only at:

```text
raw/workflows/<workflow_id>/<UTC YYYY-MM-DD>/<unique_run_name>.json
```

`workflow_id` is a repository-defined stable lowercase logical ID, not GitHub's numeric workflow ID.

The canonical unique run name is:

```text
<github_run_id>-<github_run_attempt>-<task_id>
```

Reruns therefore create a new record rather than overwriting the previous attempt.

The date comes from `timing.started_at` in UTC.

A record must be self-contained; consumers must not need to parse its pathname to recover workflow/run/task/provider identity.

## Write boundary

Agent jobs do not receive metrics-branch write authority.

The flow is:

```text
Agent workflow
  -> canonical agent-telemetry artifact
  -> trusted Metrics Ingest workflow
  -> validate schema/path
  -> append immutable JSON to metrics branch
```

Only the trusted metrics-ingest boundary writes raw telemetry. The ingest boundary must fail closed on upstream provenance: validate the GitHub run's canonical workflow path/event (and main ref for workflow_dispatch sources) with trusted default-branch tooling, then require the record's `identity.workflow_id` to match that trusted source. Artifact names and artifact JSON are untrusted data and never establish provenance by themselves.

If the exact destination already exists:

- byte-identical content is an idempotent replay;
- different content is an error; never overwrite historical telemetry.

All metrics-branch writers use the same non-cancelling `metrics-writer` concurrency group.

## Aggregation

Derived metrics are projections, never source of truth.

`scripts/agent-workflow-telemetry.mjs aggregate` scans raw telemetry and regenerates:

- `agent-metrics.json`;
- `agent-metrics-light.svg`;
- `agent-metrics-dark.svg`.

README surfaces rolling 7d/30d Agent metrics. Raw files remain authoritative and make any future aggregation/window/grouping reproducible.

Useful aggregate dimensions include workflow, provider, model, result and tool name.

## Adding a new Agent workflow

Before the workflow is complete:

1. choose a stable `workflow_id`;
2. produce one canonical telemetry JSON per actual Agent invocation;
3. use a task ID that distinguishes matrix/subtasks within one GitHub run;
4. upload it as an artifact whose name starts with `agent-telemetry-`;
5. make Metrics Ingest observe that top-level workflow;
6. preserve unknown provider fields as null/unobserved;
7. run the telemetry self-test and `agent-workflow-telemetry` Gate.

A new Agent workflow without this telemetry path is incomplete.

## Provider adapters

Provider-specific code may collect native events, but it must normalize through the canonical telemetry owner.

Examples:

- Cursor stream tool-call events -> exact `tools.by_name`;
- Claude/DeepSeek JSON envelopes -> turns/tokens/duration/cost;
- if Claude output mode does not expose tool calls -> `tools.observed=false`.

Do not create workflow-specific metric schemas.

## Verification

Run:

```bash
node scripts/agent-workflow-telemetry.mjs self-test
./gates/run agent-workflow-telemetry
```

For workflow changes, also follow `nession-cicd` and validate the resulting GitHub Actions run.
