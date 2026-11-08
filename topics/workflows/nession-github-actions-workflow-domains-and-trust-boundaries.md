---
title: "Nession GitHub Actions workflow domains and trust boundaries"
description: "Canonical workflow ownership, event routing, source identity and privilege boundaries"
topic: workflows
categories: ["architecture","ci","security","workflows"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-08T13:51:42Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.claude/skills/nession-workflows/SKILL.md","https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/scripts/workflow-conventions.mjs","https://github.com/BestNathan/nession/issues/1649","https://github.com/BestNathan/nession/issues/2953","https://github.com/BestNathan/nession/blob/8352d3abb6f3c73b07db2fed1357566aa17f74b2/scripts/staging-convergence-batch.mjs","https://github.com/BestNathan/nession/blob/4c4e903b670a8b1c9b5ec67c5b7fde6982b27c6e/.github/workflows/release-staging-convergence.yml","https://github.com/BestNathan/nession/blob/cb81cd3469b9824d88adc26193ac30655e8070d5/.github/workflows/agent-staging-convergence-review.yml"]
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

## Source-bound Staging convergence and Issue E2E authority (#2953)

The trusted-Main `Release / Staging Convergence` controller discovers deploy-eligible **branches** from existing staging deployment triggers. It pins `main_sha`, `lane_sha` and a checked two-parent integration head (Staging first, Main second); no force pushes or direct-Main-to-diverged-Staging merge bypasses. An exact batch reuses or creates one open Requirement with a stable source marker, and the integration PR links that Issue with the canonical `Refs #N` association.

The main-owned E2E planner derives New/Regression browser `.spec.ts` IDs from the **actual first-parent commit history and the integration tree**, not merely the final net diff. A browser spec touched and restored still remains a regression obligation. Absent or malformed Issues, stale refs, missing IDs, unknown risks and untrusted result receipts stay fail-closed. The general path-impact classifier does not grant an Issue E2E waiver: the current Issue Audit plus an exact head/declaration-digest owner approval is required for unknown or mixed scope; only positively tooling-only **zero-ID** batches can receive a separate authenticated main-owned Audit attestation. The model can propose and review, but cannot independently create E2E/Acceptance Pass evidence.

Owner `/approve-staging-convergence ...` comments and authenticated bot Audit receipts are **wake-up events**, not merger credentials. The controller re-reads live refs, the approved Issue, required exact-head CI/E2E/Case workflows and GitHub clean protected mergeability before using the `merge` method and expected head SHA. An actual merge-tree conflict leaves a visible blocked PR; read-only `Agent / Staging Convergence Review` uses live remote refs (not the potentially stale GitHub PR `base.sha` snapshot) and publishes only a nonauthoritative repair proposal. A separate trusted code repair and real checks are necessary.

**Observed integration:** [Issue #2984](https://github.com/BestNathan/nession/issues/2984) linked [PR #2985](https://github.com/BestNathan/nession/pull/2985), whose exact `91af0907d508224d55e469adfa6442f440b70432` head had successful Quality, Case Smoke, Pages and E2E workflows. After exact owner approval, an **owner-initiated** protected merge commit `d4025428dcb79cfd273a16a66ff828cd2288eb54` reached staging; [Staging Artifacts run #42485547869](https://github.com/BestNathan/nession/actions/runs/42485547869) completed its GitOps deployment. This is real protected-merge/deployment evidence **but is not a claim that the controller itself initiated that merge**. A later, divergent source pair correctly remained blocked on conflict (PR #2998); owner approval for #2984 cannot be reused there.

## Related knowledge

- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — which proofs apply at PR, staging, main and deployed boundaries.
- [Nession public Pages source publication and orphan-branch signals](nession-public-pages-source-publication-and-orphan-branch-signals.md) — a concrete safe cross-branch event bridge.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md) — executable owners outrank the derived wiki.

## Limits / when to revisit

This summarizes canonical workflow ownership as of source SHA 5eaaf2cf07d5 and the #2953 source-bound convergence implementation through cb81cd3469b9. New main/staging conflicts, approvals or deployment outcomes require their own exact-SHA evidence. Validate live workflows, protected refs, Gates and Issue authority when the implementation changes; this article is not a second workflow policy engine.
