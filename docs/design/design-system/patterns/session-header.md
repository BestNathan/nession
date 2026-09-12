# SessionHeader

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [information architecture](../../information-architecture.md) → [interaction](../../interaction/)

SessionHeader is optional compact chrome for the **active Session**. It provides identity, navigation, or continuity-critical state only when those signals are useful to the current work.

> Existing contract: `design/contracts/patterns/session-header.json` ([contracts.md](../contracts.md)). Any contract that requires permanently visible healthy metadata should be reviewed as implementation convergence debt.

## Purpose

Help the user answer a small set of current-work questions without turning the top of the Terminal into an infrastructure dashboard:

- Which Session am I in?
- How do I reach Sessions / Workspace when a visible affordance is needed?
- Is there a connectivity, attachment, or lifecycle problem that threatens continuity?
- Where is this work running, when that distinction matters?

The header is **not** a mandatory container for every available context signal.

## Contextual anatomy

```text
┌─ SessionHeader (when useful) ──────────────────────────────┐
│ [Sessions?]  Session name     [location/state?] [Workspace?] │
└─────────────────────────────────────────────────────────────┘
```

Possible parts:

| Part | Role |
|------|------|
| Session title | Active Session identity; usually the primary header text |
| Sessions affordance | Visible path to Session navigation when navigation is otherwise hidden |
| Workspace affordance | Visible path to Workspace contextual depth |
| Agent/location context | Optional infrastructure identity when it helps disambiguate or recover work |
| ConnectionStatus | Optional compact continuity state when relevant |
| SurfaceSwitcher | One possible Web implementation of Terminal ↔ Workspace access; not required product anatomy |

Not every part is rendered in every state or viewport.

## Presence rules

Apply [`PRINCIPLE.md`](../../../../PRINCIPLE.md) directly:

- healthy Agent/location metadata may be omitted when it adds no useful context;
- degraded connectivity or failed attachment can gain prominence because it affects the work;
- a persistent `Terminal | Workspace` control is optional, not an invariant;
- active capability identity normally belongs near the contextual interaction layer rather than accumulating in the SessionHeader;
- controls that can be reached reliably on demand should not occupy permanent header space without a current reason.

## State dimensions

SessionHeader may compose existing patterns but must not collapse their domains:

```text
Agent / location connectivity
Session lifecycle
client attachment
```

If more than one dimension is shown, preserve their semantic distinction through [ConnectionStatus](connection-status.md) and/or [AgentContext](agent-context.md).

A Session title should not silently turn into a generic "Disconnected" state that obscures whether the Agent, Session, or attachment failed.

## Web vs App

| | Web | App |
|--|-----|-----|
| Session navigation | May already be visible, collapsible, or on demand; header affordance is conditional | Visible non-gesture Sessions affordance required somewhere around the work surface |
| Workspace access | May use SurfaceSwitcher, a compact button, command, or another explicit affordance | Visible non-gesture Workspace affordance + swipe-left |
| Infrastructure context | Show only when useful/relevant | Same semantic rule, adapted to limited space |
| Height | Compact; may disappear/minimize when redundant | Safe-area aware; touch targets must remain accessible |

App's visible controls do not imply a permanent dense header. They may be composed adjacent to the Session surface as long as gestures are not the only route.

## Visual contract

Derived from [visual-language.md](../../visual-language.md) and [composition.md](../../composition.md).

### Dominance

- Current work remains dominant.
- Session title is the only normal primary text if a header is shown.
- Healthy infrastructure context stays secondary/quiet.
- Continuity-threatening state may temporarily gain emphasis.

### Surface treatment

- Flat, content-sized chrome; no healthy elevation.
- Avoid full-width alarm treatment when only one local state is degraded.
- Avoid stacked header/tool bars.
- Do not preserve empty header height solely for controls that are not currently useful.

### Quality through precision

Use stable alignment, concise copy, consistent hit areas, and predictable state transitions. A smaller, well-resolved header is preferable to a richer band of status badges.

## Anti-patterns

- Always showing Agent identity merely because the data exists.
- Treating SurfaceSwitcher as required SessionHeader anatomy.
- Adding one header control per active/installed extension.
- Duplicating the Session list inside the header.
- Permanent connected/healthy badges competing with Session identity.
- A header whose height materially reduces Terminal space without current task value.
- Extension-specific visual chrome that fragments Nession's language.

## Acceptance for future implementation work

- [ ] Session identity remains clear when required by the surrounding composition.
- [ ] Sessions and Workspace remain explicitly reachable; App does not depend on gestures alone.
- [ ] Healthy infrastructure context is allowed to recede or disappear when redundant.
- [ ] Degraded state names the affected dimension rather than collapsing status.
- [ ] SurfaceSwitcher is optional implementation, not mandatory product anatomy.
- [ ] Capability growth does not imply SessionHeader growth.
- [ ] Header chrome yields before the current work surface yields.
