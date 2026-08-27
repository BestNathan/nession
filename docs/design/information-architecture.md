# Information Architecture

Session is the primary navigation object. Agent is secondary metadata with progressive disclosure. Terminal is the default surface inside an Active Session. Workspace is auxiliary.

```text
Nession
│
├── Sessions                         PRIMARY NAVIGATION
│
├── Active Session
│   │
│   ├── Agent Context               ALWAYS AVAILABLE, VISUALLY QUIET WHEN HEALTHY
│   │
│   └── Active Surface
│       │
│       ├── Terminal                DEFAULT / PRIMARY
│       │
│       └── Workspace               AUXILIARY
│           │
│           ├── Files
│           │   ├── File Browser
│           │   └── Editor
│           │
│           ├── Session
│           │   └── Details
│           │
│           ├── Agent
│           │   ├── Details
│           │   └── Connection
│           │
│           └── Future Tools
│               ├── Git
│               ├── Preview
│               ├── Processes
│               └── ...
│
└── Settings
```

## Session-first navigation

The primary application entry is the Session list. It borrows the **navigation familiarity** of IM clients without adopting an IM data model.

```text
IM navigation concept       Nession
------------------------------------------------
Conversation list       →   Session list
Conversation            →   Session
Chat view               →   Terminal surface
Conversation switching  →   Session switching
Details/attachments     →   Workspace
```

This mapping is conceptual only. It does not import chat semantics into Nession.

## Flat Session list

The Session list stays **flat by default**. Users must not be required to navigate Agent → Sessions, and the primary list must not be grouped by Agent by default.

Agent identity remains visible as secondary Session metadata because Session connectivity depends on it.

```text
Sessions

● Fix terminal reconnect
  Claude Code · devbox-01 · 2m

● Design system
  Codex · macbook · 12m

○ Production shell
  zsh · sg-prod · 1h
```

Each row is a Session. The second line is compact metadata (workload hint, Agent identity, recency) — not a navigation parent.

## Agent progressive disclosure

Agent information appears at three depths:

1. **Session list** — compact secondary metadata.
2. **Session header** — explicit connection context (`Agent Context` in the tree above).
3. **Workspace → Agent** — complete Agent and connection details.

When healthy, Agent state is visually quiet. When unhealthy, reconnecting, or offline, it becomes prominent because it affects Session reachability. Prominence is a presentation rule, not a reason to make Agent the navigation parent.

## What the IA does not include

The IA does **not** introduce Conversation, User Message, Agent Message, Tool Call, or other AI-chat concepts.

Nession may display a Claude / Codex TUI inside the terminal. The core client only needs to understand the remote Session and terminal I/O.

## Workspace in the IA

Workspace is a sibling of Terminal under Active Session, not a synonym for File Browser. Tool structure, registry, and the Files master/detail boundary are documented in [workspace.md](workspace.md).

How that IA is realized on each platform:

- Web: [interaction/web.md](interaction/web.md)
- App: [interaction/app.md](interaction/app.md)
