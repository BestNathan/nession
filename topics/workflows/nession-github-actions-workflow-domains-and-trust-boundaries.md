---
title: "Nession GitHub Actions workflow domains and trust boundaries"
description: "Canonical workflow ownership, event routing, source identity and privilege boundaries"
topic: workflows
categories: ["architecture","ci","security","workflows"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-03T09:34:15Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.claude/skills/nession-workflows/SKILL.md","https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/scripts/workflow-conventions.mjs","https://github.com/BestNathan/nession/issues/1649"]
---

# Nession GitHub Actions workflow domains and trust boundaries

## Direct owners

Nession classifies GitHub Actions by **direct responsibility**, never by the upstream trigger or subject being measured:

- **Agent** executes a model-backed Agent and emits canonical telemetry.
- **Acceptance** selects and evaluates Issue Success Criteria, ingests proof and projects results.
- **E2E** runs browser/runtime tests, scenarios and Cases.
- **CI** performs deterministic repository quality checks.
- **Metrics** consumes telemetry and aggregates evidence without changing Acceptance outcomes.
- **Deploy / Release** publishes artifacts, promotes versions or deploys to environments.
- **Task** executes generic ephemeral work; it is a distinct family, not miscellaneous Agent execution.

The workflow is a thin router. Domain semantics live in the owning scripts/Gates; workflow taxonomy, displayed names and compatibility inventory are owned by the [Workflow Skill](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.claude/skills/nession-workflows/SKILL.md) and [workflow conventions](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/scripts/workflow-conventions.mjs).

## Trusted execution and evidence

The responsibility chain is event → trusted route/plan → least-privileged execution → factual evidence → authenticated ingestion/evaluator → authoritative result. A workflow succeeding is neither an SC Pass nor proof of deployment. A generated Agent verdict cannot replace a required executable Case.

`workflow_run.workflows` references an upstream **display name**, whereas a reusable workflow references a **path**. These are APIs: changing either name requires migrating consumers, allowlists and tests. A privileged `pull_request_target` consumer must never execute untrusted PR-head code with secrets or write credentials.

Cross-branch producers are notifications, never trusted program inputs. Main-owned consumers verify branch, repository, event and conclusion and run only trusted source code. Run/Attempt/target SHA identity prevents stale or unrelated observations from becoming evidence.

## Related knowledge

- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — which proofs apply at PR, staging, main and deployed boundaries.
- [Nession public Pages source publication and orphan-branch signals](nession-public-pages-source-publication-and-orphan-branch-signals.md) — a concrete safe cross-branch event bridge.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md) — executable owners outrank the derived wiki.

## Limits / when to revisit

This summarizes the checked-in architecture at source SHA 5eaaf2cf07d5. Validate actual workflow files, current Gates, permissions and upstream identities whenever behavior changes. Do not treat this article as a second workflow policy engine.
