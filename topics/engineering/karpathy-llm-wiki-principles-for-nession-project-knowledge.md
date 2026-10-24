---
title: "Karpathy LLM Wiki principles for Nession project knowledge"
description: "How Nession adapts the LLM Wiki pattern into source-grounded, incrementally maintained project knowledge"
topic: engineering
categories: ["agents","knowledge","provenance","research","skills"]
status: verified
created_at: 2026-10-24T05:34:00.000Z
updated_at: 2026-10-24T05:34:00.000Z
sources: ["https://github.com/BestNathan/nession/issues/2343"]
---

# Karpathy LLM Wiki principles for Nession project knowledge

## Core idea

Karpathy's [LLM Wiki idea file](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) proposes compiling source material into a persistent, interlinked Markdown wiki that becomes richer as new sources and questions arrive, rather than re-deriving every synthesis from raw documents at query time.

For Nession, this is an operating model for the existing project knowledge ledger, not a reason to add a second storage system or weaken source authority.

## Three responsibilities

1. **Source evidence:** canonical repository docs, code and Gates, explicit owner decisions, Issues/PRs and external primary sources. Preserve exact URLs and commit SHAs; treat source material as read-only evidence.
2. **Current knowledge:** one readable Markdown article per complete title, organized by one primary topic and reusable category tags. Articles synthesize evidence and link to related articles where the connection helps future retrieval.
3. **Schema and workflow:** the [nession-knowledge Skill](https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-knowledge/SKILL.md), [knowledge governance](https://github.com/BestNathan/nession/blob/main/docs/engineering/knowledge-ledger.md), frontmatter schema and deterministic Gates define how agents ingest, query, edit and lint the knowledge base.

Nession should reference existing canonical sources rather than mirror the whole repository into the orphan branch. Derived knowledge never outranks its source.

## Three operations

### Ingest

For each meaningful new source:

1. Read and identify durable claims, decisions, constraints and open questions.
2. Search existing articles by topic, category, full text and related links before creating a new page.
3. Compare the source with existing claims. Update the current article when knowledge evolves; record contradictions explicitly until authoritative evidence resolves them.
4. Add useful cross-links, regenerate the current-state index, and append one global changelog event for each changed article.
5. Commit article edits, index changes and changelog events atomically; validate and publish using expected-head compare-and-swap and non-force fast-forward.

Prefer one source at a time when changes are important enough to benefit from human review. A new source does not automatically mean a new article.

### Query

1. Start from the topic-first index, then filter by category and search article titles/content.
2. Follow related-article links and read the relevant source evidence, not just the summaries.
3. Answer with links to the current article and its authoritative source. State uncertainty when evidence conflicts or is stale.
4. Promote a useful synthesis into a durable article only when it is reusable, source-grounded and not merely a one-off answer. Update the existing article if it covers the same concept.

The current JSON index plus full-text GitHub/local search is sufficient at the current small scale. Add BM25/vector retrieval only when measured corpus size or query failures justify it.

### Lint

Run deterministic checks for frontmatter and title/path consistency, missing or broken local links, orphan articles, index drift, malformed or missing changelog entries, invalid source references, and stale repository commit references. A separate semantic review should look for contradictions, outdated claims, repeated concepts that merit a page, and gaps in evidence; an LLM suggestion is a finding to review, not an automatic truth.

## Authority and integrity

- The LLM maintains bookkeeping and proposes synthesis; it does not become the authority for product behavior.
- Code, Gates, canonical docs and explicit owner decisions outrank derived knowledge.
- 'verified' requires traceable, relevant source evidence. Otherwise use 'candidate' and clearly state what remains unverified.
- One current article per complete title; no synthetic IDs or per-article version files.
- The topic/category index is derived current state. The single global CHANGELOG is append-only history of knowledge changes; Git commits preserve prior content.
- Every write is one transaction: current Markdown + regenerated index + appended changelog events, then deterministic validation and guarded publication. Never force-push or silently discard concurrent changes.

## Relationship to the current architecture

See [Nession instruction architecture and knowledge ownership](nession-instruction-architecture-and-knowledge-ownership.md) for the repository's authority hierarchy and the role of the knowledge ledger.
