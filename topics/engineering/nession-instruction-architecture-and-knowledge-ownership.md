---
title: "Nession instruction architecture and knowledge ownership"
description: "Root/scoped/Skill instructions and a separate sourced project knowledge ledger"
topic: engineering
categories: ["agents","instructions","knowledge","skills"]
status: verified
created_at: 2026-10-24T03:00:28.623Z
updated_at: 2026-10-24T05:34:00.000Z
sources: ["https://github.com/BestNathan/nession/blob/7d7b41ea9124425fb62c7ec22218526e8ec7ebd8/docs/engineering/instruction-architecture.md","https://github.com/BestNathan/nession/blob/7d4cd5bd6fea372244ca690d548e3321b5a00265/docs/engineering/knowledge-ledger.md"]
---

# Nession instruction architecture and project knowledge

Nession uses layered repo instructions: root `AGENTS.md` for always-on constraints, nearest scoped `AGENTS.md` for path-local invariants, and `.claude/skills/*/SKILL.md` for repeatable task workflows. Executable rules remain owned by code and Gates; `.agents/skills` exposes the same Skill tree through a symlink.

The `knowledge` orphan Git branch contains **one current article per complete title**, organized by primary topic and secondary category tags. The complete title is the identity; no separate article ID is used. It is not a competing instruction owner and cannot override current canonical documents, explicit decisions, source code or Gates. Previous article contents remain in Git history; the knowledge-base-wide `CHANGELOG.md` indexes recorded changes by time, topic and category. The maintenance lifecycle follows [Ingest / Query / Lint](karpathy-llm-wiki-principles-for-nession-project-knowledge.md).

## Canonical sources

- `docs/engineering/instruction-architecture.md` at main SHA `7d7b41ea9124425fb62c7ec22218526e8ec7ebd8`
- `docs/engineering/knowledge-ledger.md` at main SHA `7d4cd5bd6fea372244ca690d548e3321b5a00265`
