---
name: nession-workflows
description: Use when designing, auditing, creating, renaming or consolidating Nession GitHub Actions workflows; deciding Agent/Acceptance/E2E/CI/Metrics/Delivery/Task ownership; or planning cross-workflow triggers, evidence, provenance, and safe migrations.
---

# Nession Workflow Architecture

This Skill owns **workflow taxonomy, naming, orchestration boundaries, cross-workflow references, and migration discipline**. It does not own the implementation of Acceptance evaluators, E2E runtime, Agent providers, deployment, Gate semantics, or metric schemas.

Load this before modifying `.github/workflows/` or introducing a new workflow family. Also load:

- `nession-cicd`: branch/PR policy, CI, release, staging and deploy behavior.
- `nession-acceptance`: **currently implemented** Issue/SC acceptance contracts and results.
- `nession-agent-workflow-metrics`: mandatory telemetry and trusted ingestion for real model invocations.
- `nession-gates`: stable executable invariants and Gate routing.
- `nession-writing-requirements`: Issue structure and Success Criteria.
- `nession-development`: isolated branch/worktree, verification and PR delivery.

## Status: target architecture vs. current contracts

The taxonomy and acceptance convergence below are the **approved design target tracked by Issue #1649**, not a claim that the repository has already been migrated.

Current authoritative contracts remain the checked-in code and skills: `scripts/issue-contract.mjs`, `scripts/requirement-acceptance.mjs`, `acceptance.yml`, `acceptance-cases.yml`, `e2e/run`, and the trusted ingestion scripts. Until a compatibility migration lands, the Acceptance Report stages remain `pre-merge | staging | post-merge`; do **not** create incompatible Issue/Case manifests or rename live workflows just because this Skill shows their future names.

Keep the **current** and **target** state explicit in reviews and PRs. See [Acceptance orchestration](references/acceptance-orchestration.md) and [Migration playbook](references/migration-playbook.md).

## 1. Classify by direct responsibility

Filename and GitHub Actions display name identify the owner, not the upstream trigger, language, runtime binary, or metric subject.

| Domain | File prefix | Actions display prefix | Direct responsibility |
|---|---|---|---|
| AI Agent | `agent-` | `Agent /` | Actually invokes a model-backed Agent for issue audit, SC assessment, provider smoke, etc. |
| Acceptance | `acceptance-` | `Acceptance /` | SC selection, orchestration, trusted evaluation, Gate and Issue projection |
| E2E | `e2e-` | `E2E /` | Test suite, Scenario, Case-independent E2E execution and observations |
| CI | `ci-` | `CI /` | Deterministic code quality and repository checks |
| Metrics | `metrics-` | `Metrics /` | Telemetry ingestion, metrics aggregation and repository health |
| Delivery | `deploy-` or `release-` | `Deploy /` or `Release /` | Build/release/promotion or deployment; distinguish artifact creation from rollout |
| Task (independent execution domain) | `task-` | `Task /` | Generic ephemeral Task execution and trusted Task record ingestion |

The first six are the principal product/engineering families; **Task remains an explicit independent domain**, not an unclassified exception. Reclassify other future domains only after identifying an actual direct owner.

**AI Agent identification is semantic**:

- Direct use of Cursor SDK, Claude Code/DeepSeek or another LLM Agent runtime -> `Agent /`; mandatory canonical Agent telemetry.
- A controller dispatching an Agent workflow without invoking the model itself -> `Acceptance /`, not `Agent /`.
- A workflow running the `nession-agent` executable as part of full-stack E2E -> `E2E /` or `Acceptance /`, not `Agent /`.
- A workflow reading Agent outputs or collecting tokens/cost -> `Metrics /` or `Acceptance /` as appropriate, not `Agent /`.
- A workflow that sometimes invokes a model and sometimes consumes deterministic input must split execution responsibility before advertising itself as Agent-only.

## 2. Keep workflow YAML thin

Normal boundaries:

```text
Trigger (PR, merged SHA, deployment, manual)
  -> trusted policy/orchestrator selects work and exact target
     -> executor produces evidence (Agent / Case / Test / Scenario / Task)
        -> trusted ingestion authenticates source run, artifacts, SHA, attempt
           -> canonical immutable record / authorized projection
              -> deterministic Gate or downstream reporting
```

- Trigger router: decides **when** to evaluate; it does not implement the evaluator.
- Planner/orchestrator: decides **which** SCs and **which** execution method, using a trusted contract.
- Executor: has only the permissions required to observe/run the selected target.
- Evidence producer: exports structured facts; must not grant its own verdict authority.
- Trusted evaluator/ingest: validates source identity and result contract before writing authoritative records.
- Projector/Gate: owns SC updates and merge/closure policy; one trusted write owner, never racing writers.
- Metrics: consumes telemetry without changing acceptance results; its `metrics` orphan store is not the E2E/Acceptance results store.

