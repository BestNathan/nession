# WorkspaceNavigation

Tool-level switching **inside** Workspace: Files \| Session \| Agent \| registered others. Not a second app sidebar.

## Purpose

Move between session-scoped tools without rewriting the Workspace shell and without a default permanent full-width inner sidebar ([workspace.md](../../workspace.md), [interaction/web.md](../../interaction/web.md)).

Must not:

- Duplicate [SurfaceSwitcher](surface-switcher.md) (that is Terminal vs Workspace).
- Force Files master/detail chrome onto Session or Agent tools.
- Hard-code a closed `switch (tab)` of tools as the only extension path.

## Anatomy

```text
Workspace
┌─ WorkspaceNavigation ─────────────────────────┐
│  Files    Session    Agent    [ + registered ]│  compact top (Web)
└───────────────────────────────────────────────┘
┌─ Tool body ───────────────────────────────────┐
│  FileWorkspace  XOR  Session details XOR      │
│  AgentDetail  XOR  future tool                │
└───────────────────────────────────────────────┘
```

| Part | Role |
|------|------|
| Tool list | Registered tools in `order`, filtered by `availability` |
| Active tool body | One tool at a time |
| Overflow | If tools do not fit, collapse into a compact menu — still not a full-height sidebar by default |

### Registry

Conceptual contract from the architecture (API is implementation-specific in #471):

```ts
interface WorkspaceTool {
  id: string
  label: string
  icon: unknown
  order: number
  availability: (context: SessionContext) => boolean
  component: unknown
}
```

**Extensibility:** a future tool (Git, Preview, Processes) **registers**. The shell renders whatever the registry returns. Do not add a new top-level pattern unless the tool needs a new composition (as Files needs [FileWorkspace](file-workspace.md)).

`availability === false`: omit the tool. Do not leave a disabled tab that implies the capability exists when the Agent has no file API (for example).

Hidden tools must not reserve empty chrome.

## States

| Nav state | Meaning |
|-----------|---------|
| Tool `id` selected | That tool’s body is shown |
| Tool unavailable | Absent from the nav |
| Zero tools | Should not happen for the initial set if Session+Agent always exist; if it does, show Workspace empty — not Terminal |

WorkspaceNavigation does not present Agent connection as a tab state. Unhealthy Agent may hide Files via `availability` while Session and Agent tools remain.

## Tokens

| Part | Tokens |
|------|--------|
| Nav strip | Domain `workspace.navigation`, Semantic `surface.*` |
| Selected tool | Semantic `accent` / `text.primary` |
| Unselected | Semantic `text.secondary` |
| Tool body | Domain `workspace.background` / `workspace.surface` |
| Size | Experience `control.*` — compact on Web |

## Web vs App

| | Web | App ([#473](https://github.com/BestNathan/nession/issues/473)) |
|--|-----|-----|
| Tool switching | Compact top tabs or equivalent horizontal control | **Native navigation stack** inside Workspace: list of tools → push tool. System back pops within Workspace, not out to Terminal, until the user uses the top-level Workspace dismiss |
| Inner sidebar | Not default | Not default. Files may split *inside* FileWorkspace after push |
| Gestures | N/A | Nested tool swipe must not fight `Sessions ← Terminal → Workspace`. Prefer vertical scroll and explicit back |

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and Web Workspace canonical screen ([#566](https://github.com/BestNathan/nession/pull/566)).

### Dominance

- WorkspaceNavigation is **tool chrome inside an auxiliary surface** — quieter than Terminal, quieter than [FileWorkspace](file-workspace.md) editor content when Files is active.
- Must not read as a second application shell or permanent full-height sidebar.

### Information hierarchy

- **Primary within Workspace:** the active tool's body (Files tree, Agent detail, Session facts).
- **Navigation strip:** `secondary` — tool labels at section-title scale, not page-title scale.
- Selected tool label is the loudest element in the strip — still below Workspace body hero content.

### Alignment

- Web: compact horizontal strip above tool body; left-aligned tool list.
- App: tool list at Workspace root of navigation stack — not duplicated as a Web tab strip on every pushed page.

### Density

- **Workspace tools density** — compact horizontal nav on Web ([visual-language.md](../../visual-language.md) §4).
- App: list rows at touch density when at stack root; pushed tool pages use [AppToolHeader](session-header.md) push chrome instead of persistent tabs.

### Whitespace

- Strip separated from tool body by whitespace or hairline — not a bordered card wrapping both.
- Unavailable tools omitted entirely — no empty tab slots reserving chrome.

### Contrast

- Selected tool: `primary` within nav strip.
- Unselected tools: `secondary`.
- No per-tool accent colors in the strip.

### Surface treatment

- Flat nav on `workspace.navigation` surface shift — Web canonical uses bottom floating tool bar + grid layouts ([#566](https://github.com/BestNathan/nession/pull/566)); top strip remains valid for tool switching semantics.
- No default permanent inner sidebar occupying full Workspace height.

### State-driven emphasis

| State | Emphasis |
|-------|----------|
| Tool selected | That tool's nav label `primary` in strip; body shows tool |
| Tool unavailable (`availability === false`) | Absent — no disabled ghost tab |
| Agent unhealthy | May hide Files via availability; Session/Agent tools remain — nav does not fuse Agent status into tab color |

### Anti-patterns

- Duplicating [SurfaceSwitcher](surface-switcher.md) (Terminal vs Workspace) as extra segments here.
- Full-width permanent sidebar for tool list.
- Files master/detail chrome applied to Session or Agent tools.
- Hard-coded closed tab enum as the only extension path.
- Tool strip louder than the active editor or terminal (when user returns to Terminal).

### Canonical reference

- Web: `/#/fixture` with Workspace surface + `/#/fixture/workspace` 1440×900 — floating tool bar and Files layout ([#566](https://github.com/BestNathan/nession/pull/566)).
- App: `/#/fixture/app` Workspace page — push navigation + `filesApp` layout ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Initial tools: Files, Session, Agent (Files may hide if unavailable).
- [ ] No default permanent full-width Workspace-level sidebar.
- [ ] File master/detail is not applied to Agent or Session tools.
- [ ] Spec/implementation path exists to add a tool by registration without editing a hardcoded tab enum as the only means.
- [ ] App: tool navigation is a stack; top-level spatial gestures still dismiss Workspace rather than the inner tool (unless the stack is at root).
