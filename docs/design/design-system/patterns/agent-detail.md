# AgentDetail

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [workspace](../../workspace.md)

AgentDetail is a **contextual infrastructure detail view** for one execution endpoint that participates in the current work. Today that endpoint is usually a Nession Agent; in the long-term product model it may be the provider behind a Workspace Location.

It is not a permanent Workspace tab and it is not the navigation parent for Sessions.

## Purpose

Help the user inspect or recover the execution context behind current work when infrastructure detail is actually useful.

Typical reasons to open it include:

- a Session cannot currently be reached;
- the user wants to know where the work is running;
- a Workspace Location needs diagnostics or configuration;
- a capability depends on provider-specific information;
- the user explicitly asks for connection/network/runtime detail.

The view should absorb infrastructure complexity instead of forcing every user through it before they can work.

## Entry context

AgentDetail may be reached from different places:

```text
Session context
    -> affected Agent / Workspace Location detail

Workspace Location
    -> provider / Agent detail

failure or recovery affordance
    -> focused detail directly
```

Do not require `Workspace -> Agent tab` as the only route. That would turn an implementation layout into product structure.

## Scope

The detail view describes **one infrastructure endpoint / Workspace Location realization**.

It may include:

```text
identity
provider / Agent
location relationship
connectivity + last evidence
addresses / versions / runtime facts
capabilities exposed by this endpoint
actions / recovery
optional current-Session context
```

A Workspace may contain multiple Locations. AgentDetail must not imply that one Agent is the Workspace itself.

## Session context is optional

When opened from an active Session, the view may include the Session lifecycle and this-client attachment as contextual facts.

When opened from Workspace-level location inspection with no active Session relationship, those channels may be omitted.

```text
Agent / location connectivity   required for this view
Session lifecycle               contextual, when applicable
client attachment               contextual, when applicable
```

Never invent Session state simply to fill a three-channel layout.

## Progressive disclosure

At rest, Agent/location information should normally be quiet or absent elsewhere in the product. AgentDetail is the explicit deeper layer where technical detail can become dense.

Recommended depth:

1. current-work surface: only continuity-critical state;
2. compact context: location/provider identity when useful;
3. AgentDetail: full diagnostics/configuration/facts.

The existence of AgentDetail is a reason **not** to keep all Agent facts permanently visible in Session chrome.

## Anatomy

A single detail surface is the default:

```text
Execution context

  identity          Workspace Location / Agent / provider
  connectivity      online / reconnecting / offline / error
  evidence          heartbeat, last seen, last error
  network           host, addresses, relay/P2P facts when useful
  runtime           version / platform / provider facts
  capabilities      contextual availability summary, not a feature launcher
  session context   optional current Session + attachment facts
  actions           retry, refresh, copy, configure, recover
```

Use stacked sections or compact key/value groups. Do not inherit Files master/detail merely because the view lives under Workspace.

## Multi-location behavior

For a logical Workspace with several Locations:

- this view stays scoped to the selected Location/provider;
- an outage in one Location does not imply the whole Workspace is offline;
- capability availability should be described at the appropriate Location scope;
- switching Locations belongs to Workspace context/navigation when relevant, not to a global Agent dashboard embedded here.

## States

| Condition | Presentation |
|-----------|--------------|
| Healthy and explicitly opened | Full facts are readable but success state remains visually restrained |
| Connecting / reconnecting | Show current transition and useful recovery evidence |
| Offline / error | Connectivity becomes prominent; preserve last-known facts where useful |
| Session context available | Show Session/attachment facts as a separate contextual section |
| No Session context | Omit Session/attachment section rather than manufacturing empty status chrome |

Copy should name the affected infrastructure dimension. Prefer `Agent offline`, `Location unreachable`, or provider-specific language over a fused `Session failed` label when the Session lifecycle is unknown.

## Capability relationship

AgentDetail may summarize capabilities exposed by this endpoint, but it is not a capability marketplace.

A capability listed here does not automatically earn permanent Workspace navigation. Presence elsewhere still follows the contextual capability lifecycle:

```text
unavailable -> available -> relevant -> active
```

Extensions may contribute diagnostic data or actions for this detail view; Nession owns composition and visual hierarchy.

## Tokens

| Part | Tokens |
|------|--------|
| Surface | Domain `workspace.surface` / Semantic surfaces |
| Agent connectivity | current Domain `agent.*` tokens |
| Session context | Domain `session.*` when applicable |
| Attachment context | Domain `attachment.*` when applicable |
| Body / labels | Semantic `text.primary` / `text.secondary` |
| Actions | Experience `control.*` |

Current `agent.*` tokens reflect today's Agent-backed infrastructure. Future provider/location semantics should extend the Domain vocabulary deliberately rather than overloading one generic status token.

## Web vs App

| | Web | App |
|--|-----|-----|
| Presentation | Focused Workspace view, panel, sheet, or contextual route | Push view / sheet in the Workspace stack |
| Entry | From affected Session, Workspace Location, search/palette, or recovery affordance | Same semantic entries adapted to native navigation |
| Close | Return to the invoking work context | Pop to previous contextual layer |
| Density | Compact diagnostic information | Touch-safe spacing without marketing-page whitespace |

Neither experience requires a permanent `Agent` navigation item.

## Visual contract

### Dominance

- AgentDetail may be information-dense because the user explicitly opened it.
- Within the full product it remains contextual depth, not the dominant default surface.
- Healthy infrastructure does not need celebratory success chrome.
- Failure emphasis stays local to the affected endpoint/state.

### Surface treatment

- Prefer one flat detail surface with whitespace/section rhythm.
- Avoid nested cards for every field group.
- Use elevation only when the view itself is presented as an overlay/sheet for interaction reasons, not to decorate healthy state.

### Information hierarchy

1. endpoint/location identity;
2. affected connectivity or recovery state when present;
3. useful diagnostic facts;
4. optional Session context;
5. secondary actions/history.

## Anti-patterns

- Agent grid or Agent-grouped Session browser as the primary purpose of this view.
- Assuming one Agent equals one Workspace.
- Requiring a permanent Workspace Agent tab.
- Showing every Agent capability as a launcher card.
- Fusing Agent connectivity, Session lifecycle, and attachment into one badge.
- Showing Session status when no Session is in context.
- Treating Agent as an AI assistant merely because coding agents may run inside Sessions.
- Files-style master/detail applied to infrastructure facts without need.

## Acceptance for future implementation work

- [ ] Detail can be opened contextually without depending on a permanent Agent tab.
- [ ] One view describes one Agent/provider/Workspace Location realization.
- [ ] Multi-location Workspace semantics are not collapsed into one Agent.
- [ ] Session and attachment context are optional and independently represented.
- [ ] Infrastructure failure does not falsely redefine Session lifecycle.
- [ ] Capability summaries do not become a permanent feature launcher.
- [ ] Healthy detail remains precise and quiet; degraded state gains only the emphasis needed for recovery.