Canonical domain logic belongs to scripts/Gates/`e2e/`, **not duplicated across workflow YAMLs**.

## 3. SC proof is selected per criterion, not per branch

Target contract in #1649 separates:

- `when`: `pr | merged | deployed` — the boundary at which proof can be obtained.
- `target`: exact PR head SHA, merged branch SHA, or real deployed revision/digest + environment.
- `method`: `agent | case` — the proof mechanism.
- `evidence`: authenticated typed references/observations supporting a `Pass | Fail | Pending | N/A` result.

`method: agent` reads code, tests, and CI output **using read-only tools**. It may prove static/architectural SCs with concrete, reproducible references; unsupported claims are `Pending`. Agent judgment must not silently substitute for a declared runtime Case.

`method: case` runs the source-aligned `e2e/acceptance/cases/<issue>/<SC>/case.yaml` via the canonical E2E Runner, provisioning full-stack runtime only when required by the Case. A Case can use Browser, Protocol, Terminal and Process verifiers. Missing cases, all-skipped tests, or absent assertions **never** produce Pass.

**Case coverage applies only to case-method SCs**. Stage selects time/target, not proof method. Staging and main merged-SHA verification share a planner and runner; their inputs differ. Merging to main is not proof that production is deployed. Source/evidence from staging cannot automatically satisfy main without an explicit safe reuse policy.

Read [Acceptance orchestration](references/acceptance-orchestration.md) for the target contract, mappings and Gate interactions. Continue honoring the implemented three-stage Issue format until migration.

## 4. Trust, evidence and observability invariants

1. Bind every conclusion to the exact target SHA, SC ID, immutable SC contract digest, method, source workflow run/attempt/event and runtime/deployment identity.
2. Never execute untrusted PR-head or Case code in `pull_request_target` with secrets or Issue-write permission.
3. Separate read-only execution from trusted Issue mutation; untrusted artifacts and model output cannot authorize writes merely by containing `Pass`.
4. Retain immutable Run Records on the **one current authoritative results orphan branch**; large traces remain separately referenced and hashed. Do not commit result records to main/staging.
5. Distinguish evaluation `Fail`, insufficient `Pending`, execution `Error`, and workflow infrastructure status. Preserve verified negative/failed evidence.
6. Actual model invocations always emit canonical `agent-telemetry-*` artifacts, consumed by Metrics ingestion. A deterministic no-model path must not fake Agent telemetry.
7. A stable logical `NSESSION_AGENT_WORKFLOW_ID` is a metric/storage identity. Do not change it only because YAML file paths or display names change.
8. `workflow_run.workflows` selects upstream **display names**; reusable `uses: ./.github/workflows/...` selects **file paths**. Both are APIs and must be migrated deliberately.
9. Preserve source validation allowlists, Action artifact names, concurrency groups, CLI dispatch, exact-SHA CI evidence and required checks during migration.

## 5. Before any workflow change

1. Read `.github/AGENTS.md` and identify the owning Skill and trusted boundary.
2. Inventory current paths, displayed `name:` values, triggers, `workflow_call` consumers, `workflow_run` subscribers, artifacts, identity allowlists, Gate names and external references.
3. State whether work changes **only documentation**, **execution/policy**, **naming**, or **trust/mutation**.
4. For a rename, migrate downstream subscriptions, paths, provenance allowlists and telemetry before or atomically with source rename; verify no duplicate ingestion or lost events.
5. Run the `workflow-conventions` Gate (`node scripts/workflow-conventions.mjs self-test && node scripts/workflow-conventions.mjs check`): it inventories legacy and target names, checks missing consumers and distinguishes actual LLM invocation from mere use of an Agent binary/result. Keep its compatibility inventory synchronized during deliberate migrations.
6. Run relevant self-tests/Gates, inspect actual GitHub Actions trigger and source-run identity, and validate artifact ingestion/Issue projection as applicable.
7. For `.github/workflows/*` modifications, follow `nession-cicd` **main fast-track PR with merge commit**. Never silently loosen any existing gate for a rename.

Use [Migration playbook](references/migration-playbook.md) for the detailed rollout and current-to-target catalog.

## Boundaries and anti-patterns

- Do not call an orchestration workflow `agent-*` merely because it dispatches an Agent.
- Do not merge Agent, Case, Metrics and trusted Issue-write authority into a single credentialed executor.
- Do not require a Case for every SC; the SC's declared `method` decides.
- Do not treat a model-generated `Pass` as machine-executed E2E evidence.
- Do not treat a passing GitHub Action as a proof of production deployment.
- Do not introduce another acceptance Runner, independently writable SC projector, or competing authoritative orphan Run Store.
- Do not rename checked-in workflow files or the current Issue-stage schema without explicit backward-compatibility verification.

Related design: [Issue #1649](https://github.com/BestNathan/nession/issues/1649), foundational E2E platform [Issue #1474](https://github.com/BestNathan/nession/issues/1474).
