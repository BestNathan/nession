---
title: "Nession public Pages source publication and orphan-branch signals"
description: "Current trusted Pages projection, existing Prototype event bridge and pending Knowledge push notification"
topic: workflows
categories: ["delivery","knowledge","pages","security"]
status: candidate
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-03T10:10:39Z
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

## First live run and integrity correction

The actual source push at [Knowledge commit 23326bb](https://github.com/BestNathan/nession/commit/23326bb990b50a178871ada07442400a6b6433f6) emitted [Knowledge / Change Signal run 41615705357](https://github.com/BestNathan/nession/actions/runs/41615705357), completed successfully. The main-owned Pages build independently exposed a pre-existing Terminal article timestamp drift in the derived `index.json` (the current Terminal article records `2026-11-03T08:52:21.743Z` but the index still recorded `08:46:49Z`). This follow-up Knowledge transaction regenerates the index from current article frontmatter; the notification run alone is not accepted as publication evidence.

## Verified main Pages regression repair and final push witness

The old Prototype-only test assertion was corrected in [PR #2691](https://github.com/BestNathan/nession/pull/2691), merged as [9a78cad](https://github.com/BestNathan/nession/commit/9a78cad805a51238ba088155a1af459dd991687c). Pages unit/security/Chromium checks passed, and [trusted main Pages deployment 41616863412](https://github.com/BestNathan/nession/actions/runs/41616863412) completed successfully after validating the corrected Knowledge ledger. The next Knowledge article update now provides an independent real **source-push witness** against that corrected publisher; the workflow_run result and anonymous SHA/digest remain separate acceptance evidence.

## Acceptance and follow-up

A valid end-to-end proof ties knowledge commit SHA → real push signal Run/Attempt → main Pages Run/Attempt → public `data/knowledge.json` exact SHA/digest readback. Until [#2683](https://github.com/BestNathan/nession/issues/2683) produces that evidence, the Knowledge push path remains **proposed**, not an implemented capability.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — single trusted publisher and safe producer/consumer authority.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — deployed proof vs workflow completion.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md) — current-article ledger and source hierarchy.

## Limits / when to revisit

After #2683 merges, update current-vs-proposed wording using exact merged source and authenticated public Pages receipts. Preserve the independent Prototype mechanism, other general refresh triggers and Knowledge writer separation.
