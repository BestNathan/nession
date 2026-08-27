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

## Acceptance

- [ ] Single detail layout (no Files-style browser+editor split).
- [ ] ConnectionStatus three channels are visible (detail form).
- [ ] Copy/health refers to Agent connection, not a fused Session status.
- [ ] Not the primary way to switch Sessions.
- [ ] #471 records reuse-vs-replace of `AgentDetailPanel` explicitly when implementing.
