# AgentContext

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [product model](../../product-model.md) → [information architecture](../../information-architecture.md)

AgentContext presents infrastructure/location identity and health **when that context is useful to the current work**.

It is quiet when healthy, prominent when continuity is threatened, and absent when the information would be redundant.

## Purpose

Help the user understand where a Session is running or why it cannot currently be reached without making Agent the navigation parent or permanently advertising infrastructure.

Progressive disclosure can include:

1. compact location/Agent metadata in a Session row when it helps distinguish work;
2. contextual Agent/location identity around the active Session when relevant;
3. deeper Agent/Workspace Location detail when explicitly requested.

These are possible disclosure levels, not a requirement that every level always render.

## Presence rules

```text
healthy + redundant
    -> may be hidden

healthy + useful for disambiguation
    -> quiet identity

connecting / reconnecting
    -> contextual medium emphasis

offline / error affecting current work
    -> prominent local state + recovery/detail affordance
```

Do not show a green success badge merely because the Agent is online.

## Anatomy

```text
Healthy when useful:
  devbox-01

Degraded:
  [!] devbox-01 · Agent offline
```

| Part | Role |
|------|------|
| Agent / location identity | Which execution context is relevant |
| Indicator | Optional state mark for Agent/location connectivity only |
| Status phrase | Present when degraded; usually omitted when healthy |
| Detail affordance | Opens deeper infrastructure/location information when requested |

Do not list all Sessions belonging to the Agent here. That would recreate Agent-first navigation.

## State semantics

This pattern represents **Agent / Workspace Location connectivity only**.

Session lifecycle and client attachment remain separate dimensions and may be composed through [ConnectionStatus](connection-status.md).

| Agent/location state | Typical visual weight | Example copy |
|----------------------|-----------------------|--------------|
| `online` | hidden or quiet | identity only, if useful |
| `connecting` | medium | “Connecting to Agent” |
| `reconnecting` | medium–high | “Agent reconnecting” |
| `offline` | high when it affects current work | “Agent offline” / “Agent unreachable” |
| `error` | high when actionable | “Agent error” |

Avoid ambiguous copy such as “Session offline” when the actual problem is Agent connectivity.

## Relationship to Workspace Locations

The long-term product model treats local/remote execution as properties of **Workspace Locations**.

AgentContext may therefore evolve into location/provider context rather than exposing Agent as the only execution identity. UI should avoid assumptions that every Workspace Location is permanently represented by one visible Agent object.

Current Agent-backed state remains a valid implementation source.

## Opening details

Deeper infrastructure information belongs in contextual depth:

- Web may open Agent/Location detail from Workspace or a focused contextual surface;
- App may push Agent/Location detail on the Workspace navigation stack;
- a failure affordance may link directly to relevant detail/recovery without first navigating a feature lobby.

Do not require `SurfaceSwitcher → Workspace → Agent tab` as the only route; that encodes current shell mechanics as product truth.

## Visual contract

Derived from [visual-language.md](../../visual-language.md).

### Dominance

- Infrastructure identity is secondary to the current work.
- Healthy state is quiet enough to disappear when redundant.
- Degraded state gains emphasis only in proportion to its effect on continuity.

### Surface treatment

- No bordered card or elevation for healthy context.
- Optional local Domain tint for `offline` / `error`; prefer the weakest sufficient cue.
- Do not turn the entire SessionHeader into an error surface when only Agent connectivity is degraded.

### Density

- Compact metadata form should remain one line.
- App touch affordances meet target size without forcing always-visible large chrome.

## Web vs App

Same semantics on both experiences; placement may differ.

| | Web | App |
|--|-----|-----|
| Healthy presence | Optional quiet metadata | Optional quiet metadata |
| Degraded presence | Near affected Session/work context | Near affected Session/work context |
| Open details | Workspace/focused contextual surface | Workspace stack / sheet / pushed detail |
| Touch | pointer-sized controls where appropriate | touch-target minimum when tappable |

## Anti-patterns

- Green border/glow for a healthy Agent.
- Always reserving AgentContext space because Agent data exists.
- “Session offline” / “Disconnected” with no affected-dimension distinction.
- Listing other Sessions for this Agent as primary navigation.
- Requiring a fixed Workspace Agent tab to reach detail.
- Giving Agent equal visual weight to the current work.

## Acceptance

- [ ] Healthy Agent/location context can be omitted when redundant.
- [ ] Healthy context is quiet when shown.
- [ ] Offline/reconnecting/error becomes prominent only where it matters and names the affected infrastructure dimension.
- [ ] Session lifecycle and attachment are not absorbed into the Agent indicator.
- [ ] Detail access does not recreate Agent-first navigation or require a permanent tool tab.
- [ ] The pattern can evolve from Agent identity toward broader Workspace Location/provider identity without changing its product role.
