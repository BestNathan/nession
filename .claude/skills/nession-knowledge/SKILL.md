---
name: nession-knowledge
description: Use when finding, reading, verifying, creating, editing, moving, deleting or auditing Nession project knowledge by topic, category tags or the global changelog, and when assessing Knowledge Impact in Requirements.
---

# Nession Knowledge

This Skill owns **curated project knowledge**. The independent orphan branch `knowledge` contains the current articles and a single knowledge-base-wide change log. The main branch owns the Skill and deterministic validator. Read [knowledge-ledger governance](../../../docs/engineering/knowledge-ledger.md) and use [nession-writing-requirements](../nession-writing-requirements/SKILL.md) for Issue authoring.

Knowledge is a sourced project-context index, **not** a replacement for current code/Gates, VISION/PRINCIPLE, canonical architecture documents or owner decisions. Resolve conflicts against those owners, not by trusting the newest article.

## Model: one article, one primary topic, multiple category tags

```text
knowledge (independent orphan branch)
├── README.md
├── schema/v2.json
├── topics/
│   └── engineering/
│       └── nession-instruction-architecture-and-knowledge-ownership.md
├── index.json                     # derived; topic -> current files, category -> article paths
└── CHANGELOG.md                  # ONE append-only ledger-wide change log
```

Each knowledge **title** determines the entire Markdown filename: `topics/<topic>/<title-slug>.md`. For example `Nession instruction architecture and knowledge ownership` becomes `topics/engineering/nession-instruction-architecture-and-knowledge-ownership.md`. A slug uses the whole lowercased title with whitespace/punctuation converted into `-` (Chinese/Unicode characters remain intact). **Never invent or abbreviate an `id`, and do not put `id` in frontmatter.** A topic is the primary navigation path; `categories` are reusable multi-value tags. Category index entries point to full article paths. No article revision files, per-article event logs or receipt documents. Git commits provide historical snapshots; the global changelog records **what changed, when, why and in which topic/category**.

Each Markdown article uses Skill-style YAML frontmatter with a small, executable subset:

```markdown
---
title: "Terminal transport and recovery"
description: "Correctness and recovery contract for streamed terminal output"
topic: terminal
categories: ["architecture", "transport", "recovery"]
status: verified
created_at: 2026-10-24T03:00:00Z
updated_at: 2026-10-24T03:00:00Z
sources: ["https://github.com/BestNathan/nession/blob/<exact-full-commit-sha>/docs/architecture/terminal.md"]
---

# Terminal transport and recovery

## Decision
...
## Context and evidence
...
## Limits / when to revisit
...
```

The angle-bracket SHA above is a placeholder: **replace with a real 40-character commit**. Frontmatter is parseable using the standard top-and-bottom `---` fence. Use scalar keys and inline YAML-compatible JSON string arrays for `categories` and `sources`; no anchors, arbitrary nesting or extra keys. `verified` requires a real authoritative source; otherwise set `candidate`. Keep the body concise, readable and designed for humans first.

## The three mandatory operations: Ingest, Query, Lint

Treat the knowledge base as a compounding, source-grounded wiki: preserve source evidence, maintain one current article per concept/title, and link related knowledge. Do not dump documents into Markdown or answer every question from raw sources again. Every operation must keep source, current article, index and global log consistent.

### 1. Ingest — absorb evidence into current knowledge

Use Ingest when a new source, merged Issue/PR, implementation change, decision, incident or research finding may change durable project understanding.

1. Capture evidence first. Record the source URL and exact repository commit where possible. Separate direct observations/owner decisions from inference. Model-generated prose is not evidence.
2. Find affected knowledge. Search index.json by primary topic, then category tags, then full text. Read candidate articles and follow cross-links. One source may affect several articles; inspect likely dependencies, not only the obvious page.
3. Reconcile, do not append blindly. Update the existing current article when the concept already exists. Create an article only for a distinct durable concept. Preserve useful context; explain changed evidence; record unresolved contradictions explicitly instead of silently choosing a side.
4. Write useful current knowledge. Capture conclusion/decision, supporting evidence and sources, rationale, related-article links, limitations/unknowns, and what would invalidate or trigger review. Add reciprocal cross-links when useful.
5. Publish atomically. Set updated_at to the same UTC instant as the global log event; append one CHANGELOG.md event per changed article; regenerate index.json; run the trusted contract check; commit article/index/log changes together; publish using expected-head CAS and no force-push.
6. Report evidence: full article title/path, sources, affected links, commit SHA and validation result. If evidence is weak or contradictory, use status candidate or explicitly mark the disputed claim unresolved.

