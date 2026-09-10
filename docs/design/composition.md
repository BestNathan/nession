# Layout / Composition

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product-model.md](product-model.md) → [information-architecture.md](information-architecture.md) → [interaction](interaction/) → [visual-language.md](visual-language.md)

This document defines page-level relationships for the Session-first shell: what owns space, how chrome yields to work, how contextual layers appear, and how Web/App differ.

Exact values belong in [design-system/tokens.md](design-system/tokens.md) and measurable rules in [design-system/contracts.md](design-system/contracts.md).

## Composition invariant

> **The current work owns the frame. Persistent chrome must justify every pixel. Contextual depth overlays, replaces, or temporarily shares attention only when the user asks for it.**

For the current implementation, Terminal is the dominant work surface of an active Session.

## 1. Session working frame

The default active Session should read approximately as:

```text
┌───────────────────────────────────────────────────────────────┐
│ quiet Session / connectivity context              [context]  │
│                                                               │
│                                                               │
│                     TERMINAL / CURRENT WORK                   │
│                                                               │
│                                                               │
│                [ contextual interaction capsule ]             │
└───────────────────────────────────────────────────────────────┘
```

The drawing intentionally does not prescribe a permanent Session sidebar, permanent `Terminal | Workspace` switcher, or permanent Workspace tool bar. Those may be current implementation mechanisms, but they are not composition invariants.

Relationships:

- active work receives the majority of horizontal and vertical space;
- chrome stays close to the edges and is content-sized;
- infrastructure metadata stays quiet unless it threatens work continuity;
- the TerminalCapsule floats over/within the work surface without creating a new global chrome band;
- capability presence appears contextually rather than reserving permanent slots;
- Workspace is explicit contextual depth and preserves the active Session.

## 2. Session navigation

Session navigation must remain fast and discoverable while yielding space to the active work.

Preferred composition families include:

- overlay drawer;
- collapsible rail/sidebar;
- compact Session switcher;
- search/command entry with a visible navigation affordance.

A wide permanent sidebar is not an invariant. On a layout where it materially helps repeated Session switching, it must still remain visually secondary and should collapse when space or focus requires it.

Extra viewport width belongs to the work surface before it belongs to navigation.

## 3. Top chrome

Top chrome should communicate only what the current work needs: Session identity, meaningful location/Agent context, recovery state, and explicit navigation affordances.

Rules:

- avoid multiple stacked toolbars for the same region;
- avoid persistent product branding inside the active work shell when it adds no task value;
- healthy state is represented quietly rather than as a row of badges;
- Workspace access may be visible, but the exact widget is not a product invariant;
- a capability should not add permanent top chrome merely because it is installed.

## 4. Terminal surface

Terminal is flush within its work region:

- no card treatment around xterm;
- no decorative border/radius around the hero surface;
- only the Terminal's own comfort padding and interaction-clearance rules apply;
- chrome yields before terminal viewport space is sacrificed.

When contextual overlays/panels are opened, they should preserve the user's sense of the same Session rather than navigating to an unrelated dashboard.

## 5. TerminalCapsule

The TerminalCapsule is a floating interaction surface, not a bottom toolbar band.

Composition rules:

- compact at rest;
- allowed to grow only as input or explicitly opened contextual content requires;
- safe-area aware on App;
- bounded/inset appropriately on Web;
- capability presence is lightweight and state-driven;
- `+`/expansion opens secondary controls without permanently widening the resting capsule;
- deeper capability surfaces may open as popover, sheet, overlay, or contextual panel chosen by Nession.

See [design-system/patterns/terminal-capsule.md](design-system/patterns/terminal-capsule.md).

## 6. Workspace composition

Workspace is contextual depth around the logical work, not a tool lobby.

A Workspace root may contain resources, capability summaries, locations, and contextual sections. Its composition should follow what exists and matters in the current Workspace.

Do not reserve a fixed navigation slot for every registered capability.

Individual capability layouts remain local:

- Files may use tree + editor master/detail on wide Web;
- App Files may push an editor;
- Git may use changes/status/detail regions;
- Claude Code may expose state/history/configuration;
- Agent/location detail may use a contained information layout.

Workspace-level navigation should be compact or on-demand and must not create a second app shell.

## 7. Web composition

Web has more horizontal space but should not spend it automatically on chrome.

Typical wide state:

