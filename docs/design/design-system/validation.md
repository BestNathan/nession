# UI Validation (architecture)

How Nession **enforces** [UI contracts](contracts.md): browser assertions, the Web/App viewport matrix, and a small visual-regression net.

**Tracking:** [#544](https://github.com/BestNathan/nession/issues/544)  
**Child issues:** [#546](https://github.com/BestNathan/nession/issues/546) assertions · [#547](https://github.com/BestNathan/nession/issues/547) matrix · [#548](https://github.com/BestNathan/nession/issues/548) visual  
**Depends on:** [contracts.md](contracts.md), [#467](https://github.com/BestNathan/nession/issues/467) for resolved token values  
**Runner home:** existing `e2e/` Playwright suite (extend; do not create a second E2E stack)

## Principle

Prefer **computed layout/DOM measurements** for measurable rules. Screenshots are a final safety net, not the primary checker for line count, height, overflow, or touch target.

Failures must be structured so an AI coding agent can repair without a human restating the same UI constraint.

## Assertion framework (#546)

### Location

Reusable helpers under `e2e/helpers/` (e.g. `ui-assert/`). Helpers consume:

1. Merged contract data from `design/contracts/`
2. Token resolution from `#467` generated metadata

Do **not** hard-code a second copy of design values inside helpers.

### Initial helper set (names illustrative)

| Helper | Measures |
|--------|----------|
| `expectSingleLine` | Element behaves as one line (vs unintended wrap) |
| `expectTokenHeight` | Measured height ≈ resolved height token (± documented tolerance) |
| `expectNoUnexpectedOverflow` | No overflow beyond the contract's `overflow` strategy |
| `expectTouchTarget` | Hit area ≥ App `touchTargetToken` |
| `expectVisibleWithin` | Target visible within a named container |
| `expectAligned` | Matches contract alignment intent |
| `expectScrollable` | `scrollOwner` scrolls; siblings do not steal scroll |

### Required failure shape

```text
UI_CONTRACT_VIOLATION
pattern: pattern.session-header
rule: single-line
experience: web
viewport: web.standard-desktop
expected: wrap=false (1 line)
actual: 2 lines
measuredHeight: 56px
expectedHeightToken: experience.web.row.md
resolvedExpectedHeight: 36px
```

Always include: `pattern`, `rule`, `expected`, `actual`, and when applicable `experience` + `viewport`.

### Proof and CI

- Each important assertion has a **deliberately broken fixture** that must fail.
- At least one real Session / Terminal / Workspace pattern is protected.
- Run via the existing Playwright workflow (`.github/workflows/e2e.yml`).
- Fast enough for normal local + CI use.

### Non-goals

- Asserting subjective aesthetics.
- Replacing pattern prose semantics.
- Scattering viewport-specific expected values inside individual specs.

## Viewport matrix (#547)

### Single source

Canonical sizes and experience tags live in **`design/contracts/viewports.json`** (created with #545/#547). Tests must not redefine dimensions.

### Initial matrix

| ID | Experience | Role | Suggested size |
|----|------------|------|----------------|
| `web.compact-laptop` | web | Compact laptop | 1280×800 |
| `web.standard-desktop` | web | Default desktop | 1440×900 |
| `web.wide-desktop` | web | Wide desktop | 1920×1080 |
| `app.narrow-phone` | app | Narrow phone | 375×812 |
| `app.standard-phone` | app | Standard phone | 390×844 |
| `app.large-phone` | app | Large phone (only if product-supported) | 430×932 |

Exact pixels may be tuned, but **only** by editing `viewports.json`.

### Experience mapping (near term)

Nession's App interaction model ([interaction/app.md](../interaction/app.md)) is not a shrunk Web layout. Until a native App shell ships, **App matrix rows run on Mobile Web** as a proxy: narrow viewport + **App** contract blocks (touch targets, `overflow: sheet`, etc.).

Product chrome commonly treats Tailwind `lg` (~1024px) as the wide/narrow boundary. That breakpoint informs which matrix family applies; it does not replace `viewports.json` as the size source.

Native App later reuses the same viewport IDs and contracts — do not invent a parallel matrix vocabulary.

### Execution rules

For each critical pattern:

1. Load the merged contract for the pattern.
2. Run applicable `#546` assertions on each applicable matrix row.
3. Take **all** expectations from the contract's `web` / `app` block — never from ad-hoc conditionals in the test body.

Cover: wrap/single-line, overflow ownership, visibility/collapse, App touch targets, minimum usable panel width, toolbar overflow strategy, scroll ownership.

### Density isolation

- Web compact-density checks must **not** impose App touch sizing.
- App touch / sheet rules must **not** force Web desktop controls larger.
- CI output must name failing `experience` + `viewport` id.

## Focused visual regression (#548)

### Role

Screenshots run **after** executable UI assertions. They catch appearance regressions that metrics miss. They do **not** replace contract checks for measurable rules.

### Initial baselines (keep small)

| Baseline ID | Experience | Surface |
|-------------|------------|---------|
| `web.session-terminal-primary` | web | Session + Terminal primary workspace |
| `web.workspace-shell` | web | Workspace navigation / shell |
| `web.agent-context-in-flow` | web | Agent/connection presentation on the primary path (if bound to shell) |
| `app.session-terminal-primary` | app (Mobile Web proxy) | Representative App primary surface |

### Rules

1. Assertions (#546/#547) before screenshot compare.
2. Deterministic fixtures and stable data; mask or normalize inherently dynamic regions.
3. Baseline updates require an **explicit** developer action (dedicated command/flag) — no silent refresh.
4. CI publishes useful diff artifacts on failure.
5. Do not snapshot every component or state.

## Agent / CI loop

```text
change UI
  → contract static validate (#545, needs #467 metadata)
  → Playwright assertions across matrix (#546/#547)
  → focused screenshots (#548)
  → on UI_CONTRACT_VIOLATION: agent repairs from structured fields
```

Design truth remains in architecture docs, tokens, and contracts — not in repeated human visual feedback.

## Implementation gate

This document is architecture only. No assertion helpers, viewport JSON, or baselines are required for this doc to land.

When implementing:

1. `#467` on `main` (token resolution).
2. `#545` contract files + schema.
3. `#546` helpers + broken fixtures.
4. `#547` matrix wiring.
5. `#548` small baseline set.

## Maintenance

Edit in place. Reference [#544](https://github.com/BestNathan/nession/issues/544) and the relevant child issue. Keep the critical visual set intentionally small to avoid screenshot churn.
