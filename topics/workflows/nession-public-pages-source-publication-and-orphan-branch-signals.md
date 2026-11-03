---
title: "Nession public Pages source publication and orphan-branch signals"
description: "Verified trusted main Pages publishing of Prototype and Knowledge orphan branch push signals with exact-source public readback"
topic: workflows
categories: ["delivery","knowledge","pages","security"]
status: verified
created_at: 2026-11-03T09:34:15Z
updated_at: 2026-11-03T10:27:55Z
sources: ["https://github.com/BestNathan/nession/blob/00ba70db36bf97d04bc9c3a6e149e7c6816e40e6/.github/workflows/deploy-pages.yml", "https://github.com/BestNathan/nession/blob/00ba70db36bf97d04bc9c3a6e149e7c6816e40e6/scripts/knowledge-ledger-contract.mjs", "https://github.com/BestNathan/nession/blob/00ba70db36bf97d04bc9c3a6e149e7c6816e40e6/scripts/workflow-conventions.mjs", "https://github.com/BestNathan/nession/issues/2519", "https://github.com/BestNathan/nession/issues/2664", "https://github.com/BestNathan/nession/issues/2683"]
---

# Nession public Pages source publication and orphan-branch signals

## Current verified publication contract

The independent `Deploy / Public Pages` workflow is owned by trusted `main`. It builds a public static site from read-only, source-pinned snapshots of `metrics`, `acceptance-results`, `prototype` and `knowledge`. It does not execute orphan-branch content. Sanitization, canonical Knowledge Ledger verification and anonymous HTTPS readback of exact source SHA and byte digest are owned by trusted main code.

The publisher accepts selected `main` path pushes, a four-hour general rebuild, manual dispatch, and two **strictly paired** successful same-repository `workflow_run` signals from real pushes:

- `Prototype / Change Signal` ↔ `prototype` — precedent [#2519](https://github.com/BestNathan/nession/issues/2519).
- `Knowledge / Change Signal` ↔ `knowledge` — implementation and acceptance [#2683](https://github.com/BestNathan/nession/issues/2683).

The main consumer rejects mismatched workflow names and branches, non-`push` upstream events, unsuccessful runs and foreign repositories. A signal is only a notification, never proof that its data is safe or that the public website has updated. The existing `deploy-public-pages` concurrency group remains serialized, with no second Pages publisher or short-interval polling.

## Orphan Knowledge source integrity

The canonical Knowledge v2 ledger ordinarily allows only current topic Markdown, one derived `index.json`, append-only `CHANGELOG.md`, schema and README. One narrow implementation exception admits the fixed-byte `.github/workflows/knowledge-changed.yml` notification from the orphan branch. It has `contents: read` only, no checkout or execution of Knowledge content, no privileged token or artifacts, and was introduced in a normal atomically recorded Knowledge article/index/changelog transaction.

The main-owned `scripts/knowledge-ledger-contract.mjs` validates the exact source bytes and permits only that file's one-time addition, not later modifications, deletion or any other workflow under `.github`. The independent trusted writer remains the only Knowledge data owner. GitHub Actions `GITHUB_TOKEN` recursion suppression still applies to writes made by other Actions jobs; writers must use an approved identity/dispatch rather than claim guaranteed push-triggered downstream runs.

## Actual deployment and acceptance evidence — 2026-11-03

The first Knowledge notifications exposed a stale Terminal `updated_at` in the derived index; a normal ledger transaction rebuilt it from article frontmatter. The next Pages run exposed an obsolete Prototype-only test assertion, fixed with the canonical dual-signal ownership check in [PR #2691](https://github.com/BestNathan/nession/pull/2691). Neither test was bypassed.

The final recorded end-to-end chain is:

1. Knowledge commit [a0d92aa9088c50fb1956463f466a1f25e2a1dc47](https://github.com/BestNathan/nession/commit/a0d92aa9088c50fb1956463f466a1f25e2a1dc47) generated real `push` [Knowledge signal run 41617084950](https://github.com/BestNathan/nession/actions/runs/41617084950), successful, exact source SHA, same repository.
2. That signal triggered main-owned [Pages run 41617110852](https://github.com/BestNathan/nession/actions/runs/41617110852), `event=workflow_run`, completed successfully. Its publisher independently validated the ledger, built and checked static Pages, and read back anonymous HTTPS `data/knowledge.json`.
3. Deployed source SHA was `a0d92aa9088c50fb1956463f466a1f25e2a1dc47`, article count `7`, public JSON SHA-256 `73b36102abbbf9d06c70ef2bfbe351710cfb833cacf3eacb03c6d11a7fd79fa2`, equal to the validated build artifact.
4. Source-aligned [Acceptance / Cases run 41618761386](https://github.com/BestNathan/nession/actions/runs/41618761386) executed `2683/SC-01` and `2683/SC-03` as **Pass** on merged main `00ba70db36bf97d04bc9c3a6e149e7c6816e40e6`; authenticated [Case Ingest run 41619259587](https://github.com/BestNathan/nession/actions/runs/41619259587) successfully projected both outcomes. `SC-02` and `SC-04` were already projected Pass by trusted PR source/CI evaluation.

These observations prove the concrete witnessed publication, not a guarantee that every future GitHub-hosted job will run on time. The last published source SHA must be compared with the current `knowledge` head when answering freshness questions; never infer freshness from a green signal alone.

## Related knowledge

- [Nession GitHub Actions workflow domains and trust boundaries](nession-github-actions-workflow-domains-and-trust-boundaries.md) — trusted event/provenance owner.
- [Nession CI, E2E and acceptance qualification timing](nession-ci-e2e-and-acceptance-qualification-timing.md) — SC stage and trusted acceptance records.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md) — why current code/Gates and owner decisions outrank this article.

## Limits / when to revisit

The workflow's exact guards, source schema, ledger validator and publishing logic are owned by the linked main SHA; verify against current code after changes. Revisit this article after any upstream signal name/branch change, writer identity change, schedule change, Knowledge validator migration, or public readback failure. Keep historical failed runs as incidents, not rewritten success evidence.