```text
[quiet top context]
┌───────────────────────────────────────────────────────────────┐
│                    active work surface                       │
│                                                               │
│                 [interaction capsule]                        │
└───────────────────────────────────────────────────────────────┘

Session navigation / Workspace / capability depth open as needed.
```

Rules:

- the shell is generally full-bleed;
- extra width grows work capacity first;
- drawers/side panels overlay or consume space only when intentionally opened;
- reading/configuration content inside Workspace may use max widths;
- Terminal should not be centered inside a decorative page column;
- narrow Web remains Web interaction, not an accidental App clone.

## 8. App composition

App follows the spatial model:

```text
Sessions  ←  Terminal / current Session  →  Workspace
```

The Terminal gets the maximum usable central region. Visible controls provide alternatives to gestures but stay visually quiet.

App-specific rules:

- respect top/bottom safe areas;
- prefer touch-target sizes over desktop compactness;
- use native push/pop or sheets for deeper capability content;
- nested capability navigation must not fight top-level spatial gestures;
- capsule placement should support thumb reach without covering critical Terminal rows;
- Workspace transition should feel spatially continuous with the Session.

## 9. Responsive sacrifice order

When space becomes constrained:

```text
optional chrome yields
    ↓
secondary metadata compresses/hides
    ↓
on-demand navigation replaces persistent navigation
    ↓
work surface yields last
```

Do not preserve a toolbar/sidebar at the cost of making the actual work unusable.

## 10. Surface and inset rules

| Content | Default treatment |
|---------|-------------------|
| Terminal/current live work | Flush / maximum region |
| Session list | Fill its opened navigation region |
| Workspace resource lists | Fill local region, modest contextual inset as needed |
| Editors / reading content | Inset; optional max width where readability benefits |
| Forms / settings / details | Contained |
| TerminalCapsule | Floating contained surface |
| Capability overlay/sheet | Contained/elevated contextual layer |

Containment is a content decision, not a default desire to put everything in cards.

## 11. Large-screen whitespace

Whitespace is not unused product surface that must be filled with features.

On large screens:

- do not widen navigation indefinitely;
- do not add feature cards merely because space exists;
- allow work surfaces and meaningful contextual views to breathe;
- keep reading-width constraints local to prose/configuration content.

## 12. Current contracts and canonical screenshots

Existing `design/contracts/*`, fixture screens, and visual-regression baselines encode the previously approved Session-first implementation. They remain useful evidence and migration protection, but some currently encode assumptions such as a persistent SurfaceSwitcher or Workspace tool bar.

After this product convergence, those assumptions must be reviewed against [`PRINCIPLE.md`](../../PRINCIPLE.md).

Do not silently change executable contracts in a documentation-only edit. Instead:

1. mark the product-level relationship here;
2. identify mismatched executable contracts/screens as implementation debt;
3. update implementation + contracts + baselines together in follow-up work.

A golden screenshot protects an intentional implementation. It does not outrank the product contract.

## 13. Tokenization rule

Tokenize stable reusable values, not product relationships.

Good token candidates:

- control heights;
- touch-target minimums;
- capsule radius/insets;
- standard spacing;
- drawer/sheet dimensions after the interaction pattern stabilizes.

Do not tokenize:

- "Workspace is contextual depth";
- capability relevance rules;
- Session-first navigation semantics;
- progressive-disclosure behavior.

Those belong in product/interaction documentation.

## Anti-patterns

- permanent chrome preserved only because a prior screenshot contained it;
- every capability claiming a toolbar/tab slot;
- wide-screen layouts filling empty space with feature cards;
- stacked chrome bands around the Terminal;
- nested full-height sidebars for Workspace + Files + capability navigation;
- multiple floating controls competing with the TerminalCapsule;
- responsive behavior that protects chrome before the work surface.

## Ownership boundaries

- product direction → [`VISION.md`](../../VISION.md)
- product decisions → [`PRINCIPLE.md`](../../PRINCIPLE.md)
- product entities → [product-model.md](product-model.md)
- IA → [information-architecture.md](information-architecture.md)
- interaction → [interaction/](interaction/)
- Workspace semantics → [workspace.md](workspace.md)
- visual hierarchy → [visual-language.md](visual-language.md)
- values → [design-system/tokens.md](design-system/tokens.md)
- measurable rules → [design-system/contracts.md](design-system/contracts.md)
