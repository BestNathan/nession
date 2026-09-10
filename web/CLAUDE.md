# Nession Web UI — Agent Guide

Entry document for work under `web/`. Read this before changing React/UI code.

**This file is not design source of truth.** Product direction and product decision rules live at the repository root, while product model, IA, interaction, visual language, tokens, patterns, and measurable UI contracts live in repository design docs. Skills and prompts may point here; they must not invent a parallel product or design system.

Before proposing or implementing any user-facing Web change, read these two upstream constraints first:

1. [`../VISION.md`](../VISION.md) — where Nession is going and what problem it exists to solve.
2. [`../PRINCIPLE.md`](../PRINCIPLE.md) — the durable rules for product and UX decisions.

`VISION.md` defines product direction. `PRINCIPLE.md` defines how product decisions are made. `docs/design/*` translates those constraints into concrete product and UI models. Existing code does not override that precedence.

Root monorepo workflow (worktrees, CI, release): see repository root `CLAUDE.md`.

---

## 1. Purpose

Nession Web is the browser client for an **intelligent workspace spanning remote and local execution contexts**. Its current implementation connects to a Nession server, discovers Agents, attaches to tmux-backed Sessions, and works primarily in a Terminal surface with contextual Workspace capabilities.

The current implementation is not the product boundary. Web should evolve toward the repository Vision and Principles rather than treating today's tmux/session mechanics or existing chrome as permanent product truth.

---

## 2. Design truth (read in this order; do not duplicate them)

| Concern | Canonical location |
|---------|-------------------|
| Product direction | [`VISION.md`](../VISION.md) |
| Product principles | [`PRINCIPLE.md`](../PRINCIPLE.md) |
| Design index | [`docs/design/README.md`](../docs/design/README.md) |
| Product model | [`docs/design/product-model.md`](../docs/design/product-model.md) |
| Information architecture | [`docs/design/information-architecture.md`](../docs/design/information-architecture.md) |
| Web interaction | [`docs/design/interaction/web.md`](../docs/design/interaction/web.md) |
| App interaction | [`docs/design/interaction/app.md`](../docs/design/interaction/app.md) |
| Workspace | [`docs/design/workspace.md`](../docs/design/workspace.md) |
| Tokens | [`docs/design/design-system/tokens.md`](../docs/design/design-system/tokens.md) · executable: [#467](https://github.com/BestNathan/nession/issues/467) |
| Pattern prose | [`docs/design/design-system/patterns.md`](../docs/design/design-system/patterns.md) · [#470](https://github.com/BestNathan/nession/issues/470) |
| UI contracts | [`docs/design/design-system/contracts.md`](../docs/design/design-system/contracts.md) · [#545](https://github.com/BestNathan/nession/issues/545), tracking [#544](https://github.com/BestNathan/nession/issues/544) |
| Validation (assert / matrix / visual) | [`docs/design/design-system/validation.md`](../docs/design/design-system/validation.md) · [#546](https://github.com/BestNathan/nession/issues/546)–[#548](https://github.com/BestNathan/nession/issues/548) |
| Migration | [`docs/design/migration.md`](../docs/design/migration.md) |

For product-facing work, apply this precedence:

```text
VISION.md
    ↓
PRINCIPLE.md
    ↓
docs/design/*
    ↓
feature design
    ↓
shipping implementation
```

When lower-level design docs or shipping code disagree with Vision or Principles, treat the lower level as design debt to converge rather than as a reason to weaken the upstream constraint.

**Existing architectural principle (from #544):** AI decides *what* to change; Nession UI architecture constrains *how* it may look and behave.

When architecture and shipping code disagree, treat the aligned design documentation as the **target**. Shipping components (Dashboard, Agent cards, ModeBar, …) may be migration predecessors — do not automatically treat them as the long-term IA.

---
