# Styling Source Convergence

Migration plan for reconciling overlapping styling paths after canonical screens and Visual Contracts are approved ([#561](https://github.com/BestNathan/nession/issues/561) Phase 5).

**Status:** Audit + plan only — implementation PRs follow separately on `staging`.
**Upstream:** [visual-language.md](visual-language.md), [composition.md](composition.md), [design-system/tokens.md](design-system/tokens.md)
**Target ownership:**

```text
design/tokens
    ↓
design/generated (CSS + lint metadata)
    ↓
shadcn generic primitives
    ↓
product pattern recipes (session-first/)
    ↓
screens / fixtures
```

This is a **convergence task**, not a mandate to tokenize every Tailwind metric. Layout/composition rules stay readable in [composition.md](composition.md); only **repeated, approved** values graduate to tokens ([#561](https://github.com/BestNathan/nession/issues/561) Phase 8).

## Current sources (as of staging @ Phase 2C)

| Source | Location | Role today | Issue |
|--------|----------|------------|-------|
| Executable tokens | `design/tokens/*.json` → `design/generated/web.css` | Semantic / Domain / Experience values ([#467](https://github.com/BestNathan/nession/issues/467)) | Incomplete coverage; capsule/terminal paths ahead of shell chrome |
| Session-first overlay | `web/src/index.css` `--sf-*` | Spacing, type scale, motion, focus, terminal well color for session-first shell | Parallel vocabulary to generated tokens; used directly in TSX via `var(--sf-*)` |
| Raw Tailwind in session-first | `web/src/session-first/**/*.tsx` | Ad-hoc `size-9`, `size-11`, `max-lg:*`, `gap-1.5` | Some map to Experience tokens; some are one-off layout |
| shadcn defaults | `web/src/components/ui/*` | Generic primitives | Correct layer — do not fork for product identity |
| Capsule token bridge | Generated vars + `[data-experience]` | Composer/capsule metrics | **Target state** for shell chrome migration |
| Legacy dashboard | `web/src/components/*` | Agent-first UI | Out of scope until migration ([#472](https://github.com/BestNathan/nession/issues/472)) |

### `--sf-*` inventory (session-first shell)

Defined in `web/src/index.css` on staging:

| Variable | Approximate role | Convergence target |
|----------|------------------|-------------------|
| `--sf-space-1` … `--sf-space-5` | Shell padding/gaps | `experience.web.spacing.*` / composition prose for one-off gutters |
| `--sf-text-title`, `--sf-text-body`, `--sf-text-muted` | Chrome typography | Semantic type roles in [visual-language.md](visual-language.md) → Experience tokens |
| `--sf-leading` | Line height | Experience token or inherit from semantic type |
| `--sf-terminal-well` | Well background | **`domain.terminal.wellBackground`** (already in token spec; replace `--sf-terminal-well` usage) |
| `--sf-focus-ring`, `--sf-focus-offset` | Focus ring | Semantic `focus.*` or shadcn `--ring` — single source |
| `--sf-motion`, `--sf-ease` | Transitions | `experience.*.motion.*` |

**Consumers (staging):** `SessionFirstMain`, `SessionFirstSidebar`, `SessionHeader`, `SessionItem`, `SessionListHeader`, `AppToolHeader`, `AppBackButton`, `TerminalWell`, workspace shell/tools — 17 files reference `--sf-*` or assert on it in tests.

**ESLint:** `web/eslint-plugin-nession/rules/no-capsule-magic-metrics.js` guards capsule paths; shell `--sf-*` is not yet lint-gated.

## Duplication and gaps

1. **Same concept, two names:** `--sf-terminal-well` vs `domain.terminal.wellBackground` generated var — TerminalWell uses overlay; capsule spec says generated only.
2. **Typography:** Visual language defines roles; shell uses `--sf-text-*` while tokens define Experience control/row heights separately.
3. **Spacing:** `--sf-space-*` duplicates Tailwind spacing scale semantically but bypasses lint metadata from #467.
4. **Intentional raw layout:** `max-lg:gap-1.5`, `size-11` for App 44px targets — some align with `touchTarget.min`, some are breakpoint-specific composition (keep in composition.md, not tokens).
5. **Capsule path is cleaner:** TerminalCapsule spec already forbids `--sf-*`; convergence should **extend capsule rules upward** to shell chrome, not add more `--sf-*`.

## Migration principles

1. **Explore → approve → abstract → tokenize → enforce** ([#561](https://github.com/BestNathan/nession/issues/561)) — no new token batches until a Visual Contract repeats the value.
2. **One owner per concept** — if generated CSS exposes a var, delete the `--sf-*` twin.
3. **Composition stays prose** — sidebar width strategy, page gutters, and "when edge-to-edge" remain in [composition.md](composition.md) until a third screen needs the same number.
4. **Do not tokenize one-offs** — e.g. a single `max-lg:gap-1.5` in SessionHeader is composition, not `experience.web.gap.headerCompact`.
5. **Lint follows maturity** — extend ESLint only after migration PR removes the old path (avoid blocking exploratory fixes).

## Proposed PR sequence (implementation, post-this-doc)

| Step | Scope | Base | Notes |
|------|-------|------|-------|
| 1 | Replace `--sf-terminal-well` → generated `domain.terminal.wellBackground` | `staging` | TerminalWell + tests only |
| 2 | Map `--sf-space-*` shell usages → generated Experience spacing (or composition constants documented once) | `staging` | SessionHeader, SessionItem, sidebar — file-by-file |
| 3 | Map `--sf-text-*` → semantic type tokens when #467 extends type generation | `staging` | Blocked partially on #467 type output |
| 4 | Map `--sf-motion` / `--sf-ease` → `experience.*.motion.*` | `staging` | Small, mechanical |
| 5 | Remove empty `--sf-*` block from `index.css` | `staging` | After zero references |
| 6 | Extend `no-capsule-magic-metrics` or add `no-sf-overlay-vars` for session-first TSX | `staging` | After removal |
| 7 | Audit raw `size-*` in session-first against `touchTarget.min` / control tokens | `staging` | Document exceptions in composition |

## Explicit non-goals (this phase)

- Tokenizing every Tailwind class in session-first TSX.
- Migrating legacy `web/src/components/*` dashboard paths.
- Changing shadcn primitive internals.
- Resolving #467 entirely — convergence consumes #467 output, does not replace it.

## Acceptance (Phase 5 doc complete)

- [x] All styling sources listed with ownership target.
- [x] `--sf-*` inventory and consumer list documented.
- [x] Duplication called out with named token targets.
- [x] Implementation PR sequence defined separately from token speculation.
- [x] Implementation PRs merged on `staging` (#578 `--sf-*` removal, #580 shell control tokens; step 7 exceptions in [composition.md](composition.md) §14).

## Related

- [#561](https://github.com/BestNathan/nession/issues/561) Phase 5 acceptance criteria
- [#467](https://github.com/BestNathan/nession/issues/467) executable tokens
- [terminal-capsule.md](design-system/patterns/terminal-capsule.md) — reference implementation for token-only capsule path
