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
│       └── repository-instruction-architecture.md
├── index.json                     # derived; topic -> entries, category -> IDs
└── CHANGELOG.md                  # ONE append-only ledger-wide change log
```

Each knowledge ID has **one current Markdown file**, `topics/<topic>/<id>.md`. A topic is a single primary navigation/ownership path. `categories` are reusable **tags**, not mutually exclusive directory trees. No article revision files, per-article event logs or receipt documents. Git commits provide historical snapshots; the global changelog records **what changed, when, why and in which topic/category**.

Each Markdown article uses Skill-style YAML frontmatter with a small, executable subset:

```markdown
---
id: terminal-transport
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

## Search / retrieve

Always fetch the explicit orphan branch. GitHub default-branch code search does **not** search `knowledge`.

```sh
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git show origin/knowledge:index.json                    # topic-first catalog
git show origin/knowledge:topics/engineering/repository-instruction-architecture.md
git grep -n -i 'tmux' origin/knowledge -- topics/         # full text
git show origin/knowledge:CHANGELOG.md                  # cross-topic changes in time order
git log --format='%H %cI %s' origin/knowledge -- topics/  # exact prior content
```

For a topic, choose `index.json.topics[topic]`; for tag filtering use `index.json.categories[category]`; combine filters by ID. Normal answers use `status: verified` records and cite current authoritative source, article ID/topic and observed knowledge Git SHA. For “what changed?” search `CHANGELOG.md` by ID, topic, category and timestamp. For “what was true before?” select a historical Git commit; do not invent vNNNN identifiers.

## Edit / update

1. Inspect the relevant topic, categories, current entry and authoritative sources. Reuse an existing ID when the concept remains the same. Confirm no duplicate entry exists in another topic.
2. Work in an isolated `origin/knowledge` worktree, **not** product `main` or shared `knowledge` checkout. Keep the root checkout read-only:
```sh
git fetch origin refs/heads/knowledge:refs/remotes/origin/knowledge
git worktree add -b kb-<issue>-<subject> .claude/worktrees/kb-<issue>-<subject> origin/knowledge
```
3. Create/update the **single** `topics/<topic>/<id>.md`, maintaining frontmatter and human-readable Markdown. Rename by explicitly accounting for both old and new topic paths in the log. Deletion must state why the article is no longer current; history remains in Git.
4. **Append** one global `CHANGELOG.md` event per changed knowledge file, oldest to newest, using UTC time. Never edit old log entries. Every event records `Path`, `Topic`, `Categories`, `Reason`, `Source` (owning Issue/PR):
```markdown
## 2026-10-24T10:00:00Z | update | terminal-transport
- Path: topics/terminal/terminal-transport.md
- Topic: terminal
- Categories: architecture, transport, recovery
- Reason: Clarify terminal recovery invariant after source change
- Source: https://github.com/BestNathan/nession/issues/2325
```
5. From trusted main tooling regenerate `index.json` with `node scripts/knowledge-ledger-contract.mjs index <knowledge-worktree>`, then commit article + index + changelog **together**. Run `node scripts/knowledge-ledger-contract.mjs check <knowledge-worktree> <previous-knowledge-SHA>` and `./gates/run knowledge-ledger-contract`.
6. In a trusted operator environment use `node scripts/knowledge-ledger-publish.mjs publish <knowledge-worktree> <expected-remote-knowledge-SHA>`. The publisher checks exact remote head, rejects stale concurrent writers, pushes without force and re-reads the result. Attach the resulting commit URL to the Issue. Never grant GitHub write credentials to untrusted PR-head or Agent code.

On conflicts, fetch and reconcile **both current knowledge and global log**. Do not silently rebase away someone else's change. Do not delete/recreate the orphan branch, overwrite the changelog or present cached content as verified after a fetch failure. Public knowledge cannot contain secrets, credentials, sessions, private prompts or tenant material.

## Requirement integration

At Requirement creation or material revision, record the `Knowledge Impact` decision (`None | Read | Create | Update | Supersede`), affected topic/knowledge IDs/categories, rationale, owner/timing and evidence. After implementation/review, publish any necessary current-article change with a global log entry and link the knowledge commit to the Issue. An `Update` is an **edit of the current article**, not a new article version. Unaffected requirements may state `None` with a reason. Do not mark knowledge evidence complete just because a model suggested text.

## Audit and stop conditions

The trusted read-only `CI / Knowledge Ledger Audit` checks the live ref every six hours and on demand. It anchors the original orphan Git history and verifies topics, categories, global log, index consistency and Git diffs. This is detection, not server-side ref protection. Stop on missing ref, stale source, metadata conflict, invalid log, failed CAS/readback or unknown authority. Report **Pending** rather than reconstructing certainty.
