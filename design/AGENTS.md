# Nession Design Source Instructions

This scope owns `design/`: canonical design tokens, contracts, generated projections, and design-system validation sources.

For UI/product design workflow load [../.claude/skills/nession-web-design/SKILL.md](../.claude/skills/nession-web-design/SKILL.md). Product direction remains governed by [../VISION.md](../VISION.md) and [../PRINCIPLE.md](../PRINCIPLE.md).

## Source ownership

- Canonical token values live under `design/tokens/`.
- Canonical UI contracts live under `design/contracts/`.
- Generated artifacts under `design/generated/` are outputs, never hand-edited owners.
- Web consumers use generated/semantic vocabulary instead of inventing feature-local constants.

## Validation

The canonical design checker is `design/scripts/design-gate.mjs`. Callers choose a profile; they must not copy its live rule list.

```bash
./gates/run design-system-fast
./gates/run design-system-full
```

Browser-profile proof belongs in the E2E environment. The mandatory browser
subset is owned by `design/scripts/browser-design-catalog.mjs`; workflows and
the coalesced Full E2E verdict consume it instead of restating spec paths.
`design/scripts/verify-browser-design-report.mjs` derives the independent
design verdict from an already-executed Playwright report and assertion
receipt; missing, skipped, flaky, zero-assertion or foreign-SHA evidence fails
closed.

When adding a design rule, name the invariant, owner, expected state, and repair path. Prefer executable contracts over prose-only restrictions.
