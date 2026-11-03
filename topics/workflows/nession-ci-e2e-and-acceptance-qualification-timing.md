---
title: "Nession CI, E2E and acceptance qualification timing"
description: "Stage-specific Quality, Acceptance, Full E2E and deployed qualification without unnecessary repeated gates"
topic: workflows
categories: ["acceptance","ci","e2e","release"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-03T09:34:15Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/docs/architecture/acceptance-sc-format.md","https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/e2e-full-regression.yml","https://github.com/BestNathan/nession/issues/2323"]
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

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — why triggers, evidence and result projection are different owners.
- [Nession public Pages source publication and orphan-branch signals](nession-public-pages-source-publication-and-orphan-branch-signals.md) — deploy/readback verification is not a generic Quality Gate.

## Authority and limitations

The exact [SC authoring and lifecycle contract](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/docs/architecture/acceptance-sc-format.md) and [Full Regression workflow](https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/e2e-full-regression.yml) govern operational details. Deployed proof depends on a real authenticated environment/revision; production integration is not implied by successful staging acceptance.
