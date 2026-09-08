# Claude Code Workspace Tool Design

## Context

The session-first UI in `staging` exposes an App Dock Workspace with three
tools: Files, Session, and Agent. Claude Code configuration is currently
rendered as an extension section inside Agent detail, and project-scoped
configuration also has a separate `CC` tab in the terminal header. This splits
one capability across two surfaces and makes it unavailable as a first-class
Workspace tool.

## Goal

Make Claude Code a standalone Workspace tool under the App Dock:

`Workspace / Files / Session / Agent / Claude Code`

Move all Claude Code UI out of Agent detail and the terminal header while
preserving the existing read-only configuration browsing behavior.

## User experience

### Workspace navigation

The Workspace tool bar contains four tools in this order:

1. Files
2. Session
3. Agent
4. Claude Code

Claude Code uses the existing Workspace tool selection state and is available
when a session is selected. The tool remains visible when Claude Code is not
installed so users can see a clear unavailable state rather than a disappearing
navigation item.

The App layout uses the existing tool header and back affordance. The web
layout uses the same selected tool in the existing Workspace shell. Tool
controls remain keyboard reachable, preserve visual order, and keep visible
focus states.

### Claude Code content

The standalone tool is scoped by the selected session and its agent. It offers
two explicit scopes:

- **Global** — the selected agent's global `~/.claude` directory.
- **Project** — the selected session's project `.claude` directory.

Each scope reuses the current category/file model and the existing read API:
category list, file selection, content preview, file size, paginated loading,
loading state, read errors, and unavailable/not-installed state. Selecting a
file should load it in the main Workspace content area; it should not open a
secondary Agent sheet or terminal-header popup.

If there is no selected agent/session context, the tool renders no data view
and relies on the existing Workspace selection guard. If the global or project
scope is unavailable, the affected scope reports that state independently so a
working scope remains usable.

### Removed entry points

- Remove the Claude Code extension section from `AgentDetail`.
- Remove the legacy Claude Code tab from the terminal header.
- Keep the Claude Code capability and Rust extension unchanged; this is a UI
  composition change, not a protocol change.

## Architecture

Add a `claude-code` Workspace tool alongside `files`, `session`, and `agent`.
The tool receives the existing `WorkspaceContext`, including `session`,
`agent`, and the WebSocket-backed Claude Code capability. Its shared data/view
logic owns scope selection and file reads. Thin `web` and `app` layouts adapt
the shared view to the existing Workspace experiences and App back navigation.

The existing extension service/API and wire types remain the single source of
truth for requests and responses. The current `ConfigViewer` behavior should
be extracted or reused without duplicating request logic.

When the selected session or agent changes, all Claude Code scope/file state
must reset so content from a previous session cannot remain visible.

## Error handling

- Initial list requests show a loading state.
- A failed scope list request shows an inline retry affordance for that scope.
- An unavailable scope shows a concise not-installed/unavailable message.
- A failed file read shows an inline error and leaves scope/file navigation
  usable.
- A paginated read failure does not discard already loaded content.
- No error state should remove the Workspace tool from the App Dock.

## Testing

Add or update tests for:

- Workspace registry order, id, label, availability, and both layouts.
- Claude Code tool renders global/project scopes and forwards the correct
  `agent_id`, `session_id`, and scope to the capability API.
- Session/agent changes reset the selected file/content state.
- Loading, unavailable, retry, read error, and pagination behavior.
- Agent detail no longer renders Claude Code.
- Terminal header no longer renders the Claude Code tab.
- App Dock navigation can activate Claude Code and use the existing back
  affordance.

Run the existing focused Vitest tests plus TypeScript, ESLint, and production
build checks. Because this changes Web UI interaction, verify the feature in a
running local stack with Playwright and capture an App Dock/Claude Code
Workspace screenshot before handoff.

## Scope boundaries

This change does not add write operations to Claude Code configuration, change
Rust scanning/security rules, change WebSocket message formats, or alter the
Files/Session/Agent tools beyond removing the old Claude Code entry points.

## UI design note

The local UI/UX search found applicable guidance for keyboard-reachable tab
navigation and visible focus order. No project-specific Tailwind result was
available, so the implementation follows the existing shadcn/Tailwind tokens
and Workspace tool-bar patterns already present in the repository.
