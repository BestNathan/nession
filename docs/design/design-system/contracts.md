# UI Contracts (architecture)

Machine-readable **layout and pattern constraints** for Nession UI. This layer sits above [tokens](tokens.md) and beside [pattern prose](patterns.md): prose owns product semantics; contracts own **measurable** rules that tooling and AI repair loops can enforce.

**Tracking:** [#544](https://github.com/BestNathan/nession/issues/544)  
**Implements:** [#545](https://github.com/BestNathan/nession/issues/545)  
**Upstream:** [#468](https://github.com/BestNathan/nession/issues/468) / [#469](https://github.com/BestNathan/nession/issues/469), [#467](https://github.com/BestNathan/nession/issues/467), [#470](https://github.com/BestNathan/nession/issues/470)  
**Validation stack:** [validation.md](validation.md)

## Principle

> AI decides what to change; Nession's UI architecture constrains how that change is allowed to look and behave.

## Layer stack

```text
Product / IA / Interaction     docs/design/{product-model,information-architecture,interaction/*}
        ↓
Pattern prose (semantics)     docs/design/design-system/patterns/*.md     ← #470
        ↓
Design Tokens (values)        design/tokens/ + design/generated/          ← #467 GATE
        ↓
UI Contracts (measurable)     design/contracts/                           ← #545
        ↓
Browser assertions            e2e helpers                                 ← #546
        ↓
Web/App viewport matrix       design/contracts/viewports.json             ← #547
        ↓
Focused visual regression     small e2e baselines                         ← #548
```

## Ownership

| Layer | Owns | Does not own |
|-------|------|----------------|
| Pattern markdown | Purpose, anatomy, states, Web/App narrative | Pixels, wrap rules, raw heights |
| Tokens (#467) | Resolvable values and identifiers | Layout strategy (`wrap`, `overflow`) |
| Contracts | Measurable rules + token **references** | Product semantics; a second palette |
| Assertions / matrix / visual | How to measure, where to run, screenshot net | Design truth |

Development skills may **point** at contracts. They must not become the source of design truth.

## Relationship to pattern specs

[patterns.md](patterns.md) remains the human-readable product contract (Purpose / Anatomy / States / Tokens / Web vs App / Acceptance).

Executable contracts:

- Express only **testable** constraints (single-line, height token, overflow strategy, touch target, scroll owner, visibility/collapse, allowed layout primitive).
- Reference the pattern via `patternRef` (path to the markdown spec).
- Pattern specs should gain a short index line when a contract exists, e.g. `Contract: pattern.session-header` — do **not** duplicate numeric values into Acceptance.

## #467 gate

Contract **identifiers** and schema are defined here so docs can land before executable tokens are on `main`.

**Resolving token values** (static validation of unknown tokens, height px checks) requires [#467](https://github.com/BestNathan/nession/issues/467) generated metadata (`design/generated/`, lint metadata) on the default branch.

Implementation order:

```text
docs (this file + validation.md)
    ↓
#467 on main
    ↓
#545 design/contracts/* + schema validation
    ↓
#546 → #547 → #548
```

Do not invent a second token vocabulary inside contracts. Prefer Experience identifiers such as `experience.web.control.md` and `experience.app.touchTarget.min` from [tokens.md](tokens.md).

## Inheritance

```text
global.rules
  ↓
category.<layout|chrome|list-row|control|...>
  ↓
pattern.<session-header|session-list|...>
  ↓
override.<rare local>    // discouraged; requires rationale
```

Merge: deeper layers override same-named fields. `web` and `app` blocks merge **independently** — neither silently inherits the other's interaction strategy.

## Storage (executable, when #545 lands)

Platform-neutral contracts live next to tokens:

```text
design/contracts/
  schema.json                 # JSON Schema (or equivalent)
  global.json
  categories/
    chrome.json
    list-row.json
    control.json
  patterns/
    session-header.json
    session-list.json
    session-item.json
    terminal-toolbar.json
    workspace-navigation.json
  viewports.json              # sole viewport matrix source (#547)
```

`docs/design/` describes and indexes; it is not the machine-readable contract tree.

## Expressible constraints

Contracts must be able to represent:

| Field | Role |
|-------|------|
| `wrap` | Single-line vs wrapping |
| `heightToken` / `minHeightToken` | Experience token id for control/row height |
| `overflow` | Strategy enum: `clip` \| `menu` \| `sheet` \| `scroll` \| `wrap` |
| `align` | Alignment intent sufficient for assertions |
| `minWidth` / `maxWidth` | Token reference or named content semantics — no magic numbers unless `override` + rationale |
| `scrollOwner` | Which region owns scrolling |
| `touchTargetToken` | App (e.g. `experience.app.touchTarget.min`) |
| `visibility` | Show/collapse rules by experience |
| `allowedPrimitive` / `patternRef` | Allowed layout primitive or link to #470 prose |

Web/App differences **must** be explicit under `web` / `app`. Tests must not invent divergent expectations with ad-hoc `if (mobile)` branches.

## Conceptual shape

```json
{
  "id": "pattern.session-header",
  "extends": ["category.chrome"],
  "patternRef": "docs/design/design-system/patterns/session-header.md",
  "web": {
    "wrap": false,
    "heightToken": "experience.web.row.md",
    "overflow": "menu"
  },
  "app": {
    "wrap": false,
    "heightToken": "experience.app.row.md",
    "touchTargetToken": "experience.app.touchTarget.min",
    "overflow": "sheet"
  }
}
```

Exact on-disk format (JSON vs TypeScript modules) is an #545 implementation choice. Requirements that do not move:

1. Statically readable by tests/tooling.
2. Values are token identifiers or strategy enums — not copied raw px/colors.
3. Unknown token references fail validation once #467 metadata is available.
4. Shared category rules prevent per-component repetition.

## Initial coverage (vertical slice)

Prefer Session-first chrome involved in [#471](https://github.com/BestNathan/nession/issues/471):

1. `session-list` / `session-item` (list-row)
2. `session-header` (chrome)
3. `terminal-toolbar` (or equivalent session chrome control strip)
4. `workspace-navigation` (shell)
5. One shared `control` / action category pattern

## Non-goals

- A second design system.
- Bespoke prose rulebooks for every component.
- Encoding design truth in agent prompts or skills.
- Letting agents invent arbitrary CSS/layout values outside tokens/contracts.
- Full-site screenshot coverage (see [validation.md](validation.md) visual layer).

## Maintenance

One requirement = one issue. Schema or ownership changes edit this file in place and reference [#545](https://github.com/BestNathan/nession/issues/545) / [#544](https://github.com/BestNathan/nession/issues/544). Do not fork a parallel contracts tree under `docs/` or `e2e/`.
