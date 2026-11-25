---
title: "Nession GitHub Actions workflow domains and trust boundaries"
description: "Canonical workflow ownership, event routing, source identity, privilege boundaries and the single Reconcile-owned durable Agent lifecycle"
topic: workflows
categories: ["architecture","agent","ci","security","workflows"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-25T19:13:20Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.claude/skills/nession-workflows/SKILL.md","https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/scripts/workflow-conventions.mjs","https://github.com/BestNathan/nession/issues/1649","https://github.com/BestNathan/nession/issues/2953","https://github.com/BestNathan/nession/issues/4482","https://github.com/BestNathan/nession/issues/4525","https://github.com/BestNathan/nession/issues/4526","https://github.com/BestNathan/nession/issues/4527","https://github.com/BestNathan/nession/blob/7f128a115d1278fa555877566664a0da037b6e2b/docs/architecture/agent-workflow-durability.md","https://github.com/BestNathan/nession/blob/7f128a115d1278fa555877566664a0da037b6e2b/scripts/lib/agent/workflow/recovery.mjs","https://github.com/BestNathan/nession/blob/a03b997b19207c2a0d5516f12ffce76d22469e57/docs/architecture/agent-workflow-durability.md","https://github.com/BestNathan/nession/blob/a03b997b19207c2a0d5516f12ffce76d22469e57/scripts/lib/agent/workflow/apply.mjs","https://github.com/BestNathan/nession/blob/4e30776748531bb03d6751585ee5ddc87a7c12af/docs/architecture/agent-workflow-durability.md","https://github.com/BestNathan/nession/blob/4e30776748531bb03d6751585ee5ddc87a7c12af/scripts/lib/agent/workflow/facts.mjs","https://github.com/BestNathan/nession/blob/4e30776748531bb03d6751585ee5ddc87a7c12af/scripts/lib/agent/workflow/scan.mjs","https://github.com/BestNathan/nession/blob/4e30776748531bb03d6751585ee5ddc87a7c12af/scripts/lib/agent/workflow/diagnostic.mjs","https://github.com/BestNathan/nession/blob/8783ecf6ab88322aa996e1614870a30d97f2ec58/docs/architecture/agent-workflow-durability.md","https://github.com/BestNathan/nession/blob/8783ecf6ab88322aa996e1614870a30d97f2ec58/scripts/lib/agent/workflow/lifecycle.mjs","https://github.com/BestNathan/nession/blob/8783ecf6ab88322aa996e1614870a30d97f2ec58/scripts/lib/agent/workflow/reconcile.mjs","https://github.com/BestNathan/nession/blob/8352d3abb6f3c73b07db2fed1357566aa17f74b2/scripts/staging-convergence-batch.mjs","https://github.com/BestNathan/nession/blob/4c4e903b670a8b1c9b5ec67c5b7fde6982b27c6e/.github/workflows/release-staging-convergence.yml","https://github.com/BestNathan/nession/blob/cb81cd3469b9824d88adc26193ac30655e8070d5/.github/workflows/agent-staging-convergence-review.yml"]
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

## Durable Agent lifecycle and Reconcile ownership (#4482)

The durable Agent workflow is one Issue-centric lifecycle owned by
`scripts/lib/agent/workflow/lifecycle.mjs` (`decideLifecycle`). The bounded
`scripts/lib/agent/workflow/reconcile.mjs` loop is the single coordinator:
authenticated GitHub events/completion hints, a GitHub schedule and an
authorized manual/external wake all feed the same decision path. A wake can
hint at active Issues, but it cannot start an arbitrary open Issue, select a
role, approve a result or authorize merge/SC/Store writes.

Business phases are `authorized → developing → publishing → ci_checking →
reviewing → evaluating → accepting → waiting_merge → post_merge_acceptance →
done`, plus durable `blocked` and authorized `cancelled`. One logical Developer
Thread persists across attempts, yields and repair rounds; retrying is not a new
Thread. Execution states (`pending/dispatching/dispatched/claimed/executing/
result_available/committed/retired`, with `yielded/failed/cancelled/ambiguous`)
are separate from business phase. A GitHub Run's queued/in_progress/completed
status is an observation, not an accepted result.

**CI precedes Review.** After the trusted Publisher confirms the exact PR HEAD,
`workflow/ci-barrier.mjs` freezes the applicable required-check set for that
HEAD. Pending waits; missing/cancelled/unknown/skipped-required is never a
pass; infrastructure-only failure recovers or blocks; source failure still
proceeds to Review. Reviewer then runs as an internal lifecycle action — never
a GitHub Check, required check context or branch-protection requirement, and
ordinary non-managed PRs never trigger it. `evaluating` combines the
independent CI and Review outcomes deterministically: pass+approved proceeds to
existing Acceptance; any actionable failure produces exactly one Developer
repair action carrying one immutable, deduped feedback bundle for that exact
HEAD/CI generation/Review result. A Reviewer approval can never override a CI
failure; a materially changed CI evidence generation invalidates the old
aggregate and Review before a new decision is bound.

State and receipts remain in the existing `agent-store` versioned Issue state
(no second database or engine). Decisions persist with expected-version CAS and
deterministic Thread/action IDs before any external effect; dispatch and
publication use write-ahead intent → external call → authenticated readback →
receipt, so a lost response is adopted by readback rather than sent twice.
Stale fences/HEAD/evidence, duplicate or out-of-order results, ambiguous
publication effects and exhausted infrastructure/model/repair budgets fail
closed or produce an explicit owner-recovery blocker. V1 immutable history is
projected by an explicit readback migration; an under-specified legacy state
becomes a durable blocked diagnostic. The legacy `advanceWorkflow` adapter never
drives a v2 state and V2 never accepts a v1 state.

**Production facts, fair scan and safe export (#4525).** The read-only
coordinator now observes through `workflow/facts.mjs`: every role fact binds the
exact action, Run ID/Attempt, source workflow, HEAD, fence and authenticated
Store receipt. Completed work without an ingested receipt is
`completed_uningested`, missing API/permission facts are `unavailable`, and a
mismatched Run/source/receipt/claim is `denied`; only a fully bound terminal
fact becomes a lifecycle observation. Publisher publication, Reviewer-verdict,
Acceptance and Claim readers are typed `unavailable` until their composition
slices wire them, so plan mode fails closed rather than inferring an effect from
a job conclusion.

`workflow/scan.mjs` scans only existing durable states. It excludes
`done`/`cancelled` records without outstanding obligations, preserves
blocked/legacy candidates, isolates malformed heads and rotates deterministically
over the raw candidate set, so a stable set is covered within
`ceil(candidateCount / maxIssues)` bounded ticks and no scan path starts a
lifecycle. The exported CLI artifact uses `workflow/diagnostic.mjs`, an explicit
whitelist; the private next-state plan, checkpoint binding, native session
identity/bytes, prompts, transcripts and free-text findings never leave the
trusted process.

**Trusted apply composition and wake routing (#4526).** `workflow/apply.mjs`
keeps plan as the default. Apply requires an explicit, fail-closed activation and
a complete scoped dispatch/publication/acceptance/notification composition; a
missing binding is refused, never replaced. The real Store port clones the
existing `agent-store` orphan ref, re-reads it for every CAS and publishes
through the existing non-force run-store writer: a stale expected version,
competing writer or lost acknowledgement is a conflict that forces
reload/re-observe, never a local-only success. An authorized start requires
explicit owner selection and refuses an existing v1 or v2 lifecycle, so two
engines cannot own one Issue. One wake router routes authenticated event,
schedule, manual and external wakes through the same coordinator; external is
wake-only and cannot authorize start/apply/merge/SC, redundant concurrent wakes
coalesce, and a lost event is recoverable by a later tick. Model/provider
credentials never enter the coordinator or effect boundary. Production
composition, activation and the real canary remain separately authorized under
the parent SC-06 boundary.

**Generic terminal recovery and checkpoint-preserving migration (#4527).**
`workflow/recovery.mjs` classifies an authenticated fact as healthy/queued/
claimed/executing, terminal result, completed-but-un-ingested,
committed-not-advanced, ambiguous, missing-result, expired-artifact,
denied-policy, terminal failure or unknown. A terminal failure with a verified
Run identity retires the action with an immutable receipt and creates exactly
one successor on the same logical Thread; an already-retired action cannot spawn
a second successor. Infrastructure/model budgets are cumulative across
successors and exhaustion blocks. A committed native checkpoint is retained on
retry; an incompatible/corrupt checkpoint blocks instead of forking a new
session; Reviewer failure recovers the Reviewer. Completed-but-un-ingested
results request idempotent trusted ingestion rather than a model rerun, while
ambiguous/unknown evidence blocks. V1 migration accepts authenticated PR,
committed-checkpoint, lease/fencing and proven-Run readback; it never replaces a
committed checkpoint with null or resets a fence, and an unproven ambiguous
dispatch blocks with a diagnostic.

Executable owners: `workflow/{contract,lifecycle,ci-barrier,feedback,migration,reconcile,facts,scan,diagnostic,apply,recovery,telemetry}.mjs`;
canonical architecture: [agent-workflow-durability.md](https://github.com/BestNathan/nession/blob/4e30776748531bb03d6751585ee5ddc87a7c12af/docs/architecture/agent-workflow-durability.md).
PR-stage criteria are proven by exact-source fixtures in the
`agent-provider-contract` Gate. The real main-owned SC-06 canary remains
Pending until the repository owner separately authorizes it; documentation and
fixtures are not that execution evidence.

## Source-bound Staging convergence and Issue E2E authority (#2953)

The trusted-Main `Release / Staging Convergence` controller discovers deploy-eligible **branches** from existing staging deployment triggers. It pins `main_sha`, `lane_sha` and a checked two-parent integration head (Staging first, Main second); no force pushes or direct-Main-to-diverged-Staging merge bypasses. An exact batch reuses or creates one open Requirement with a stable source marker, and the integration PR links that Issue with the canonical `Refs #N` association.

The main-owned E2E planner derives New/Regression browser `.spec.ts` IDs from the **actual first-parent commit history and the integration tree**, not merely the final net diff. A browser spec touched and restored still remains a regression obligation. Absent or malformed Issues, stale refs, missing IDs, unknown risks and untrusted result receipts stay fail-closed. The general path-impact classifier does not grant an Issue E2E waiver: the current Issue Audit plus an exact head/declaration-digest owner approval is required for unknown or mixed scope; only positively tooling-only **zero-ID** batches can receive a separate authenticated main-owned Audit attestation. The model can propose and review, but cannot independently create E2E/Acceptance Pass evidence.

Owner `/approve-staging-convergence ...` comments and authenticated bot Audit receipts are **wake-up events**, not merger credentials. The controller re-reads live refs, the approved Issue, required exact-head CI/E2E/Case workflows and GitHub clean protected mergeability before using the `merge` method and expected head SHA. An actual merge-tree conflict leaves a visible blocked PR; read-only `Agent / Staging Convergence Review` uses live remote refs (not the potentially stale GitHub PR `base.sha` snapshot) and publishes only a nonauthoritative repair proposal. A separate trusted code repair and real checks are necessary.

**Observed integration:** [Issue #2984](https://github.com/BestNathan/nession/issues/2984) linked [PR #2985](https://github.com/BestNathan/nession/pull/2985), whose exact `91af0907d508224d55e469adfa6442f440b70432` head had successful Quality, Case Smoke, Pages and E2E workflows. After exact owner approval, an **owner-initiated** protected merge commit `d4025428dcb79cfd273a16a66ff828cd2288eb54` reached staging; [Staging Artifacts run #42485547869](https://github.com/BestNathan/nession/actions/runs/42485547869) completed its GitOps deployment. This is real protected-merge/deployment evidence **but is not a claim that the controller itself initiated that merge**. A later, divergent source pair correctly remained blocked on conflict (PR #2998); owner approval for #2984 cannot be reused there.

## Related knowledge

- [Nession native Toolchain OCI release to GHCR](nession-native-toolchain-oci-release-to-ghcr.md) — version-pinned Shell Recipe directory packaging with native EROFS OCI GHCR publication and independent readback.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — which proofs apply at PR, staging, main and deployed boundaries.
- [Nession public Pages source publication and orphan-branch signals](nession-public-pages-source-publication-and-orphan-branch-signals.md) — a concrete safe cross-branch event bridge.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md) — executable owners outrank the derived wiki.

## Limits / when to revisit

This summarizes canonical workflow ownership as of source SHA 5eaaf2cf07d5, the #2953 source-bound convergence implementation through cb81cd3469b9 and the #4482 V2 lifecycle/reconcile implementation at 8783ecf6ab. New main/staging conflicts, approvals or deployment outcomes require their own exact-SHA evidence; the #4482 SC-06 canary remains unexecuted until separately authorized. Validate live workflows, protected refs, Gates and Issue authority when the implementation changes; this article is not a second workflow policy engine.
