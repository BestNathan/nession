---
title: "Nession CI, E2E and acceptance qualification timing"
description: "Stage-specific Quality, Acceptance, Full E2E and deployed qualification without unnecessary repeated gates"
topic: workflows
categories: ["acceptance","ci","e2e","release"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-07T14:12:50Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/docs/architecture/acceptance-sc-format.md","https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/e2e-full-regression.yml","https://github.com/BestNathan/nession/issues/2323","https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/ci-quality.yml","https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/scripts/ci/quality-scope.mjs","https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/acceptance-case-smoke.yml","https://github.com/BestNathan/nession/issues/2917","https://github.com/BestNathan/nession/pull/2931","https://github.com/BestNathan/nession/actions/runs/42379261477"]
---

# Nession CI, E2E and acceptance qualification timing

## Stage-specific evidence

Nession separates **development correctness** from **release qualification**, so every ordinary PR need not wait for the full system test suite.

| Boundary | Meaning |
| --- | --- |
| **PR exact HEAD** | Relevant deterministic Quality Gates, selected E2E and SC-specific proof; earliest safe boundary for static/protocol/config invariants |
| **Merged staging SHA** | Specific integration, provider, cross-component or Store/Run Cases when the invariant needs a trusted integration lane; eligible Issues may reach Development Complete here |
| **Main promoted SHA** | Separate promotion lineage and applicable full regression for runtime-affecting changes; no substitute from an older or different SHA |
| **Deployed revision** | Actual environment identity and authenticated observation; a main merge does not prove deployment |

Every Success Criterion has one `when: pr | merged | deployed` and one `method: agent | case` in its canonical Acceptance Plan. Choose the earliest **provable** boundary, not the current Worker topology. `agent` can evaluate source and authenticated records read-only; executed runtime assertions require `case`. Preserve missing evidence as Pending rather than passing a skipped check.

The Issue lifecycle distinguishes **Development Complete → Main Promoted → Regression Qualified → Released**. Normal Issue completion does not automatically depend on Full E2E, product deployment or a production release.

## Full E2E and cost

The current `E2E / Full Regression` performs exact-main-SHA qualification when runtime changes require it; it also has separate periodic health-admission logic. An explicitly tooling-only/non-applicable push yields authenticated **Not Required** evidence, **not** Full Pass. Mixed, unknown or browser-affecting changes must not be silently omitted. A successful GitHub workflow is not itself an authenticated Issue acceptance record.

## Scope-aware PR Quality and Case Smoke (#2917)

The [merged Quality routing](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/ci-quality.yml) executes the **trusted Main** `scripts/ci/quality-scope.mjs` against the **exact PR head versus merge-base**, or the exact Main-push first-parent diff; it does not assume a historical PR head contains today's selector. A positively classified agent-development Markdown fixture has no Rust/Web/Tooling Quality applicability. Unknown or unverifiable paths remain conservatively applicable. The stable required `web-check` aggregates applicable `tooling-check` and `web-tests` results after parallel execution; failure, missing/unknown outputs and skipped *required* families fail closed. The individual Gate catalog/definitions and Rust coverage rules are unchanged.

[Case Smoke](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/.github/workflows/acceptance-case-smoke.yml) validates contracts and selects **trusted Issue-linked Case-method SCs before** provisioning Rust, Web, tmux or Chromium. A PR with no selected source-aligned Case records Not Required instead of running representative runtime Cases. Representative infrastructure Cases remain in the main/manual/scheduled lane. An eligible real Case or unknown entitlement cannot be silently treated as absent. The separate E2E planner retains its independent risk/Issue-selection policy.

A verified Main `web-dist` artifact is emitted only after the applicable `web-check` aggregate passes. The trusted [source attestation](https://github.com/BestNathan/nession/blob/4a5436a8770fed9367a0820eef38417b77525943/scripts/ci/web-dist-source-attestation.mjs) verifies producer source/repo/branch, exact SHA, Run/Attempt, required jobs and steps. It distinguishes **both Web tests and dist skipped** as authenticated `WEB_DIST_NOT_REQUIRED_V1` (no artifact check), versus actual `WEB_DIST_SOURCE_V1` and restoration. A mixed skip, foreign/stale source or missing job must fail. Real positive proof: [Quality producer 42378852053](https://github.com/BestNathan/nession/actions/runs/42378852053) and [Web Dist consumer 42379261477](https://github.com/BestNathan/nession/actions/runs/42379261477), both exact Main SHA `4a5436a8...`, restore and preview parity successful.

### Measured performance — separate exact-head PR samples

A disposable unmerged [probe PR #2931](https://github.com/BestNathan/nession/pull/2931) recorded three independent GitHub Actions runs (Ubuntu 24.04; one sample per class). Measured values are **workflow created-to-updated wall time**, not isolated CPU/test time.

| Change category | Before comparable run | After exact-head run | Observed Quality wall time |
| --- | --- | --- | --- |
| Fixture-only | [42371357810](https://github.com/BestNathan/nession/actions/runs/42371357810) — 370s | [42379218472](https://github.com/BestNathan/nession/actions/runs/42379218472) — 24s | -94% |
| Web-only | [42377591120](https://github.com/BestNathan/nession/actions/runs/42377591120) — 404s | [42379309835](https://github.com/BestNathan/nession/actions/runs/42379309835) — 230s | -43% |
| Terminal Rust + Web | [42375105508](https://github.com/BestNathan/nession/actions/runs/42375105508) — 367s | [42379657576](https://github.com/BestNathan/nession/actions/runs/42379657576) — 259s | -29% |

The after Quality jobs all passed with their applicable suites and required aggregate. Fixture-only Case Smoke dropped from ~246s to 28s without runtime build. **Do not extrapolate these three observations to a guaranteed CI SLA**: source commits/inputs, caches and scheduling differ; they are not same-SHA paired A/B trials and no multi-sample variance is established. The mixed probe's [E2E job 42379657588](https://github.com/BestNathan/nession/actions/runs/42379657588) **failed closed** because the disposable source PR had no Issue-linked E2E plan; that does *not* provide product E2E Pass evidence. Correctness and independent Acceptance obligations must still be met by real feature PRs.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — why triggers, evidence and result projection are different owners.
- [Nession public Pages source publication and orphan-branch signals](nession-public-pages-source-publication-and-orphan-branch-signals.md) — deploy/readback verification is not a generic Quality Gate.

## Authority and limitations

The exact [SC authoring and lifecycle contract](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/docs/architecture/acceptance-sc-format.md) and [Full Regression workflow](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/e2e-full-regression.yml) govern operational details. Deployed proof depends on a real authenticated environment/revision; production integration is not implied by successful staging acceptance.
