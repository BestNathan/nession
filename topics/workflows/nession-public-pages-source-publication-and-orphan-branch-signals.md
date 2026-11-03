---
title: "Nession public Pages source publication and orphan-branch signals"
description: "Current trusted Pages projection, existing Prototype event bridge and pending Knowledge push notification"
topic: workflows
categories: ["delivery","knowledge","pages","security"]
status: candidate
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-03T10:00:48Z
sources: ["https://github.com/BestNathan/nession/blob/5eaaf2cf07d50ed805b8961a012127f60dba9111/.github/workflows/deploy-pages.yml","https://github.com/BestNathan/nession/issues/2519","https://github.com/BestNathan/nession/issues/2664","https://github.com/BestNathan/nession/issues/2683","https://github.com/BestNathan/nession/blob/c01bf9791ce1e5ed2da790f6689bc391c9180818/.github/workflows/deploy-pages.yml"]
---

# Nession public Pages source publication and orphan-branch signals

## Historical baseline before #2683

The independent `Deploy / Public Pages` workflow is **main-owned**. It builds a static public site using read-only pinned snapshots from `metrics`, `acceptance-results`, `prototype` and `knowledge`. It does not grant those branches authority to execute code in trusted Actions or to overwrite deployment. Public Knowledge is ledger-validated and safely projected with source SHA, content digest and anonymous HTTPS readback.

At main 5eaaf2cf07d5, its triggers are selected `main` path pushes, manual dispatch, the four-hour general refresh, and **Prototype / Change Signal** completion from the `prototype` orphan branch. That signal is unprivileged, push-only, and does not execute prototype code. The trusted consumer independently checks same-repository origin, `push` event, expected branch and successful conclusion. [Issue #2519](https://github.com/BestNathan/nession/issues/2519) is its owner.

**Observed freshness gap:** the `knowledge` branch received commit [d23976c](https://github.com/BestNathan/nession/commit/d23976cfc929def86bbd6fd2967cd27f4f56b51c) updating articles and index, but a Knowledge push is not currently a direct Pages trigger. A later scheduled deployment can include it, but is not immediate.

## Source-signal rollout at merged main c01bf9791ce1 — public evidence pending

The trusted main Pages consumer now includes an exact name/branch pair for `Knowledge / Change Signal`, independently of `Prototype / Change Signal`. The source workflow is being installed in this same Knowledge commit as the **only allowed, immutable, read-only `.github/workflows/knowledge-changed.yml`**. A normal article/index/global-CHANGELOG update accompanies it; the main-owned Knowledge verifier still rejects arbitrary files or later edits to the pinned signal. Both branch signals are notifications, not permission grants or validation receipts.

A genuine Knowledge push Run, its triggered main Pages Run, and anonymous SHA/digest readback must still be captured to verify the live chain. The article therefore remains `candidate`.

## Original design proposal for #2683 (historical)

Add a separate, unprivileged **Knowledge / Change Signal** on `knowledge` pushes, feeding the **existing** trusted main Pages publisher. Its event must only notify the consumer. The consumer should validate event identity, fetch the read-only source, check the canonical ledger, build sanitized static content and verify anonymous public bytes against the validated Knowledge SHA.

Do not add another Pages writer, execute untrusted orphan content, introduce frequent polling or treat signal success as an integrity audit. GitHub Actions often suppresses recursive workflow triggers from default `GITHUB_TOKEN` pushes; trusted publisher identity or constrained dispatch must explicitly address such writers.

## Acceptance and follow-up

A valid end-to-end proof ties knowledge commit SHA → real push signal Run/Attempt → main Pages Run/Attempt → public `data/knowledge.json` exact SHA/digest readback. Until [#2683](https://github.com/BestNathan/nession/issues/2683) produces that evidence, the Knowledge push path remains **proposed**, not an implemented capability.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — single trusted publisher and safe producer/consumer authority.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — deployed proof vs workflow completion.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md) — current-article ledger and source hierarchy.

## Limits / when to revisit

After #2683 merges, update current-vs-proposed wording using exact merged source and authenticated public Pages receipts. Preserve the independent Prototype mechanism, other general refresh triggers and Knowledge writer separation.
