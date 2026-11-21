---
title: "Nession instruction architecture and knowledge ownership"
description: "Root/scoped/Skill instructions, task-Skill routers with optional external capabilities, and a separate sourced project knowledge ledger"
topic: engineering
categories: ["agents","instructions","knowledge","skills","design"]
status: verified
created_at: 2026-10-24T03:00:28.623Z
updated_at: 2026-11-21T03:48:00Z
sources: ["https://github.com/BestNathan/nession/blob/7d7b41ea9124425fb62c7ec22218526e8ec7ebd8/docs/engineering/instruction-architecture.md","https://github.com/BestNathan/nession/blob/7d4cd5bd6fea372244ca690d548e3321b5a00265/docs/engineering/knowledge-ledger.md","https://github.com/BestNathan/nession/blob/b5cb30196ced16db2046a52bc5f261e6a2e9f61d/.claude/skills/nession-web-design/SKILL.md","https://github.com/BestNathan/nession/blob/b5cb30196ced16db2046a52bc5f261e6a2e9f61d/.claude/skills/nession-web-design/references/routing.md"]
---

# Nession instruction architecture and project knowledge

Nession uses layered repo instructions: root `AGENTS.md` for always-on constraints, nearest scoped `AGENTS.md` for path-local invariants, and `.claude/skills/*/SKILL.md` for repeatable task workflows. Executable rules remain owned by code and Gates; `.agents/skills` exposes the same Skill tree through a symlink.

The `knowledge` orphan Git branch contains **one current article per complete title**, organized by primary topic and secondary category tags. The complete title is the identity; no separate article ID is used. It is not a competing instruction owner and cannot override current canonical documents, explicit decisions, source code or Gates. Previous article contents remain in Git history; the knowledge-base-wide `CHANGELOG.md` indexes recorded changes by time, topic and category. The maintenance lifecycle follows [Ingest / Query / Lint](karpathy-llm-wiki-principles-for-nession-project-knowledge.md).

## Task-Skill routers

A task Skill may be an adaptive router rather than a rule encyclopedia. The router owns task classification, owner precedence, optional-capability selection, and a concise audit record; canonical owners and executable proof remain outside it. `nession-web-design` is the reference implementation after #4223: it routes UI work to canonical design owners, optional Impeccable playbooks/detector, shadcn/ui component selection, and Nession design Gates with Chromium/Playwright proof.

Two invariants keep a router from becoming a second authority:

- external advice (for example, Impeccable) cannot override `VISION.md`, `PRINCIPLE.md`, `docs/design/*`, scoped owners, layout recipes, or capability-local ownership;
- optional-tool availability is an observed state (`active`, `docs-only`, `installable`, `unavailable`), not a claim. Reading a Skill file is not execution, and optional diagnostics never replace Gates, browser proof, or Acceptance evidence.

Focused `references/` files hold routing fixtures, install/fallback rules, and component mechanics; the entrypoint links them instead of copying live inventories. A general Skill resolver/runtime, or converting optional diagnostics into CI enforcement, requires its own Requirement rather than extending this router pattern implicitly.

Limits: Impeccable's command surface and installer flags change with the installed version; discovery must start from the host surface and the installed tool. This article records the routing contract at #4223, not a promise that a particular external command is available.

## Canonical sources

- `docs/engineering/instruction-architecture.md` at main SHA `7d7b41ea9124425fb62c7ec22218526e8ec7ebd8`
- `docs/engineering/knowledge-ledger.md` at main SHA `7d4cd5bd6fea372244ca690d548e3321b5a00265`
- `.claude/skills/nession-web-design/` router and references at main SHA `b5cb30196ced16db2046a52bc5f261e6a2e9f61d` (#4223)

## Related knowledge

- [Web primitive focus treatment and visual vocabulary ownership](../web/web-primitive-focus-treatment-and-visual-vocabulary-ownership.md)
- [Web terminal emulator engine and component ownership](../terminal/web-terminal-emulator-engine-and-component-ownership.md)
- [Nession GitHub Actions workflow domains and trust boundaries](../workflows/nession-github-actions-workflow-domains-and-trust-boundaries.md)
