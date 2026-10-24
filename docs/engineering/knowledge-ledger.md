# Nession Project Knowledge — topic-first current knowledge

**Owner:** `nession-knowledge` Skill and `scripts/knowledge-ledger-contract.mjs`. **Requirement:** [#2325](https://github.com/BestNathan/nession/issues/2325). **Storage:** independent Git orphan branch `refs/heads/knowledge`. Never merge this branch into `main` or `staging`.

## Goals and source hierarchy

Knowledge stores durable, curated, **current** project explanations. It must be sourced, concise, searchable, readable and conservative about authority. Explicit current owner decisions, repository instructions, implementation/Gates and canonical documentation are stronger evidence than a derived article. An unverified LLM note is `candidate`, never a canonical contract.

## Canonical model (v2)

**Full-title filename rule:** The current article filename is formed from the *entire* `title` field in frontmatter: Unicode NFKC normalize, lowercase, convert whitespace/underscores and punctuation to hyphens, collapse repeated hyphens, preserve Unicode letters and digits. E.g. `Nession instruction architecture and knowledge ownership` → `topics/engineering/nession-instruction-architecture-and-knowledge-ownership.md`. Reject empty or filesystem-oversized results instead of truncating, suffixing or inventing a separate ID. **There is no `id` field.** When the title changes, rename the Markdown file and append a `rename` log event with `Previous path`. For a topic move, use `move`. The category index holds full paths, not article IDs.

```text
README.md
schema/v2.json
topics/<primary-topic>/<title-slug>.md
index.json                           # derived search cache
CHANGELOG.md                         # append-only global time/change index
```

- **Article:** exactly one mutable *current* Markdown file per complete article title. Git alone stores older content via previous commits; there are **no vNNNN article files, per-article event folders, or per-entry receipts**.
- **Topic:** one stable primary knowledge area, expressed in the document path and `topic:` frontmatter. Used for navigation and primary grouping, e.g. `architecture`, `engineering`, `terminal`, `ci`, `agents`.
- **Categories:** zero or more normalized, lowercase hyphenated **tags** in `categories: ["architecture", "protocol"]`. Tags overlap topics freely. They are searchable facets, not a parallel folder taxonomy.
- **Frontmatter:** Skill-style YAML fence with a canonical, safe parseable subset: `title`, `description`, `topic`, `categories`, `status` (`verified|candidate`), UTC `created_at`/`updated_at`, `sources`. List-valued fields are JSON-compatible YAML inline string arrays. Put substantive context, decisions, rationale, links, examples and limitations in the Markdown body.
- **Index:** deterministic JSON `schema_version:2`, `topics: {topic: [current article summaries]}`, `categories: {tag: [full article paths]}`. Rebuild from frontmatter using `node scripts/knowledge-ledger-contract.mjs index <worktree>`; never hand-author it. Search the topic first, optionally filter by category/verified status.
- **One global change log:** `CHANGELOG.md`, append-only. Records UTC timestamp, action, complete title, path, topic, categories, reason and Issue/PR URL. Chronological browsing is a *second indexing method* independent of the current-state topic index.

Example:

```markdown
## 2026-10-24T10:00:00Z | update | Terminal transport and recovery
- Path: topics/terminal/terminal-transport-and-recovery.md
- Topic: terminal
- Categories: architecture, recovery
- Reason: New terminal control-mode recovery decision confirmed by Issue
- Source: https://github.com/BestNathan/nession/issues/2325
```

All old log entries remain readable, even when the current article is deleted or moved; Git SHA allows reconstructing exact earlier content. The log is **not** a copy of the article or a mutable `last_updated` record. A commit changing article content must append matching events atomically, and must regenerate the index.

## Trust and atomicity

Normal editor workflow is `edit current Markdown -> append one log record -> regenerate index -> validate -> commit -> publish`. The canonical validator checks frontmatter/path constraints, title-to-filename matching, content/source requirements, topic index, category index, timestamped log entries, and per-commit historical mutations. No article revisions or separate receipt pushes are required. Every successful publication is identified by the resulting Git commit SHA.

Use `node scripts/knowledge-ledger-publish.mjs publish <knowledge-worktree> <expected-remote-sha>` from a trusted operator environment. It fails on stale `knowledge` head and never force-pushes. If concurrent edits happen, reconcile both the affected current articles and the global log, regenerate the index, and revalidate. Failed readback is **Pending**, not a Pass. Do not execute PR-head writer code with GitHub credentials.

The trusted `CI / Knowledge Ledger Audit` workflow runs every six hours and on source changes. It anchors old history outside the orphan ref, detects unexpected ancestors/changed paths, validates the current tree and captures a bounded receipt. A normal Git branch and scheduled audit do **not** establish server-side immutability: protected Rulesets and a trusted writer identity require separate operational setup and live tests (#1690 is about other orphan stores).

## Migration: existing v1 knowledge

Exactly one audited fast-forward migration commit removes the active `entries/<id>/vNNNN.*`, `events/`, and `receipts/` v1 tree and creates **one current article per title** at `topics/<topic>/<title-slug>.md`, `index.json` v2, `CHANGELOG.md`, and `schema/v2.json`. The fixed last v1 checkpoint `56a85f84f39ca806c58a4f410a0c4a72bade51a3` is pinned in the main-owned validator. All pre-migration data remains retrievable with `git show <old-sha>:<old-path>`, but no duplicate active knowledge files remain. From the migration onward, per-commit global log verification applies. Never rewrite the orphan branch to erase old Git history.

## Requirement ownership

Every new or materially revised Requirement records `### Knowledge Impact`: `Decision`, `Related knowledge` (full title/topic/category or explicit search scope), `Reason`, `Owner and timing`, `Evidence`. At implementation/review/acceptance, reassess the plan, publish affected articles and log changes, link resulting commit and keep unverified or unpublished work `Pending`. A `None` decision is valid when justified. See [nession-writing-requirements](../../.claude/skills/nession-writing-requirements/SKILL.md).

## Historical title correction

The original v2 article used the shortened filename `repository-instruction-architecture.md`, which was unrelated to the complete displayed title. A normal fast-forward Git change renames it to `nession-instruction-architecture-and-knowledge-ownership.md`, removes the redundant frontmatter ID, appends a title-based `rename` event to the existing global `CHANGELOG.md`, and regenerates the index from frontmatter. Existing history and the earlier changelog event remain unchanged and retrievable at the old Git SHA.
