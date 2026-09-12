# UI Validation (architecture)

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [patterns](patterns.md) → [UI contracts](contracts.md)

UI validation enforces the **current approved executable contract** through DOM/layout assertions, viewport coverage, and a deliberately small visual-regression net.

Validation protects implementation from accidental drift. It does not turn yesterday's contract or screenshot into tomorrow's product direction.

**Tracking:** [#544](https://github.com/BestNathan/nession/issues/544)  
**Child issues:** [#546](https://github.com/BestNathan/nession/issues/546) assertions · [#547](https://github.com/BestNathan/nession/issues/547) matrix · [#548](https://github.com/BestNathan/nession/issues/548) visual  
**Runner:** existing `e2e/` Playwright stack

## Core rule

> Prefer structured assertions for measurable rules; use screenshots as a focused safety net; update validation when an intentional upstream product decision changes the rule.

A failing assertion can mean either:

1. implementation drifted from the approved contract; or
2. the product/pattern intentionally changed and the lower-level contract/validation has not converged yet.

Do not automatically "repair" implementation back to an obsolete contract without checking the upstream design owner.

## Assertion framework

Reusable helpers consume merged executable contracts and generated token metadata. They must not hard-code a second copy of product or design values.

Useful assertions include:

| Assertion | Measures |
|-----------|----------|
| single-line / wrap | stable text geometry |
| token height / min size | approved control/row metrics |
| overflow strategy | menu/sheet/scroll/clip behavior |
| touch target | App accessibility |
| visibility | whether an element is present under the tested context |
| alignment | contract-defined spatial relation |
| scroll ownership | which surface receives scroll |
| occlusion / clearance | Terminal/capsule geometry |

### Context-aware validation

Viewport is not sufficient to describe modern Nession UI.

Test fixtures should increasingly be able to express product context such as:

```text
capability: unavailable | available | relevant | active
location: reachable | degraded | unreachable
session: active | exited | unknown
attachment: attached | attaching | detached | failed
surface: current work | workspace depth | capability detail
```

Assertions then verify the contract for that context rather than assuming every capability/control is permanently present.

This is especially important for contextual capability emergence and progressive disclosure.

## Failure shape

Failures should be structured enough for an AI coding agent or developer to diagnose without guessing:

```text
UI_CONTRACT_VIOLATION
pattern: pattern.session-header
rule: visibility / single-line / min-height / ...
experience: web
viewport: web.standard-desktop
context: <named fixture context>
expected: <contract expectation>
actual: <measurement>
```

Include `pattern`, `rule`, `expected`, and `actual`; include `experience`, `viewport`, and context when applicable.

If the failure is caused by an intentional upstream product change, update the pattern/contract/fixture together rather than suppressing the assertion.

## Viewport matrix

Canonical dimensions remain in `design/contracts/viewports.json`.

Representative families include compact/standard/wide Web and narrow/standard/large App phone sizes.

The matrix verifies experience-specific composition; it does not define product presence by itself.

For example:

- a capability can be absent on wide Web because it is irrelevant, not because the viewport is narrow;
- a degraded state can appear on both experiences because context requires it;
- App touch sizing must not inflate Web controls;
- Web density must not erase explicit non-gesture access required by App interaction.

Do not scatter ad-hoc viewport constants through test files.

## Focused visual regression

Screenshots catch appearance changes that structured metrics cannot describe well: hierarchy, rhythm, surface balance, unexpected decorative noise, or major composition regressions.

Keep the baseline set intentionally small and representative.

Useful baseline categories include:

```text
Web current-work / Terminal state
Web Workspace contextual depth
App current-work spatial state
App Workspace depth
one or two contextual capability states
one meaningful degraded/recovery state
```

Baseline names should describe the product state being protected rather than immortalize a particular control (`permanent-workspace-tab-strip`, etc.).

### Screenshot rules

1. Run structured contract assertions before screenshot comparison.
2. Use deterministic fixtures and normalize truly dynamic content.
3. Baseline updates require explicit review/action.
4. CI should publish useful diff artifacts.
5. Do not snapshot every component or every capability state.
6. Do not use a golden screenshot as the sole reason to reject an intentional upstream product change.

## Canonical screen relationship

Historical canonical screens are valuable visual records, but their authority is downstream:

```text
VISION / PRINCIPLE
    ↓
product / interaction / visual docs
    ↓
pattern + contract
    ↓
implementation
    ↓
screenshot baseline
```

When product direction changes, a canonical screenshot can become a migration artifact. The correct response is to intentionally replace the affected baseline after the new design is implemented and reviewed.

## Agent / CI loop

```text
change UI
  -> identify upstream pattern / product decision
  -> static contract validation
  -> DOM/layout assertions across context + viewport matrix
  -> focused screenshots
  -> diagnose failure as drift OR intentional convergence
  -> repair the appropriate lower layer
```

AI repair loops should be given both the contract failure and the canonical pattern reference so they do not optimize blindly for stale geometry.

## Validation of progressive disclosure

Validation should explicitly test absence as well as presence.

Examples:

- unavailable capability leaves no dead navigation slot;
- available-but-not-relevant capability does not automatically become primary chrome;
- relevant/active capability can gain approved contextual presence;
- deeper history/configuration appears only after explicit action;
- healthy infrastructure metadata can be absent when redundant;
- degraded continuity state becomes visible where required.

This protects the Principles against gradual feature-chrome accumulation.

## Non-goals

- Treating screenshots as product source of truth.
- Asserting subjective aesthetics through hundreds of brittle pixel baselines.
- Encoding product semantics directly in test helper code.
- Keeping obsolete controls alive because tests expect them.
- Using only breakpoints to model contextual product state.
- Building a second E2E stack for design validation.

## Maintenance

Validation evolves with the approved design hierarchy. Every changed expectation should be traceable to a contract/pattern change, and every contract/pattern change should remain traceable to the higher-level product model and Principles.