Ingest is complete only when current article, derived index, append-only global changelog and Git commit agree. A chat note or uncommitted file is not published knowledge.

### 2. Query — retrieve, reason, and promote durable answers

1. Resolve intent to topic(s). Start with index.json topics; narrow with categories; then search full text. GitHub default-branch search does not cover the orphan knowledge branch by assumption.
2. Read the whole relevant context. Open candidate articles, follow cross-links, inspect cited sources and check status. Use verified articles for grounded explanations and treat candidate articles as provisional. For code/runtime behavior, verify against current code, tests/Gates and canonical docs.
3. Resolve authority and conflicts. Prefer explicit owner decisions and current canonical sources over derived summaries. Compare source dates/commits when claims conflict. If evidence is insufficient, say so; do not turn absence of evidence into fact.
4. Answer with traceability. Give the conclusion, important reasoning, caveats, full article title/path and authoritative source. Historical questions require Git history and CHANGELOG.md; never fabricate article versions.
5. Promote reusable answers. If a Query yields a durable explanation, resolves a contradiction or exposes a knowledge gap, convert it into an Ingest transaction. Do not store every transient answer or duplicate existing content.

Query is read-only unless a useful answer is deliberately promoted through Ingest. An answer generated from memory without checking current sources is not a verified query.

### 3. Lint — detect integrity and semantic defects

Lint has two separate, required layers.

**Deterministic contract checks** must fail closed:
- Frontmatter schema, allowed keys, required fields, UTC timestamps, category syntax and full-title filename/topic agreement.
- index.json exactly matches current Markdown frontmatter, topic lists and category paths.
- Each current article has matching changelog history; action/path/title/topic/category/timestamp match the Git tree and article.
- Every relative Markdown link resolves to an existing file or valid in-file anchor. External HTTPS links are treated as unverified unless checked separately.
- Sources follow the allowed formats; verified articles include an exact-commit canonical repository source.
- No orphan articles: every article must have a meaningful incoming cross-link from another current article. Topic/index navigation alone does not satisfy this requirement.
- Detect duplicate concepts/title paths, invalid tags, secret-like content, missing log events, unlogged article mutations and rewritten historical log entries.
- Negative fixtures prove broken links, orphan pages, missing/invalid sources, index drift and changelog drift are detected.

**Semantic Agent review** checks what syntax cannot prove:
- Contradictory claims, stale decisions, unsupported certainty, and sources that no longer support the wording.
- Duplicate or near-duplicate concepts, missing cross-links, unclear ownership and missing limitations.
- Query answers that should be promoted, and articles that should be merged, superseded or retired.
- Drift between wiki statements and current implementation, tests/Gates, owner decisions or canonical docs.

Each finding must name article title/path, claim or link, evidence, severity and a concrete proposed fix. Do not silently rewrite disputed facts. Accepted repairs go through Ingest and are linted again. Report deterministic and semantic outcomes separately as PASS / FAIL / PENDING. Documentation alone does not mean a check is implemented; unrun or unevidenced checks remain PENDING.

## Canonical structure and record rules

The knowledge orphan branch is the sole published current-state store:

- README.md — entry point and contributor rules.
- schema/v2.json — machine-readable contract.
- topics/<topic>/<full-title-slug>.md — one current article per title.
- index.json — deterministic, derived topic/category index.
- CHANGELOG.md — one append-only ledger-wide event log.

An article's identity is its complete title plus primary topic; its path is derived from the entire title. Do not create short IDs, per-article revision files, per-article event logs or receipt files. Git history preserves previous content; CHANGELOG.md explains what changed and why. Categories are reusable multi-select tags, not directories.

Every article uses exactly these frontmatter fields: title, description, topic, categories, status, created_at, updated_at, sources. The validator's safe YAML subset is authoritative. Title is the full human-readable concept name; description is a retrieval summary; topic is one lowercase hyphenated primary topic matching the directory; categories are unique lowercase hyphenated tags; status is verified only when the required authoritative exact-commit source exists, otherwise candidate; created_at is retained on ordinary updates; updated_at matches the latest create/update/rename/move event in UTC; sources use validator-approved Issue/PR URLs or exact-SHA repository blob URLs. Cite important external research in the body and record the owning repository Issue/PR in metadata and changelog.

The body should normally capture conclusion/decision, context and evidence, related-knowledge links, and limits/unresolved questions. Adapt headings to the subject, but preserve these information types.

Each CHANGELOG.md event is append-only and records UTC time, action, complete title, current path, topic, categories, reason and owning Issue/PR URL. Rename/move also record Previous path. A transaction changing multiple articles appends one event per changed article. Regenerate index.json from current articles; never hand-edit it. Keep article, index and log changes in the same commit.
## Search / retrieve

