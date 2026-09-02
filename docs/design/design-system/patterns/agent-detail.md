# AgentDetail

Workspace **Agent** tool: full Agent and connection details. Single detail layout — not master/detail.

## Purpose

Disclosure level 3: everything the user needs about the tmux proxy behind the active Session ([information-architecture.md](../../information-architecture.md)).

Must not:

- Become primary navigation (no Agent-grouped session browser as the point of this tool).
- Collapse the three domain dimensions into one badge.
- Treat Agent as an AI runtime (no thinking/stream chrome).

## Anatomy

Single detail surface:

```text
Agent

  identity          display name, id
  ConnectionStatus  three channels (Agent emphasized)
  connection        host, addresses, versions as available
  health            heartbeat / last seen (Agent connection evidence)
  actions           refresh, rename, copy — not “open dashboard of this Agent’s sessions”
```

A short **session count** on this Agent is acceptable as facts. A nested SessionList that **replaces** app-wide flat navigation is not. To open a Session, the user uses [SessionList](session-list.md).

### Open question (deferred)

[#470](https://github.com/BestNathan/nession/issues/470): whether AgentDetail **reuses** shipping `AgentDetailPanel` anatomy or **replaces** it is decided in the vertical slice ([#471](https://github.com/BestNathan/nession/issues/471)).

This spec constrains the **target**:

- Required: identity, ConnectionStatus (three channels), connection/network facts, Agent health evidence.
- Shipping extras (heartbeat timeline, copy-all, Claude Code extension slot, create-session) may be kept if they still make sense **session-scoped**. Create-session from AgentDetail is allowed as an action on this Agent; it must not require viewing an Agent-first dashboard first.
- Shipping `AgentDetailPanel` lists that Agent’s sessions as a block — acceptable as a **fact list**, not as the primary Session switcher.

## States

AgentDetail **foregrounds the Agent channel** and still shows Session + attachment for the **active** Session (the one whose Workspace this is).

| Channel | In this tool |
|---------|----------------|
| Agent | Full: all `agent.*` values, plus evidence (heartbeat, last error) |
| Session | The active Session’s `session.*` — context, not a list of statuses for every session on the host |
| Attachment | This client’s `attachment.*` to the active Session |

When Agent is `offline`, the page remains an Agent connectivity explanation. Do not retitle it as Session failure.

## Tokens

| Part | Tokens |
|------|--------|
| Page | Domain `workspace.surface` |
| Agent channel | Domain `agent.*` |
| Other channels | Domain `session.*` `attachment.*` via ConnectionStatus |
| Body text | Semantic `text.primary` / `text.secondary` |
| Actions | Experience `control.*` |

No Primitive `text-green-400` health pills (shipping predecessor `getHealthStatus`).

## Web vs App

| | Web | App |
|--|-----|-----|
| Layout | Single column / stacked sections in the Agent tool body | Same content; native stack page under Workspace |
| Close | Switch tool or SurfaceSwitcher back to Terminal | Pop to Workspace tool list, then dismiss Workspace to Terminal. Visible back control required |
| Density | Compact | App Experience spacing / safe area ([#473](https://github.com/BestNathan/nession/issues/473)) |

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and Workspace Agent tool layouts on canonical screens ([#566](https://github.com/BestNathan/nession/pull/566), [#568](https://github.com/BestNathan/nession/pull/568)).

### Dominance

- AgentDetail is **disclosure level 3** — more explicit than [AgentContext](agent-context.md), still inside auxiliary Workspace, never primary navigation.
- The Agent **identity block** and ConnectionStatus detail form may be primary **within this tool page** — not primary in the full app shell.

### Information hierarchy

- **Primary on page:** Agent identity + ConnectionStatus detail (three labeled channels).
- **Secondary:** connection facts (host, addresses, versions), health evidence.
- **Tertiary:** session count as fact; optional session fact list — not a Session switcher.

### Alignment

- Single-column stacked sections — no Files-style master/detail split.
- Labels left or top; values follow ConnectionStatus detail rhythm.

### Density

- **Forms/dialogs relaxed density** within sections — readable for diagnostic content.
- Compact on Web; App adds safe-area and touch spacing without inflating to marketing-page whitespace.

### Whitespace

- Section gaps group identity, status, connection, actions — whitespace before borders.
- No nested cards per field group unless whitespace fails for dense key-value grids.

### Contrast

- Agent channel foregrounded relative to Session/attachment on **this page** — still Domain tokens, not Primitive green pills.
- Healthy Agent: identity at `secondary`–`primary`; channels at readable secondary.
- Unhealthy Agent: Agent channel `conditional-prominent`; Session/attachment channels stay labeled and neutral.

### Surface treatment

- Flat `workspace.surface` page — no elevation, no hero banner.
- Actions row uses Experience `control.*` — ghost/secondary, not a wall of primary buttons.

### State-driven emphasis

| Condition | Emphasis |
|-----------|----------|
| Agent `online` | Agent channel quiet in detail form; full facts readable |
| Agent `offline` / `error` | Agent channel + health evidence `conditional-prominent`; page title remains Agent identity — not retitled "Session failed" |
| Session fact list | Tertiary — opening another Session routes to [SessionList](session-list.md), not this list as primary nav |

### Anti-patterns

- Agent-grouped session browser replacing flat SessionList.
- Single fused health badge for Agent + Session + attachment.
- Files-style browser+editor split on this tool.
- Primitive `text-green-400` health pills (shipping predecessor).
- "Open dashboard of this Agent's sessions" as the primary action.

### Canonical reference

- Web: `/#/fixture/workspace` — Agent tool body in Workspace ([#566](https://github.com/BestNathan/nession/pull/566)).
- App: `/#/fixture/app` — Agent tool in spatial Workspace stack ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Single detail layout (no Files-style browser+editor split).
- [ ] ConnectionStatus three channels are visible (detail form).
- [ ] Copy/health refers to Agent connection, not a fused Session status.
- [ ] Not the primary way to switch Sessions.
- [ ] #471 records reuse-vs-replace of `AgentDetailPanel` explicitly when implementing.