Always fetch the explicit orphan branch. GitHub default-branch code search does **not** search `knowledge`.

```sh
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git show origin/knowledge:index.json                    # topic-first catalog
git show origin/knowledge:topics/engineering/nession-instruction-architecture-and-knowledge-ownership.md
git grep -n -i 'tmux' origin/knowledge -- topics/         # full text
git show origin/knowledge:CHANGELOG.md                  # cross-topic changes in time order
git log --format='%H %cI %s' origin/knowledge -- topics/  # exact prior content
```

For a topic, choose `index.json.topics[topic]`; for tag filtering use `index.json.categories[category]` (array of **current Markdown paths**). Combine filters by path or complete title; no synthetic short ID is used. Normal answers use `status: verified` records and cite current authoritative source, full title/topic and observed knowledge Git SHA. For “what changed?” search `CHANGELOG.md` by title, topic, category and timestamp. For “what was true before?” select a historical Git commit; do not invent vNNNN identifiers.

## Edit / update

1. Inspect the relevant topic, categories, complete title, current entry and authoritative sources. Before creating anything, check for an existing article with the same concept/title. **Do not assign a separate ID.**
2. Work in an isolated `origin/knowledge` worktree, **not** product `main` or shared `knowledge` checkout. Keep the root checkout read-only:
```sh
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git worktree add -b kb-<issue>-<subject> .claude/worktrees/kb-<issue>-<subject> origin/knowledge
```
3. Create/update the **single** `topics/<topic>/<title-slug>.md`, deriving its entire basename from `title` (never truncate). To rename a title, rename its file and append one `rename` event with `Previous path` pointing to the old filename. Use `move` when the primary topic changes. For a normal content edit use `update`; deleted articles remain in Git history.
4. **Append** one global `CHANGELOG.md` event per change transaction, oldest to newest, using UTC time and the **full article title in its heading**. Never edit old log entries. Events record `Path`, `Topic`, `Categories`, `Reason`, `Source` (owning Issue/PR); `rename` and `move` additionally need `Previous path`:
```markdown
## 2026-10-24T10:00:00Z | update | Terminal transport and recovery
- Path: topics/terminal/terminal-transport-and-recovery.md
- Topic: terminal
- Categories: architecture, transport, recovery
- Reason: Clarify terminal recovery invariant after source change
- Source: https://github.com/BestNathan/nession/issues/2325
```
5. From trusted main tooling regenerate `index.json` with `node scripts/knowledge-ledger-contract.mjs index <knowledge-worktree>`, then commit article + index + changelog **together**. Run `node scripts/knowledge-ledger-contract.mjs check <knowledge-worktree> <previous-knowledge-SHA>` and `./gates/run knowledge-ledger-contract`.
6. In a trusted operator environment use `node scripts/knowledge-ledger-publish.mjs publish <knowledge-worktree> <expected-remote-knowledge-SHA>`. The publisher checks exact remote head, rejects stale concurrent writers, pushes without force and re-reads the result. Attach the resulting commit URL to the Issue. Never grant GitHub write credentials to untrusted PR-head or Agent code.

On conflicts, fetch and reconcile **both current knowledge and global log**. Do not silently rebase away someone else's change. Do not delete/recreate the orphan branch, overwrite the changelog or present cached content as verified after a fetch failure. Public knowledge cannot contain secrets, credentials, sessions, private prompts or tenant material.

## Requirement integration

At Requirement creation or material revision, record the `Knowledge Impact` decision (`None | Read | Create | Update | Supersede`), affected full article titles / topics / categories, rationale, owner/timing and evidence. After implementation/review, publish any necessary current-article change with a global log entry and link the knowledge commit to the Issue. An `Update` is an **edit of the current article**, not a new article version. Unaffected requirements may state `None` with a reason. Do not mark knowledge evidence complete just because a model suggested text.

For browser/E2E scope, keep the owning Issue's `E2E Verification` (`New` and `Regression`) and `E2E Report` sections explicit. If no browser behavior is affected, declare a justified `- none: ...` in both lists. Missing E2E scope is unresolved, not an implicit `not-required`; this prevents CI from silently choosing either a full regression or a skip.

## Audit and stop conditions

The trusted read-only `CI / Knowledge Ledger Audit` checks the live ref every six hours and on demand. It anchors the original orphan Git history and verifies topics, categories, global log, index consistency and Git diffs. This is detection, not server-side ref protection. Stop on missing ref, stale source, metadata conflict, invalid log, failed CAS/readback or unknown authority. Report **Pending** rather than reconstructing certainty.
